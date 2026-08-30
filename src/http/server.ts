#!/usr/bin/env node
import express, { NextFunction, Request, Response } from "express";
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { createGatewayRuntime } from "../runtime/gateway-runtime.js";
import { TextBeeAdapter } from "../adapters/textbee-adapter.js";
import { openApiDocument } from "./openapi.js";
import path from "path";
import { fileURLToPath } from "url";

export async function createHttpApp() {
  const runtime = await createGatewayRuntime();
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const id = req.header("x-request-id") ?? randomUUID();
    const started = Date.now();
    res.setHeader("x-request-id", id);
    res.on("finish", () => process.stderr.write(JSON.stringify({ level: "info", event: "http.request", requestId: id, method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - started }) + "\n"));
    next();
  });

  app.use((req, res, next) => {
    if (!isWebhookHost(req)) return next();
    if (req.path === "/") return res.json({ service: "ai-comms-provider-webhooks", status: "ok", acceptedPaths: ["/webhooks/textbee/:providerId"] });
    if (req.path === "/livez" || req.path === "/readyz" || req.path.startsWith("/webhooks/")) return next();
    return res.status(404).json({ error: { code: "not_found", message: "The webhook hostname only accepts provider webhook routes" } });
  });

  const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");
  app.use(express.static(publicDirectory, { index: false, maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));
  app.get("/", (_req, res) => res.sendFile(path.join(publicDirectory, "index.html")));

  app.get("/livez", (_req, res) => res.json({ status: "ok" }));
  app.get("/readyz", asyncHandler(async (_req, res) => {
    const readiness = await runtime.readiness();
    res.status(readiness.ready ? 200 : 503).json({ status: readiness.ready ? (readiness.degraded ? "degraded" : "ready") : "not_ready", mode: runtime.mode, components: readiness });
  }));

  app.post("/webhooks/textbee/:providerId", express.text({ type: "*/*", limit: "256kb" }), async (req, res) => {
    const adapter = runtime.manager.getAdapter(req.params.providerId);
    if (!(adapter instanceof TextBeeAdapter)) return res.status(404).json({ error: { code: "not_found", message: "Unknown TextBee provider" } });
    const raw = typeof req.body === "string" ? req.body : "";
    if (!adapter.verifyWebhookSignature(raw, req.header("x-signature"))) return res.status(401).json({ error: { code: "unauthorized", message: "Invalid webhook signature" } });
    try {
      const payload = JSON.parse(raw);
      const result = await adapter.handleInboundWebhook(payload);
      return res.json({ ok: true, ...result });
    } catch (error) { return sendError(res, error, 400); }
  });

  app.use(express.json({ limit: "256kb" }));
  app.get("/auth/session", (req, res) => res.json({ authenticated: isAuthenticated(req) }));
  app.post("/auth/session", (req, res) => {
    const supplied = typeof req.body?.apiKey === "string" ? req.body.apiKey : "";
    const expected = process.env.API_KEY ?? "";
    if (!expected || !safeEqual(supplied, expected)) return sendError(res, new Error("Invalid API key"), 401);
    const expiresAt = Date.now() + dashboardSessionTtlMs();
    const value = createDashboardSession(expiresAt, expected);
    res.setHeader("set-cookie", serializeSessionCookie(value, expiresAt, requestIsSecure(req)));
    return res.json({ authenticated: true, expiresAt: new Date(expiresAt).toISOString() });
  });
  app.delete("/auth/session", (req, res) => {
    res.setHeader("set-cookie", serializeSessionCookie("", 0, requestIsSecure(req)));
    res.status(204).end();
  });
  app.get("/openapi.json", (_req, res) => res.json(openApiDocument));
  app.use("/v1", authenticate);

  app.get("/v1/endpoints", asyncHandler(async (_req, res) => res.json({ data: runtime.application.listEndpoints() })));
  app.get("/v1/endpoints/:id", asyncHandler(async (req, res) => {
    const endpoint = runtime.application.getEndpoint(req.params.id);
    if (!endpoint) return sendError(res, new Error("Endpoint not found"), 404);
    res.json({ data: endpoint, status: await runtime.application.getEndpointStatus(req.params.id) });
  }));
  app.post("/v1/messages", asyncHandler(async (req, res) => {
    const body = objectBody(req.body); const mediaUrls = body.mediaUrls;
    if (mediaUrls !== undefined && (!Array.isArray(mediaUrls) || mediaUrls.some((v) => typeof v !== "string"))) throw new HttpError(422, "validation_error", "mediaUrls must be an array of URLs");
    res.status(201).json({ data: await runtime.application.sendMessage({ from: requiredString(body, "from"), to: requiredString(body, "to"), body: requiredString(body, "body"), mediaUrls: mediaUrls as string[] | undefined }) });
  }));
  app.get("/v1/calls", asyncHandler(async (req, res) => res.json({ data: await runtime.application.listCalls(positiveInt(req.query.limit, 100, 500)) })));
  app.post("/v1/calls", asyncHandler(async (req, res) => { const body = objectBody(req.body); res.status(201).json({ data: await runtime.application.makeCall({ from: requiredString(body, "from"), to: requiredString(body, "to") }) }); }));
  app.get("/v1/calls/:id", asyncHandler(async (req, res) => { const call = await runtime.application.getCall(req.params.id); if (!call) throw new HttpError(404, "not_found", "Call not found"); res.json({ data: call }); }));
  app.post("/v1/calls/:id/answer", asyncHandler(async (req, res) => res.json({ data: await runtime.application.answerCall(req.params.id) })));
  app.post("/v1/calls/:id/hangup", asyncHandler(async (req, res) => res.json({ data: await runtime.application.hangupCall(req.params.id) })));
  app.post("/v1/calls/:id/hold", asyncHandler(async (req, res) => { const body = objectBody(req.body); if (typeof body.hold !== "boolean") throw new HttpError(422, "validation_error", "hold must be a boolean"); await runtime.application.holdCall(req.params.id, body.hold); res.status(204).end(); }));
  app.post("/v1/calls/:id/dtmf", asyncHandler(async (req, res) => { const body = objectBody(req.body); await runtime.application.sendDtmf(req.params.id, requiredString(body, "digits")); res.status(204).end(); }));
  app.post("/v1/calls/:id/transfer", asyncHandler(async (req, res) => { const body = objectBody(req.body); await runtime.application.transferCall(req.params.id, requiredString(body, "to")); res.status(204).end(); }));
  app.post("/v1/calls/:id/voice-session", asyncHandler(async (req, res) => res.status(201).json({ data: await runtime.application.startVoiceSession(req.params.id, req.body) })));
  app.delete("/v1/calls/:id/voice-session", asyncHandler(async (req, res) => { await runtime.application.stopVoiceSession(req.params.id); res.status(204).end(); }));
  app.get("/v1/conversations", asyncHandler(async (req, res) => res.json({ data: await runtime.application.getConversation(queryString(req.query.endpointId, "endpointId"), queryString(req.query.counterpart, "counterpart"), positiveInt(req.query.limit, 50, 500)) })));

  if (runtime.mode === "MOCK") {
    app.post("/v1/dev/simulate/calls", asyncHandler(async (req, res) => { const body = objectBody(req.body); res.status(201).json({ data: await runtime.application.simulateIncomingCall(requiredString(body, "endpointId"), requiredString(body, "from")) }); }));
    app.post("/v1/dev/simulate/calls/:id/transcript", asyncHandler(async (req, res) => { const body = objectBody(req.body); const role = requiredString(body, "role"); if (role !== "user" && role !== "assistant") throw new HttpError(422, "validation_error", "role must be user or assistant"); await runtime.application.recordSimulatedTranscript(req.params.id, role, requiredString(body, "text")); res.status(204).end(); }));
  }
  app.use((_req, res) => sendError(res, new HttpError(404, "not_found", "Route not found"), 404));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => sendError(res, error, 400));
  return { app, runtime };
}

function authenticate(req: Request, res: Response, next: NextFunction) {
  if (!isAuthenticated(req)) return sendError(res, new Error("Invalid API key"), 401);
  next();
}
const DASHBOARD_SESSION_COOKIE = "gateway_session";
function isAuthenticated(req: Request): boolean {
  const expected = process.env.API_KEY;
  if (!expected) return false;
  const authorization = req.header("authorization") ?? "";
  if (authorization.startsWith("Bearer ") && safeEqual(authorization.slice(7), expected)) return true;
  const session = parseCookies(req.header("cookie") ?? "")[DASHBOARD_SESSION_COOKIE];
  if (!session) return false;
  const separator = session.indexOf(".");
  if (separator < 1) return false;
  const expiresAt = Number(session.slice(0, separator));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
  return safeEqual(session.slice(separator + 1), signDashboardSession(expiresAt, expected));
}
function createDashboardSession(expiresAt: number, secret: string): string { return `${expiresAt}.${signDashboardSession(expiresAt, secret)}`; }
function signDashboardSession(expiresAt: number, secret: string): string { return createHmac("sha256", secret).update(`dashboard-session:${expiresAt}`).digest("base64url"); }
function dashboardSessionTtlMs(): number {
  const configured = Number(process.env.DASHBOARD_SESSION_TTL_SECONDS ?? 28_800);
  return (Number.isFinite(configured) && configured >= 300 && configured <= 604_800 ? configured : 28_800) * 1000;
}
function requestIsSecure(req: Request): boolean { return req.secure || req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https"; }
function isWebhookHost(req: Request): boolean { return (req.header("x-forwarded-host") || req.hostname || req.header("host") || "").split(",")[0].trim().split(":")[0].toLowerCase() === "hooks-comms.giscop.com"; }
function serializeSessionCookie(value: string, expiresAt: number, secure: boolean): string {
  const parts = [`${DASHBOARD_SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", expiresAt > 0 ? `Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}` : "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => { const index = part.indexOf("="); return index < 0 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)]; }));
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>) { return (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next); }
class HttpError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
function objectBody(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(422, "validation_error", "JSON object body required"); return value as Record<string, unknown>; }
function requiredString(body: Record<string, unknown>, key: string): string { const value = body[key]; if (typeof value !== "string" || !value.trim()) throw new HttpError(422, "validation_error", `${key} is required`); return value.trim(); }
function queryString(value: unknown, key: string): string { if (typeof value !== "string" || !value.trim()) throw new HttpError(422, "validation_error", `${key} query parameter is required`); return value.trim(); }
function positiveInt(value: unknown, fallback: number, max: number): number { if (value === undefined) return fallback; const number = Number(value); if (!Number.isInteger(number) || number < 1 || number > max) throw new HttpError(422, "validation_error", `limit must be an integer from 1 to ${max}`); return number; }
function sendError(res: Response, error: unknown, fallbackStatus: number) {
  const known = error instanceof HttpError ? error : undefined;
  const message = error instanceof Error ? error.message : "Unknown error";
  const inferred = /Unknown call|not found/i.test(message) ? 404 : /does not support|already active/i.test(message) ? 409 : fallbackStatus;
  const status = known?.status ?? inferred;
  const code = known?.code ?? (status === 401 ? "unauthorized" : status === 404 ? "not_found" : status === 409 ? "conflict" : status >= 500 ? "internal_error" : "invalid_request");
  return res.status(status).json({ error: { code, message: status >= 500 ? "Internal server error" : message } });
}

if (process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts")) {
  const { app, runtime } = await createHttpApp();
  const server = app.listen(Number(process.env.HTTP_PORT ?? 8080), "0.0.0.0", () => process.stderr.write(`[http] listening on :${process.env.HTTP_PORT ?? 8080}\n`));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    const closeHttp = new Promise<void>((resolve) => server.close(() => resolve()));
    const cleanup = Promise.allSettled([closeHttp, runtime.shutdown()]);
    await Promise.race([cleanup, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown()); process.on("SIGTERM", () => void shutdown());
}
