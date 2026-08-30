#!/usr/bin/env node
/**
 * Demo: the REAL AsteriskAriAdapter (src/adapters/asterisk-ari-adapter.ts),
 * exercised end-to-end against a mock ARI server (examples/mock-asterisk-ari-server.mjs)
 * that implements just enough of Asterisk's REST Interface — channel
 * origination, answer, hangup, and a real WebSocket event stream — to drive
 * the actual adapter code, not the built-in stub adapter.
 *
 * This is the "SIP trunk" example: the same adapter class this repo uses
 * for real self-hosted PSTN voice via Kamailio/Asterisk (see docker/), here
 * proven against a protocol-accurate mock since a live Asterisk box isn't
 * available in this environment.
 *
 * Run from the project root: node examples/demo-asterisk-adapter.mjs
 * Prerequisite: `npm run build` (this demo runs the compiled dist/).
 */
import { spawn } from "child_process";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const MOCK_PORT = 4002;
const ARI_PASSWORD = "test-ari-password";

const configDir = mkdtempSync(join(tmpdir(), "ai-comms-gateway-demo-"));
const configPath = join(configDir, "config.yaml");
writeFileSync(
  configPath,
  `
providers:
  - id: asterisk-pbx
    type: asterisk-ari
    capabilities: [voice]
    config:
      baseUrl: "http://localhost:${MOCK_PORT}"
      username: "ai-gateway"
      password: "${ARI_PASSWORD}"
      appName: "ai-gateway"
      originateContext: "from-ai-agent"
      trunkEndpoint: "sip-trunk-1"
routing:
  - { channel: voice, match: "*", provider: asterisk-pbx }
persistence:
  type: memory
`
);

function runGateway() {
  const proc = spawn("node", ["dist/mcp/server.js"], {
    env: { ...process.env, GATEWAY_CONFIG_PATH: configPath },
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

console.log("Starting mock Asterisk ARI server (real REST + real WebSocket)...");
const mock = spawn("node", ["examples/mock-asterisk-ari-server.mjs"], { stdio: ["ignore", "pipe", "pipe"] });
mock.stdout.on("data", (d) => process.stdout.write(`  ${d}`));
mock.stderr.on("data", (d) => process.stderr.write(`  ${d}`));
await new Promise((r) => setTimeout(r, 500));

console.log("\nStarting the AI Communications Gateway (real AsteriskAriAdapter, not stub)...");
const gw = runGateway();
await gw.call(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "demo", version: "0" } });

console.log("\n1) make_call() -> real AsteriskAriAdapter -> real HTTP POST /ari/channels");
const dialResp = await gw.call(2, "tools/call", { name: "make_call", arguments: { to: "+15551234567" } });
console.log("   result:", dialResp.result.content[0].text);
if (dialResp.result.isError) {
  console.error("FAILED");
  process.exit(1);
}
const callId = dialResp.result.content[0].text.match(/call_id=(\S+),/)[1];

console.log("\n2) waiting for the mock's simulated Ring -> Up transitions over the real ARI WebSocket...");
await new Promise((r) => setTimeout(r, 900));
const listResp = await gw.call(3, "tools/call", { name: "list_calls", arguments: {} });
const call = JSON.parse(listResp.result.content[0].text).find((c) => c.id === callId);
console.log(`   call state after real WebSocket event flow: ${call.state} (expect "in-progress")`);

console.log("\n3) hangup_call() -> real HTTP DELETE /ari/channels/:id -> mock sends a real StasisEnd back over the WebSocket");
await gw.call(4, "tools/call", { name: "hangup_call", arguments: { call_id: callId } });
await new Promise((r) => setTimeout(r, 400));
const listResp2 = await gw.call(5, "tools/call", { name: "list_calls", arguments: {} });
const call2 = JSON.parse(listResp2.result.content[0].text).find((c) => c.id === callId);
console.log(`   final call state: ${call2.state} (expect "ended")`);

gw.proc.kill();
mock.kill();

const passed = call.state === "in-progress" && call2.state === "ended";
console.log(passed ? "\n✅ PASSED end-to-end with the real AsteriskAriAdapter." : "\n❌ FAILED");
process.exit(passed ? 0 : 1);
