import { createHmac, timingSafeEqual } from "crypto";
import { newId } from "../core/session-manager.js";
import {
  AdapterEvent,
  AdapterEventHandler,
  ChannelKind,
  CommunicationAdapter,
  Endpoint,
  MessageRecord,
  SendMessageOptions,
} from "../core/types.js";

export interface TextBeeConfig {
  /** Your TextBee API key (from the TextBee dashboard) */
  apiKey: string;
  /** The device id of the Android phone running the TextBee app */
  deviceId: string;
  /** Defaults to TextBee's hosted API; point at a self-hosted instance if you run one */
  baseUrl?: string;
  /**
   * The signing secret shown in the TextBee dashboard when you create a
   * webhook. If set, inbound webhook deliveries are verified via HMAC-SHA256
   * over the raw request body against the `X-Signature` header before being
   * accepted — see `verifyWebhookSignature()` below. Strongly recommended
   * for anything internet-reachable; omit only for local development.
   */
  webhookSigningSecret?: string;
}

/**
 * TextBeeAdapter
 *
 * TextBee turns a spare Android phone (with a SIM + carrier plan) into an
 * SMS/MMS API gateway: https://textbee.dev (open-source:
 * https://github.com/textbee/textbee).
 *
 * OUTBOUND: HTTP POST to TextBee's gateway API, which relays the request to
 * the TextBee Android app over push, which sends the SMS via the phone's
 * carrier — so the effective cost is whatever your carrier already charges
 * for texting (often $0, if you have unlimited SMS).
 *
 * Endpoint verified against TextBee's current documentation and open-source
 * repo (2026): `POST /api/v1/gateway/send-sms` with `deviceId` in the
 * request body, NOT the older path-based `/gateway/devices/{deviceId}/send-sms`
 * (still accepted by TextBee for backward compatibility, but documented as
 * deprecated — this adapter uses the current endpoint).
 *
 * INBOUND: the TextBee Android app (or TextBee's cloud relay) forwards
 * incoming SMS/MMS to a webhook URL you configure in the dashboard, signed
 * with HMAC-SHA256 over the raw body in the `X-Signature` header. That
 * webhook is handled by `gateways/textbee-webhook-server.ts`, which
 * verifies the signature and calls `handleInboundWebhook()` below to turn
 * it into a normal AdapterEvent. TextBee also retries failed webhook
 * deliveries, so `handleInboundWebhook()` de-duplicates by `smsId`.
 */
export class TextBeeAdapter implements CommunicationAdapter {
  readonly id: string;
  readonly capabilities: ChannelKind[] = ["sms", "mms"];

  private config!: TextBeeConfig;
  private handler: AdapterEventHandler | null = null;
  // Falls back to an in-memory de-dup if no idempotency store is attached
  // (e.g. running this adapter standalone in a test/demo without a
  // SessionManager). SessionManager.registerAdapter() normally attaches a
  // durable, cross-process check via attachIdempotencyCheck() below —
  // prefer that in any real deployment; the in-memory fallback forgets on
  // restart and isn't shared across processes.
  private idempotencyCheck: ((key: string) => Promise<boolean>) | null = null;
  private seenSmsIdsFallback = new Set<string>();
  private static readonly SEEN_IDS_CAP = 2000;

  constructor(id = "textbee") {
    this.id = id;
  }

  async init(config: Record<string, unknown>): Promise<void> {
    const cfg = config as unknown as TextBeeConfig;
    if (!cfg.apiKey || !cfg.deviceId) {
      throw new Error(`TextBeeAdapter "${this.id}" requires apiKey and deviceId in config`);
    }
    this.config = {
      baseUrl: "https://api.textbee.dev/api/v1",
      ...cfg,
    };
  }

  onEvent(handler: AdapterEventHandler): void {
    this.handler = handler;
  }

  attachIdempotencyCheck(check: (key: string) => Promise<boolean>): void {
    this.idempotencyCheck = check;
  }

  private async checkAndMarkSeen(smsId: string): Promise<boolean> {
    if (this.idempotencyCheck) {
      return this.idempotencyCheck(`textbee:${this.id}:${smsId}`);
    }
    // In-memory fallback — see the field's doc comment above.
    if (this.seenSmsIdsFallback.has(smsId)) return false;
    this.seenSmsIdsFallback.add(smsId);
    if (this.seenSmsIdsFallback.size > TextBeeAdapter.SEEN_IDS_CAP) {
      const oldest = this.seenSmsIdsFallback.values().next().value;
      if (oldest !== undefined) this.seenSmsIdsFallback.delete(oldest);
    }
    return true;
  }

  async sendMessage(
    to: Endpoint,
    body: string,
    opts?: SendMessageOptions
  ): Promise<MessageRecord> {
    if (opts?.mediaUrls?.length) {
      throw new Error("Self-hosted TextBee does not support MMS attachments yet");
    }
    const url = `${this.config.baseUrl}/gateway/send-sms`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
      },
      body: JSON.stringify({
        recipients: [to.address],
        message: body,
        deviceId: this.config.deviceId,
        // TextBee supports MMS attachments on supported devices/plans;
        // pass media URLs through if provided.
        ...(opts?.mediaUrls?.length ? { mediaUrls: opts.mediaUrls } : {}),
      }),
    });

    const responseBody = await res.text().catch(() => "");
    let response: { data?: { smsBatchId?: string } } = {};
    if (responseBody) {
      try { response = JSON.parse(responseBody); } catch { /* error body is reported below */ }
    }

    const record: MessageRecord = {
      // TextBee emits delivery webhooks with smsBatchId. Each adapter call
      // sends to one recipient, so using that durable provider id lets later
      // MESSAGE_* events update this exact gateway record.
      id: response.data?.smsBatchId ?? newId("msg"),
      provider: this.id,
      kind: opts?.mediaUrls?.length ? "mms" : "sms",
      direction: "outbound",
      from: opts?.from ?? { address: `textbee:${this.config.deviceId}` },
      to,
      body,
      mediaUrls: opts?.mediaUrls,
      sentAt: new Date().toISOString(),
      status: res.ok ? "queued" : "failed",
    };

    if (!res.ok) {
      throw new Error(`TextBee send-sms failed (${res.status}): ${responseBody}`);
    }

    return record;
  }

  /**
   * Verifies a webhook delivery's `X-Signature` header: HMAC-SHA256 over the
   * *raw* request body bytes (not a re-serialized object — key order/
   * whitespace differences would break the digest), using the signing
   * secret from your TextBee dashboard's webhook settings.
   *
   * Returns true if `webhookSigningSecret` isn't configured (so local
   * development without a secret still works) — the webhook server logs a
   * warning in that case. Uses a timing-safe comparison to avoid leaking
   * the expected signature via response-time side channels.
   */
  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
    if (!this.config.webhookSigningSecret) return true;
    if (!signatureHeader) return false;

    const expected = createHmac("sha256", this.config.webhookSigningSecret).update(rawBody).digest("hex");
    const expectedBuf = Buffer.from(expected, "utf8");
    const actualBuf = Buffer.from(signatureHeader, "utf8");
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  }

  /**
   * Call this from the webhook HTTP handler once the signature (if
   * configured) has been verified. Payload shape matches TextBee's current
   * documented `MESSAGE_RECEIVED` webhook event:
   *   { smsId, sender, message, receivedAt, deviceId, webhookEvent, ... }
   * `smsId` is used to de-duplicate retried deliveries — TextBee retries
   * failed webhook attempts, so the same event can arrive more than once.
   * De-duplication is checked against the shared persistence store when
   * attached (see attachIdempotencyCheck), so it survives restarts and is
   * correct across multiple gateway processes.
   */
  async handleInboundWebhook(payload: {
    smsId?: string;
    sender?: string;
    message?: string;
    receivedAt?: string;
    deviceId?: string;
    webhookEvent?: string;
    mediaUrls?: string[];
    smsBatchId?: string;
    status?: string;
    idempotencyKey?: string;
  }): Promise<{ ingested: boolean; reason?: string }> {
    if (payload.webhookEvent && payload.webhookEvent !== "MESSAGE_RECEIVED") {
      const status = this.mapDeliveryStatus(payload.webhookEvent, payload.status);
      const messageId = payload.smsBatchId ?? payload.smsId;
      if (!status || !messageId) {
        return { ingested: false, reason: `ignored event type "${payload.webhookEvent}"` };
      }
      const dedupeId = payload.idempotencyKey ?? `${payload.webhookEvent}:${payload.smsId ?? messageId}`;
      const firstTime = await this.checkAndMarkSeen(dedupeId);
      if (!firstTime) return { ingested: false, reason: "duplicate delivery status" };
      this.handler?.({ type: "message.status", messageId, status });
      return { ingested: true };
    }

    if (payload.smsId) {
      const firstTime = await this.checkAndMarkSeen(payload.smsId);
      if (!firstTime) {
        return { ingested: false, reason: "duplicate delivery (already processed this smsId)" };
      }
    }

    if (!payload.sender || typeof payload.message !== "string") {
      return { ingested: false, reason: "MESSAGE_RECEIVED requires sender and message" };
    }

    const event: AdapterEvent = {
      type: "message.incoming",
      message: {
        id: newId("msg"),
        provider: this.id,
        kind: payload.mediaUrls?.length ? "mms" : "sms",
        direction: "inbound",
        from: { address: payload.sender },
        to: { address: `textbee:${payload.deviceId ?? this.config.deviceId}` },
        body: payload.message,
        mediaUrls: payload.mediaUrls,
        sentAt: payload.receivedAt ?? new Date().toISOString(),
        status: "received",
      },
    };
    this.handler?.(event);
    return { ingested: true };
  }

  private mapDeliveryStatus(event: string, providerStatus?: string): MessageRecord["status"] | undefined {
    if (event === "MESSAGE_DELIVERED" || providerStatus === "delivered") return "delivered";
    if (event === "MESSAGE_FAILED" || providerStatus === "failed") return "failed";
    if (event === "MESSAGE_SENT" || providerStatus === "sent" || providerStatus === "dispatched") return "sent";
    return undefined;
  }

  async shutdown(): Promise<void> {
    // no persistent connection to close
  }
}
