import { SessionManager } from "../core/session-manager.js";
import { CallSession, MessageRecord } from "../core/types.js";
import { CellularEndpointRegistry } from "../cellular/endpoint-registry.js";
import { ConversationTurnRecord, PersistenceStore } from "../persistence/types.js";
import { normalizePhoneNumber } from "./phone-normalization.js";

export interface Conversation {
  endpointId: string;
  counterpart: string;
  turns: ConversationTurnRecord[];
}

/**
 * ConversationService resolves a conversation as (endpoint identity +
 * counterpart address), not as (provider + counterpart), and reads/writes
 * the CANONICAL DURABLE TIMELINE via PersistenceStore's conversation/turn
 * methods — not a computed merge over separate call/message tables plus an
 * in-memory transcript map. SMS turns, MMS turns, and voice transcript
 * turns all land in the same `conversation_turns` log, in the order they
 * actually happened, and all of it survives a process restart.
 *
 * Auto-recording: attachAutoRecording(manager) subscribes to the shared
 * event bus so INBOUND messages/calls are turned into conversation turns
 * automatically. OUTBOUND sends (send_message/make_call) are recorded
 * explicitly by the MCP tool handlers right after a successful send/dial —
 * see mcp/server.ts.
 */
export class ConversationService {
  // Tracks which (endpointId, counterpart) a live call belongs to, so a
  // transcript turn arriving later (keyed only by callId) knows which
  // conversation to append to without re-deriving it every time.
  private callConversationContext = new Map<string, { endpointId: string; counterpart: string }>();

  constructor(private store: PersistenceStore, private endpoints: CellularEndpointRegistry) {}

  /** Wires inbound message/call events into durable conversation turns automatically. */
  attachAutoRecording(manager: SessionManager): void {
    manager.onEvent((event) => {
      if (event.type === "message.incoming") {
        void this.recordMessageTurn(event.provider, event.message).catch((error) => process.stderr.write(`[conversation] message record failed: ${error}\n`));
      } else if (event.type === "call.incoming") {
        void this.recordCallTurn(event.provider, event.call, "incoming").catch((error) => process.stderr.write(`[conversation] call record failed: ${error}\n`));
      } else if (event.type === "call.ended") {
        const call = manager.getCall(event.callId);
        if (call) void this.recordCallTurn(call.provider, call, "ended").catch((error) => process.stderr.write(`[conversation] call end record failed: ${error}\n`));
      }
    });
  }

  /** Records an SMS/MMS/chat message as a conversation turn, if it belongs to a CellularEndpoint. Safe to call for every message, inbound or outbound. */
  async recordMessageTurn(providerId: string, message: MessageRecord): Promise<void> {
    const endpoint = this.endpoints.findEndpointByProvider(providerId);
    if (!endpoint) return; // not tied to any cellular endpoint — no canonical conversation to record to (yet)

    const counterpart = normalizePhoneNumber(message.direction === "outbound" ? message.to.address : message.from.address);
    const conversation = await this.store.getOrCreateConversation(endpoint.id, counterpart);

    await this.store.appendConversationTurn(conversation.id, {
      channel: message.kind,
      role: message.direction === "outbound" ? "assistant" : "user",
      content: message.body ?? "",
      messageId: message.id,
      provider: providerId,
      createdAt: message.sentAt,
    });
  }

  /**
   * Records a call as a conversation turn (start or end), if it belongs to
   * a CellularEndpoint, and remembers the (endpointId, counterpart) this
   * call belongs to for recordTranscriptTurn() to use later.
   */
  async recordCallTurn(providerId: string, call: CallSession, phase: "incoming" | "outbound" | "ended"): Promise<void> {
    const endpoint = this.endpoints.findEndpointByProvider(providerId);
    if (!endpoint) return;

    const counterpart = normalizePhoneNumber(call.direction === "outbound" ? call.to.address : call.from.address);
    this.callConversationContext.set(call.id, { endpointId: endpoint.id, counterpart });

    const conversation = await this.store.getOrCreateConversation(endpoint.id, counterpart);
    const content =
      phase === "ended"
        ? `Call ${call.direction} ended (${call.state})`
        : `Call ${call.direction} started`;

    await this.store.appendConversationTurn(conversation.id, {
      channel: "voice",
      role: call.direction === "outbound" ? "assistant" : "user",
      content,
      callId: call.id,
      provider: providerId,
      createdAt: phase === "ended" ? call.endedAt ?? new Date().toISOString() : call.startedAt,
    });
  }

  /**
   * Records one turn of a live call's spoken transcript. Called from a
   * RealtimeVoiceProvider's onTranscript callback (wired in
   * mcp/server.ts's start_voice_session). Requires recordCallTurn() to have
   * already run for this call (it always has by the time a voice session
   * can start, since a call must exist first) so the (endpoint, counterpart)
   * context is known.
   */
  async recordTranscriptTurn(callId: string, role: "user" | "assistant", text: string): Promise<void> {
    if (!text.trim()) return;
    const context = this.callConversationContext.get(callId);
    if (!context) return; // call isn't tied to a CellularEndpoint — nothing to record to

    const conversation = await this.store.getOrCreateConversation(context.endpointId, context.counterpart);
    await this.store.appendConversationTurn(conversation.id, {
      channel: "voice",
      role,
      content: text,
      callId,
      provider: "realtime-voice-model",
    });
  }

  async getConversation(endpointId: string, counterpartAddress: string, limit = 50): Promise<Conversation> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) throw new Error(`Unknown cellular endpoint "${endpointId}"`);

    const normalizedCounterpart = normalizePhoneNumber(counterpartAddress);
    const conversation = await this.store.getOrCreateConversation(endpointId, normalizedCounterpart);
    const turns = await this.store.listConversationTurns(conversation.id, limit);

    return { endpointId, counterpart: normalizedCounterpart, turns };
  }

  /**
   * Renders a conversation as plain-text lines suitable for handing to a
   * realtime voice model as prior context — the ContextBuilder step: load
   * prior SMS/transcript turns before starting the realtime AI session.
   */
  formatConversationAsContext(conversation: Conversation): string {
    if (conversation.turns.length === 0) return "";
    const lines = conversation.turns.map((t) => `[${t.createdAt}] ${t.channel} (${t.role}): ${t.content}`);
    return `Prior conversation history with this contact:\n${lines.join("\n")}`;
  }
}
