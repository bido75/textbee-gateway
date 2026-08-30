/**
 * Mock TextBee API server — implements just enough of TextBee's real HTTP
 * surface (https://textbee.dev/docs/api-reference) to exercise the actual
 * TextBeeAdapter class from src/adapters/textbee-adapter.ts: the current
 * `POST /api/v1/gateway/send-sms` endpoint, and a webhook delivery signed
 * with HMAC-SHA256 over the raw body (`X-Signature` header), including a
 * simulated duplicate delivery the way TextBee retries failed webhooks.
 *
 * Not a general-purpose TextBee test double — just enough surface for
 * examples/demo-textbee-adapter.mjs to prove the real adapter code works.
 */
import express from "express";
import { createHmac } from "crypto";

const app = express();
app.use(express.json());
const PORT = 4001;
const WEBHOOK_SECRET = process.env.MOCK_WEBHOOK_SECRET || "shh-its-a-secret";
const GATEWAY_WEBHOOK_URL = process.env.GATEWAY_WEBHOOK_URL;

// Mimics the real TextBee API: POST /api/v1/gateway/send-sms
app.post("/api/v1/gateway/send-sms", (req, res) => {
  const apiKey = req.header("x-api-key");
  if (!apiKey) {
    return res.status(401).json({ error: "missing x-api-key header" });
  }
  const { recipients, message, deviceId } = req.body;
  console.log(`[mock-textbee] send-sms: device=${deviceId} to=${recipients} msg="${message}"`);
  res.json({ success: true, data: { recipients, message, deviceId } });

  // Simulate the phone receiving an automatic reply a moment later, and
  // TextBee's cloud forwarding it to our gateway's webhook — signed exactly
  // the way the real service signs it.
  if (GATEWAY_WEBHOOK_URL) {
    setTimeout(async () => {
      const payload = {
        smsId: "mock-sms-" + Date.now(),
        sender: recipients[0],
        message: `auto-reply to: ${message}`,
        receivedAt: new Date().toISOString(),
        deviceId,
        webhookEvent: "MESSAGE_RECEIVED",
      };
      const rawBody = JSON.stringify(payload);
      const signature = createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
      const webhookRes = await fetch(GATEWAY_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-signature": signature },
        body: rawBody,
      });
      console.log(`[mock-textbee] delivered webhook -> gateway responded ${webhookRes.status}`);

      // Also fire a DUPLICATE delivery (TextBee retries on failure) to prove
      // the adapter's smsId de-dup actually works.
      setTimeout(async () => {
        const dupRes = await fetch(GATEWAY_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-signature": signature },
          body: rawBody,
        });
        console.log(`[mock-textbee] delivered DUPLICATE webhook -> gateway responded ${dupRes.status}`);
      }, 300);
    }, 300);
  }
});

app.listen(PORT, () => console.log(`[mock-textbee] listening on :${PORT}`));
