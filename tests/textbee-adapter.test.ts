import test from "node:test";
import assert from "node:assert/strict";
import { TextBeeAdapter } from "../src/adapters/textbee-adapter.js";
import { AdapterEvent } from "../src/core/types.js";

test("TextBee send keeps the provider batch id for delivery correlation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, { recipients: ["+13025550199"], message: "hello", deviceId: "device-1" });
    return new Response(JSON.stringify({ data: { success: true, smsBatchId: "batch-123" } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const adapter = new TextBeeAdapter("textbee-live");
    await adapter.init({ apiKey: "provider-key", deviceId: "device-1", baseUrl: "https://textbee.example/api/v1" });
    const record = await adapter.sendMessage({ address: "+13025550199" }, "hello");
    assert.equal(record.id, "batch-123");
    assert.equal(record.status, "queued");
  } finally { globalThis.fetch = originalFetch; }
});

test("TextBee delivery webhooks update the correlated gateway record", async () => {
  const adapter = new TextBeeAdapter("textbee-live");
  await adapter.init({ apiKey: "provider-key", deviceId: "device-1" });
  const events: AdapterEvent[] = [];
  adapter.onEvent((event) => events.push(event));

  const result = await adapter.handleInboundWebhook({
    smsId: "sms-1", smsBatchId: "batch-123", message: "hello", sender: "+13025550199",
    webhookEvent: "MESSAGE_DELIVERED", status: "delivered", idempotencyKey: "delivery-1",
  });

  assert.equal(result.ingested, true);
  assert.deepEqual(events, [{ type: "message.status", messageId: "batch-123", status: "delivered" }]);
});

test("TextBee adapter rejects MMS until the self-hosted API and Android payload support it", async () => {
  const adapter = new TextBeeAdapter("textbee-live");
  await adapter.init({ apiKey: "provider-key", deviceId: "device-1" });
  await assert.rejects(
    adapter.sendMessage({ address: "+13025550199" }, "photo", { mediaUrls: ["https://example.com/photo.jpg"] }),
    /does not support MMS/i,
  );
});
