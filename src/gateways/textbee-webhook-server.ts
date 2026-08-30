import express from "express";
import type { Server as HttpServer } from "http";
import { SessionManager } from "../core/session-manager.js";
import { TextBeeAdapter } from "../adapters/textbee-adapter.js";

/**
 * Starts a small HTTP server that receives the webhook TextBee's Android app
 * (or TextBee's cloud relay) calls whenever an SMS/MMS arrives on the phone.
 * Configure this URL (e.g. https://your-domain/webhooks/textbee/<provider_id>)
 * as a webhook in the TextBee dashboard, subscribed to `MESSAGE_RECEIVED`.
 *
 * Runs in the SAME process as the MCP server so both share one
 * SessionManager / one set of adapter instances — no cross-process state
 * syncing needed.
 *
 * Uses express.text() rather than express.json() deliberately: HMAC
 * signature verification must run over the exact raw bytes TextBee signed,
 * and re-serializing a parsed object (different key order, whitespace)
 * would produce a different digest and reject every legitimate request.
 */
export function startTextBeeWebhookServer(
  manager: SessionManager,
  port: number
): HttpServer {
  const app = express();
  app.use(express.text({ type: "*/*" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.post("/webhooks/textbee/:providerId", async (req, res) => {
    const adapter = manager.getAdapter(req.params.providerId);
    if (!adapter || !(adapter instanceof TextBeeAdapter)) {
      return res.status(404).json({ error: `Unknown TextBee provider "${req.params.providerId}"` });
    }

    const rawBody: string = typeof req.body === "string" ? req.body : "";
    const signature = req.header("x-signature");

    if (!adapter.verifyWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: "Invalid or missing X-Signature" });
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: "Body was not valid JSON" });
    }

    const { smsId, sender, message, receivedAt, deviceId, webhookEvent, mediaUrls } = payload ?? {};
    if (!sender || typeof message !== "string") {
      return res.status(400).json({ error: "Expected { sender, message } in webhook body" });
    }

    const result = await adapter.handleInboundWebhook({
      smsId,
      sender,
      message,
      receivedAt,
      deviceId,
      webhookEvent,
      mediaUrls,
    });

    // Always 200 even on a de-duplicated/ignored delivery — TextBee treats
    // anything but 2xx as a failure and will keep retrying, which is exactly
    // what produced the duplicate in the first place.
    res.json({ ok: true, ...result });
  });

  const server = app.listen(port, () => {
    process.stderr.write(`[textbee-webhook] listening on :${port}\n`);
  });

  return server;
}
