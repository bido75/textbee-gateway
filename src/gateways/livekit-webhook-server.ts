import express from "express";
import type { Server as HttpServer } from "http";
import { WebhookReceiver } from "livekit-server-sdk";
import { SessionManager } from "../core/session-manager.js";
import { LiveKitAdapter } from "../adapters/livekit-adapter.js";

/**
 * Starts an HTTP server that receives LiveKit's webhook (room_started,
 * participant_joined, participant_left, room_finished, ...). LiveKit signs
 * these with your API key/secret; WebhookReceiver verifies that signature
 * so this endpoint can't be spoofed by an arbitrary POST.
 *
 * Configure this URL in your LiveKit server/project's webhook settings:
 *   https://your-domain/webhooks/livekit/<provider_id>
 */
export function startLiveKitWebhookServer(
  manager: SessionManager,
  port: number
): HttpServer {
  const app = express();
  // LiveKit's webhook body must be passed to the receiver as raw text (it
  // verifies a signature over the exact raw bytes), so don't use express.json() here.
  app.use(express.text({ type: "*/*" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.post("/webhooks/livekit/:providerId", async (req, res) => {
    const adapter = manager.getAdapter(req.params.providerId);
    if (!adapter || !(adapter instanceof LiveKitAdapter)) {
      return res.status(404).json({ error: `Unknown LiveKit provider "${req.params.providerId}"` });
    }

    try {
      const receiver = new WebhookReceiver(
        process.env.LIVEKIT_API_KEY ?? "",
        process.env.LIVEKIT_API_SECRET ?? ""
      );
      const authHeader = req.header("Authorization") ?? "";
      const event = await receiver.receive(req.body, authHeader);
      adapter.handleWebhookEvent(event as any);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: `Webhook verification failed: ${err?.message ?? err}` });
    }
  });

  const server = app.listen(port, () => {
    process.stderr.write(`[livekit-webhook] listening on :${port}\n`);
  });

  return server;
}
