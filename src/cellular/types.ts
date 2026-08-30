import { AdapterEvent, AdapterEventHandler, CallSession, ProviderId } from "../core/types.js";

/**
 * A CellularEndpoint is the real domain object for "one Android + one SIM":
 * a single phone number/identity that happens to be reachable over two
 * different channels (SMS/MMS via a messaging CommunicationAdapter, voice
 * via a CellularVoiceProvider). Nothing above this layer — MCP tools,
 * conversation history, routing — should ever address "TextBee" or
 * "chan_mobile" directly; they address the endpoint, and the endpoint knows
 * which providers back it.
 */
export interface CellularEndpointConfig {
  id: string;
  /** Mutable SIM/line metadata. The durable identity is `id`, never this value. */
  phoneNumber?: string;
  lineNumberStatus?: "demo" | "configured" | "verified" | "unverified";
  capabilities: Array<"sms" | "mms" | "voice">;
  /** Which registered messaging CommunicationAdapter (e.g. TextBee) handles SMS/MMS for this endpoint. */
  messaging?: { provider: ProviderId };
  /** Which registered CellularVoiceProvider handles voice for this endpoint. */
  voice?: { provider: ProviderId };
}

export type RuntimeMode = "MOCK" | "LIVE_SERVICES" | "PHYSICAL_EDGE";

/**
 * What an individual CellularVoiceProvider reports about ITS side only
 * (voice). Messaging status is a separate concern — see EndpointStatus in
 * cellular/endpoint-registry.ts, which combines this with the messaging
 * provider's status into the full picture for one CellularEndpoint.
 */
export interface VoiceProviderStatus {
  available: boolean;
  detail?: string;
}

/**
 * CellularVoiceProvider — the generic interface for "make this SIM's voice
 * line answer/originate calls", independent of the underlying mechanism.
 *
 * Deliberately narrower than CommunicationAdapter: no sendMessage (SMS/MMS
 * always goes through a messaging adapter like TextBee, never through the
 * voice provider — see AsteriskChanMobileProvider's doc comment for why),
 * no generic "capabilities" array (a CellularVoiceProvider is voice, full
 * stop). Implementations: AsteriskChanMobileProvider (Bluetooth HFP,
 * reference prototype), and — not yet built — an Android-native SIP
 * gateway provider and hardware cellular-gateway providers. Swapping any of
 * these in should never require a change above this interface.
 */
export interface CellularVoiceProvider {
  readonly id: ProviderId;

  init(config: Record<string, unknown>): Promise<void>;
  onEvent(handler: AdapterEventHandler): void;

  dial(endpoint: CellularEndpointConfig, destination: string): Promise<CallSession>;
  answer(callId: string): Promise<void>;
  hangup(callId: string): Promise<void>;

  getStatus(endpoint: CellularEndpointConfig): Promise<VoiceProviderStatus>;

  shutdown(): Promise<void>;
}

export type { AdapterEvent };
