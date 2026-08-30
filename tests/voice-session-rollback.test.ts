import test from "node:test";
import assert from "node:assert/strict";
import { CommunicationApplicationService } from "../src/application/communication-application-service.js";

test("voice-session startup rolls media back when ARI bridge creation fails", async () => {
  let stopped = false;
  const call = { id: "call-1", provider: "voice", direction: "inbound", from: { address: "+13025559876" }, to: { address: "+13025550123" }, state: "ringing", startedAt: new Date().toISOString() };
  const voiceProvider = { async startMediaBridge() { throw new Error("bridge failed"); }, async stopMediaBridge() {} };
  const service = new CommunicationApplicationService(
    { getCallDurable: async () => call, getAdapter: () => undefined } as any,
    { getVoiceProviderById: () => voiceProvider, findEndpointByProvider: () => undefined } as any,
    { recordCallTurn: async () => {}, recordTranscriptTurn: async () => {} } as any,
    { startSession: async () => ({ host: "127.0.0.1", port: 40000 }), stopSession: async () => { stopped = true; }, shutdown: async () => {} } as any,
    "stub",
  );
  await assert.rejects(() => service.startVoiceSession("call-1"), /bridge failed/);
  assert.equal(stopped, true);
});
