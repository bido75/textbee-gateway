import { readFileSync } from "fs";
import YAML from "yaml";
import { GatewayConfig } from "../core/types.js";

const MODES = new Set(["MOCK", "LIVE_SERVICES", "PHYSICAL_EDGE"]);
const DEMO_NUMBERS = new Set(["+13025550123", "+13025559876"]);

function expandEnvVars(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return v;
  });
}

function deepExpand(node: unknown): unknown {
  if (typeof node === "string") return expandEnvVars(node);
  if (Array.isArray(node)) return node.map(deepExpand);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = deepExpand(v);
    return out;
  }
  return node;
}

export function loadConfig(path: string): GatewayConfig {
  const raw = readFileSync(path, "utf-8");
  const parsed = YAML.parse(raw);
  const expanded = deepExpand(parsed) as GatewayConfig;

  if (!Array.isArray(expanded.providers) || !Array.isArray(expanded.routing)) {
    throw new Error(`Invalid config at ${path}: expected "providers" and "routing" arrays`);
  }
  if (!MODES.has(expanded.runtimeMode)) {
    throw new Error(`Invalid config at ${path}: runtimeMode must be MOCK, LIVE_SERVICES, or PHYSICAL_EDGE`);
  }
  const providerBindings = new Map<string, string>();
  for (const endpoint of expanded.cellularEndpoints ?? []) {
    if (!endpoint.id?.trim()) throw new Error(`Invalid config at ${path}: cellular endpoint id is required`);
    const compact = endpoint.phoneNumber?.replace(/[\s().-]/g, "");
    if (expanded.runtimeMode === "MOCK") {
      endpoint.lineNumberStatus = endpoint.lineNumberStatus ?? (compact ? "demo" : "unverified");
    } else {
      if (endpoint.lineNumberStatus === "demo" || (compact && DEMO_NUMBERS.has(compact))) {
        throw new Error(`CellularEndpoint "${endpoint.id}" cannot use a demo line number in ${expanded.runtimeMode}`);
      }
      endpoint.lineNumberStatus = compact ? (endpoint.lineNumberStatus ?? "configured") : "unverified";
    }
    for (const provider of [endpoint.messaging?.provider, endpoint.voice?.provider].filter(Boolean) as string[]) {
      const prior = providerBindings.get(provider);
      if (prior && prior !== endpoint.id) {
        throw new Error(`Provider "${provider}" cannot be bound to both CellularEndpoint "${prior}" and "${endpoint.id}"`);
      }
      providerBindings.set(provider, endpoint.id);
    }
  }
  return expanded;
}
