/**
 * Core contract for the AI Communications Gateway.
 *
 * Every provider (Asterisk, Kamailio/SIP trunk, TextBee, WhatsApp, LiveKit, Twilio, ...)
 * implements the SAME interface below. The MCP server and any AI agent only ever
 * talk to this interface — never to a provider SDK directly. This is the
 * "database driver" pattern applied to telephony/messaging.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

import type { CellularEndpointConfig } from "../cellular/types.js";

export type ChannelKind = "voice" | "sms" | "mms" | "chat";

export type ProviderId = string; // e.g. "textbee", "sip-trunk-1", "asterisk-pbx", "stub"

export interface Endpoint {
  /** E.164 phone number, SIP URI, WhatsApp JID, Matrix ID, etc. */
  address: string;
  /** Human label if known ("Mom", "Support Line") */
  label?: string;
}

export type CallState =
  | "dialing"
  | "ringing"
  | "in-progress"
  | "on-hold"
  | "ended"
  | "failed";

export interface CallSession {
  id: string;
  provider: ProviderId;
  direction: "outbound" | "inbound";
  from: Endpoint;
  to: Endpoint;
  state: CallState;
  startedAt: string; // ISO timestamp
  endedAt?: string;
  /** ws:// or wss:// URL the Media Engine can pull/push PCM audio from/to for this call */
  mediaStreamUrl?: string;
}

export interface MessageRecord {
  id: string;
  provider: ProviderId;
  kind: "sms" | "mms" | "chat";
  direction: "outbound" | "inbound";
  from: Endpoint;
  to: Endpoint;
  body?: string;
  mediaUrls?: string[];
  sentAt: string;
  status: "queued" | "sent" | "delivered" | "failed" | "received";
}

// ---------------------------------------------------------------------------
// Events emitted by adapters (inbound calls, incoming SMS, DTMF, hangup, etc.)
// The Communication Core subscribes to these and turns them into MCP
// notifications / tool-callable state for the AI agent.
// ---------------------------------------------------------------------------

export type AdapterEvent =
  | { type: "call.incoming"; call: CallSession }
  | { type: "call.state_changed"; callId: string; state: CallState }
  | { type: "call.dtmf"; callId: string; digit: string }
  | { type: "call.ended"; callId: string; reason?: string }
  | { type: "message.incoming"; message: MessageRecord }
  | { type: "message.status"; messageId: string; status: MessageRecord["status"] };

export type AdapterEventHandler = (event: AdapterEvent) => void;

// ---------------------------------------------------------------------------
// The universal adapter interface
// ---------------------------------------------------------------------------

export interface DialOptions {
  from?: Endpoint;
  /** Attach this call's audio to a media stream URL as soon as it connects */
  attachMediaStreamUrl?: string;
}

export interface SendMessageOptions {
  from?: Endpoint;
  mediaUrls?: string[]; // presence of mediaUrls implies MMS where supported
}

export interface CommunicationAdapter {
  /** Unique id for this configured adapter instance, e.g. "textbee-home-phone" */
  readonly id: ProviderId;

  /** Which channel kinds this adapter can handle */
  readonly capabilities: ChannelKind[];

  /** Called once at startup with adapter-specific config (already validated) */
  init(config: Record<string, unknown>): Promise<void>;

  /** Register a handler for inbound events (calls, messages, dtmf, status) */
  onEvent(handler: AdapterEventHandler): void;

  /**
   * Optional: SessionManager calls this once at registration time with a
   * check-and-mark idempotency function backed by the shared persistence
   * store (see PersistenceStore.checkAndMarkSeen), for adapters whose
   * inbound transport can redeliver the same event (e.g. a webhook
   * provider retrying a failed delivery). Prefer this over an in-memory
   * Set: it survives restarts and is shared correctly across processes.
   */
  attachIdempotencyCheck?(check: (key: string) => Promise<boolean>): void;

  // --- Voice ---
  dial?(to: Endpoint, opts?: DialOptions): Promise<CallSession>;
  answer?(callId: string): Promise<void>;
  hangup?(callId: string): Promise<void>;
  hold?(callId: string, on: boolean): Promise<void>;
  mute?(callId: string, on: boolean): Promise<void>;
  transfer?(callId: string, to: Endpoint): Promise<void>;
  sendDtmf?(callId: string, digits: string): Promise<void>;
  record?(callId: string, on: boolean): Promise<void>;

  // --- Messaging ---
  sendMessage?(
    to: Endpoint,
    body: string,
    opts?: SendMessageOptions
  ): Promise<MessageRecord>;

  // --- Lifecycle ---
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Routing config: which provider handles which channel for which destination.
// This is what makes the whole thing swappable via YAML instead of code changes.
// ---------------------------------------------------------------------------

export interface RoutingRule {
  channel: ChannelKind;
  /** Optional destination prefix match, e.g. "+1" for US/Canada, "*" for default */
  match?: string;
  provider: ProviderId;
}

export interface GatewayConfig {
  runtimeMode: import("../cellular/types.js").RuntimeMode;
  providers: Array<{
    id: ProviderId;
    type: string; // "textbee" | "sip-trunk" | "asterisk" | "stub" | ...
    capabilities: ChannelKind[];
    config: Record<string, unknown>;
  }>;
  routing: RoutingRule[];
  persistence?: {
    type: "memory" | "postgres" | "redis" | "postgres+redis";
    config?: Record<string, unknown>;
  };
  /** CellularVoiceProvider instances (e.g. an Asterisk chan_mobile-backed device). Separate from `providers` since the interface differs. */
  cellularVoiceProviders?: Array<{
    id: ProviderId;
    type: string;
    config: Record<string, unknown>;
  }>;
  /** One entry per physical SIM/phone line — binds a messaging provider + voice provider under one phone number/identity. */
  cellularEndpoints?: CellularEndpointConfig[];
}
