#!/usr/bin/env node
/**
 * Demo: the REAL TextBeeAdapter (src/adapters/textbee-adapter.ts), exercised
 * end-to-end against a mock server that speaks TextBee's actual API shape
 * (examples/mock-textbee-server.mjs) — not the built-in stub adapter.
 *
 * This proves the plugin/adapter pattern with a real implementation:
 *   1. send_message() -> the adapter's real HTTP POST to /gateway/send-sms
 *   2. the mock "carrier" delivers a signed webhook back
 *   3. the adapter verifies the HMAC-SHA256 signature and ingests it
 *   4. a forged signature is rejected with 401
 *   5. a duplicate delivery (TextBee retries on failure) is de-duplicated
 *
 * Run from the project root: node examples/demo-textbee-adapter.mjs
 * Prerequisite: `npm run build` (this demo runs the compiled dist/).
 */
import { spawn } from "child_process";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const WEBHOOK_PORT = 8790;
const MOCK_PORT = 4001;
const WEBHOOK_SECRET = "shh-its-a-secret";

const configDir = mkdtempSync(join(tmpdir(), "ai-comms-gateway-demo-"));
const configPath = join(configDir, "config.yaml");
writeFileSync(
  configPath,
  `
providers:
  - id: textbee-home-phone
    type: textbee
    capabilities: [sms, mms]
    config:
      apiKey: "demo-api-key"
      deviceId: "demo-device"
      baseUrl: "http://localhost:${MOCK_PORT}/api/v1"
      webhookSigningSecret: "${WEBHOOK_SECRET}"
routing:
  - { channel: sms, match: "*", provider: textbee-home-phone }
  - { channel: mms, match: "*", provider: textbee-home-phone }
persistence:
  type: memory
`
);

function runGateway() {
  const proc = spawn("node", ["dist/mcp/server.js"], {
    env: { ...process.env, GATEWAY_CONFIG_PATH: configPath, WEBHOOK_PORT: String(WEBHOOK_PORT) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.stderr.write(`  [gateway] ${d}`));
  let buf = "";
  const waiters = new Map();
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  function call(id, method, params) {
    return new Promise((resolve) => {
      waiters.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  return { proc, call };
}

console.log("Starting mock TextBee server (speaks the real API shape)...");
const mock = spawn("node", ["examples/mock-textbee-server.mjs"], {
  env: {
    ...process.env,
    GATEWAY_WEBHOOK_URL: `http://localhost:${WEBHOOK_PORT}/webhooks/textbee/textbee-home-phone`,
    MOCK_WEBHOOK_SECRET: WEBHOOK_SECRET,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
mock.stdout.on("data", (d) => process.stdout.write(`  ${d}`));
mock.stderr.on("data", (d) => process.stderr.write(`  ${d}`));
await new Promise((r) => setTimeout(r, 500));

console.log("\nStarting the AI Communications Gateway (real TextBeeAdapter, not stub)...");
const gw = runGateway();
await gw.call(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "demo", version: "0" } });

console.log("\n1) send_message() -> real TextBeeAdapter -> real HTTP POST /api/v1/gateway/send-sms");
const sendResp = await gw.call(2, "tools/call", {
  name: "send_message",
  arguments: { to: "+15550001234", body: "hello from the real adapter" },
});
console.log("   result:", sendResp.result.content[0].text);
if (sendResp.result.isError) {
  console.error("FAILED: send_message errored");
  process.exit(1);
}

console.log("\n2) waiting for the mock carrier to deliver a signed webhook (+ a duplicate retry)...");
await new Promise((r) => setTimeout(r, 1200));

const eventsResp = await gw.call(3, "tools/call", { name: "get_events", arguments: {} });
const events = JSON.parse(eventsResp.result.content[0].text);
const incoming = events.filter((e) => e.type === "message.incoming");
console.log(`   message.incoming events ingested: ${incoming.length} (expect exactly 1 — the duplicate must be rejected)`);
console.log(`   inbound body: "${incoming[0]?.message?.body}"`);

const messagesResp = await gw.call(4, "tools/call", { name: "list_messages", arguments: {} });
const messages = JSON.parse(messagesResp.result.content[0].text);
console.log(`   total messages tracked: ${messages.length} (1 outbound + 1 inbound)`);

console.log("\n3) sanity-checking signature verification directly against the running webhook endpoint...");
const forgedRes = await fetch(`http://localhost:${WEBHOOK_PORT}/webhooks/textbee/textbee-home-phone`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-signature": "totally-fake" },
  body: JSON.stringify({ smsId: "forged", sender: "+1000", message: "forged", webhookEvent: "MESSAGE_RECEIVED" }),
});
console.log(`   forged signature -> HTTP ${forgedRes.status} (expect 401)`);

gw.proc.kill();
mock.kill();

const passed = incoming.length === 1 && messages.length === 2 && forgedRes.status === 401;
console.log(passed ? "\n✅ PASSED end-to-end with the real TextBeeAdapter." : "\n❌ FAILED");
process.exit(passed ? 0 : 1);
