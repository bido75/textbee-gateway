import test from "node:test";
import assert from "node:assert/strict";
import { createGatewayRuntime } from "../src/runtime/gateway-runtime.js";

test("one endpoint writes SMS, call, and transcript to one durable timeline", async () => {
  const runtime = await createGatewayRuntime("./src/config/config.test.yaml");
  try {
    await runtime.application.sendMessage({ from: "android-test-01", to: "302-555-9876", body: "My code is 7421" });
    const call = await runtime.application.makeCall({ from: "android-test-01", to: "+13025559876" });
    await runtime.application.recordSimulatedTranscript(call.id, "user", "What code did I give you?");
    await runtime.application.recordSimulatedTranscript(call.id, "assistant", "7421");
    const conversation = await runtime.application.getConversation("android-test-01", "13025559876");
    assert.deepEqual(conversation.turns.map(t => t.channel), ["sms", "voice", "voice", "voice"]);
    assert.match(conversation.turns.map(t => t.content).join(" "), /7421/);
  } finally { await runtime.shutdown(); }
});

test("simulated inbound calls are explicitly identified by endpoint status", async () => {
  const runtime = await createGatewayRuntime("./src/config/config.test.yaml");
  try {
    const call = await runtime.application.simulateIncomingCall("android-test-01", "3025559876");
    assert.equal(call.direction, "inbound");
    assert.equal(call.from.address, "+13025559876");
    const status = await runtime.application.getEndpointStatus("android-test-01");
    assert.match(status.voice.detail, /SIMULATED/);
  } finally { await runtime.shutdown(); }
});
