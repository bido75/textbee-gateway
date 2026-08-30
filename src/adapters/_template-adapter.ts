/**
 * TEMPLATE — copy this file to start a new CommunicationAdapter.
 *
 * Rename the class, fill in init()/sendMessage()/dial()/etc. for your real
 * provider, delete whichever optional methods your provider doesn't support
 * (voice-only providers skip sendMessage; messaging-only providers skip
 * dial/answer/hangup/etc.), then register the type string in
 * src/adapters/registry.ts. Nothing else in the codebase — the MCP server,
 * SessionManager, routing config — needs to change.
 *
 * See PROVIDER_SDK.md at the project root for the full walkthrough, and
 * examples/demo-textbee-adapter.mjs / examples/demo-asterisk-adapter.mjs for
 * two real adapters exercised end-to-end against protocol-accurate mocks.
 */
import { newId } from "../core/session-manager.js";
import {
  AdapterEvent,
  AdapterEventHandler,
  CallSession,
  ChannelKind,
  CommunicationAdapter,
  DialOptions,
  Endpoint,
  MessageRecord,
  SendMessageOptions,
} from "../core/types.js";

/** Whatever config your provider needs — API keys, base URLs, device ids, etc. */
export interface TemplateProviderConfig {
  apiKey: string;
  // ...add your provider's real config fields here
}

export class TemplateAdapter implements CommunicationAdapter {
  /** Unique id for THIS CONFIGURED INSTANCE (not the type) — comes from the constructor, set by the registry from config.providers[].id */
  readonly id: string;

  /**
   * Declare only what this provider can actually do. The router
   * (SessionManager.resolveProvider) uses this to decide which provider
   * handles a given channel; MCP tool calls will fail loudly with "Provider
   * does not support X()" if you claim a capability without implementing
   * the matching method — better than silently no-op'ing.
   */
  readonly capabilities: ChannelKind[] = ["sms"]; // e.g. ["voice"], ["sms", "mms"], ["chat"]

  private config!: TemplateProviderConfig;
  private handler: AdapterEventHandler | null = null;

  constructor(id = "template") {
    this.id = id;
  }

  /**
   * Called once at startup with this instance's `config:` block from the
   * YAML (after ${ENV_VAR} expansion). Validate required fields here and
   * throw with a clear message if something's missing — this fails fast at
   * boot instead of on the first real call.
   */
  async init(config: Record<string, unknown>): Promise<void> {
    const cfg = config as unknown as TemplateProviderConfig;
    if (!cfg.apiKey) {
      throw new Error(`TemplateAdapter "${this.id}" requires apiKey in config`);
    }
    this.config = cfg;

    // If your provider needs a persistent connection (a WebSocket, a
    // long-poll, a paired Bluetooth device, ...), start it here — see
    // AsteriskAriAdapter's connectEvents() or WhatsAppAdapter's connect()
    // for real examples of a provider that stays connected and reconnects
    // on failure.
  }

  /**
   * The SessionManager calls this once, right after init(), to receive a
   * single callback function. Call that function whenever something
   * happens on your provider's side that the AI agent should know about —
   * an inbound call ringing, an inbound SMS arriving, a DTMF digit, a call
   * ending. Store the handler; you'll invoke it from wherever your
   * provider's own event source lives (a webhook handler, a WebSocket
   * message listener, a poll loop).
   */
  onEvent(handler: AdapterEventHandler): void {
    this.handler = handler;
  }

  // ---------------------------------------------------------------------
  // MESSAGING — implement if "sms" | "mms" | "chat" is in your capabilities.
  // Delete this method entirely for a voice-only provider.
  // ---------------------------------------------------------------------
  async sendMessage(
    to: Endpoint,
    body: string,
    opts?: SendMessageOptions
  ): Promise<MessageRecord> {
    // TODO: replace with a real API call to your provider.
    // const res = await fetch(`${this.config.baseUrl}/send`, { ... });
    // if (!res.ok) throw new Error(`send failed: ${res.status}`);

    return {
      id: newId("msg"),
      provider: this.id,
      kind: "sms",
      direction: "outbound",
      from: opts?.from ?? { address: "template:self" },
      to,
      body,
      mediaUrls: opts?.mediaUrls,
      sentAt: new Date().toISOString(),
      status: "sent",
    };
  }

  /**
   * Call this from wherever your provider delivers inbound messages (a
   * webhook HTTP handler is the common case — see
   * gateways/textbee-webhook-server.ts for a real one, including HMAC
   * signature verification and retry de-duplication, both worth copying).
   */
  handleInboundMessage(payload: { from: string; body: string }): void {
    const event: AdapterEvent = {
      type: "message.incoming",
      message: {
        id: newId("msg"),
        provider: this.id,
        kind: "sms",
        direction: "inbound",
        from: { address: payload.from },
        to: { address: "template:self" },
        body: payload.body,
        sentAt: new Date().toISOString(),
        status: "received",
      },
    };
    this.handler?.(event);
  }

  // ---------------------------------------------------------------------
  // VOICE — implement if "voice" is in your capabilities. Delete these
  // methods entirely for a messaging-only provider. Only implement the
  // subset your provider actually supports (e.g. skip hold/mute/transfer/
  // sendDtmf/record if your provider can't do them — MCP calls to a method
  // you didn't implement fail with a clear "does not support" error rather
  // than silently doing nothing).
  // ---------------------------------------------------------------------
  async dial(to: Endpoint, opts?: DialOptions): Promise<CallSession> {
    // TODO: replace with a real call-origination request to your provider.
    return {
      id: newId("call"),
      provider: this.id,
      direction: "outbound",
      from: opts?.from ?? { address: "template:self" },
      to,
      state: "dialing",
      startedAt: new Date().toISOString(),
      mediaStreamUrl: opts?.attachMediaStreamUrl,
    };
  }

  async answer(_callId: string): Promise<void> {
    // TODO: real "answer" request to your provider.
  }

  async hangup(_callId: string): Promise<void> {
    // TODO: real "hangup" request to your provider.
  }

  // ---------------------------------------------------------------------
  // LIFECYCLE
  // ---------------------------------------------------------------------
  async shutdown(): Promise<void> {
    // Close any persistent connection opened in init().
  }
}
