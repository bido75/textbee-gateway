import { CallSession, MessageRecord } from "../core/types.js";
import { ConversationRecord, ConversationTurnRecord, NewConversationTurn, PersistenceStore } from "./types.js";
import { randomUUID } from "crypto";

/**
 * MemoryStore — no durability, no cross-process event sharing (subscribers
 * only see events published from within the same process). This is what
 * the gateway falls back to when no `persistence:` block is configured, so
 * the project still runs with zero external dependencies out of the box.
 */
export class MemoryStore implements PersistenceStore {
  private calls = new Map<string, CallSession>();
  private messages = new Map<string, MessageRecord>();
  private subscribers = new Map<string, Array<(payload: unknown) => void>>();

  async init(): Promise<void> {
    // nothing to do
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "in-memory store" };
  }

  async saveCall(call: CallSession): Promise<void> {
    this.calls.set(call.id, { ...call });
  }

  async getCall(callId: string): Promise<CallSession | null> {
    return this.calls.get(callId) ?? null;
  }

  async listCalls(opts?: { limit?: number }): Promise<CallSession[]> {
    const all = [...this.calls.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return opts?.limit ? all.slice(0, opts.limit) : all;
  }

  async saveMessage(message: MessageRecord): Promise<void> {
    this.messages.set(message.id, { ...message });
  }

  async getMessage(messageId: string): Promise<MessageRecord | null> {
    return this.messages.get(messageId) ?? null;
  }

  async listMessages(opts?: { limit?: number }): Promise<MessageRecord[]> {
    const all = [...this.messages.values()].sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    return opts?.limit ? all.slice(0, opts.limit) : all;
  }

  async publishEvent(channel: string, payload: unknown): Promise<void> {
    for (const handler of this.subscribers.get(channel) ?? []) handler(payload);
  }

  async subscribeEvents(channel: string, handler: (payload: unknown) => void): Promise<void> {
    const list = this.subscribers.get(channel) ?? [];
    list.push(handler);
    this.subscribers.set(channel, list);
  }

  private seenKeys = new Set<string>();

  async checkAndMarkSeen(namespace: string, key: string): Promise<boolean> {
    const fullKey = `${namespace}:${key}`;
    if (this.seenKeys.has(fullKey)) return false;
    this.seenKeys.add(fullKey);
    return true;
  }

  private conversations = new Map<string, ConversationRecord>(); // id -> record
  private conversationsByKey = new Map<string, string>(); // "endpointId:counterpart" -> id
  private turns = new Map<string, ConversationTurnRecord[]>(); // conversationId -> turns
  private endpointConfigs = new Map<string, Record<string, unknown>>();

  async getOrCreateConversation(endpointId: string, counterpart: string): Promise<ConversationRecord> {
    const key = `${endpointId}:${counterpart}`;
    const existingId = this.conversationsByKey.get(key);
    if (existingId) return this.conversations.get(existingId)!;

    const now = new Date().toISOString();
    const record: ConversationRecord = { id: randomUUID(), endpointId, counterpart, createdAt: now, updatedAt: now };
    this.conversations.set(record.id, record);
    this.conversationsByKey.set(key, record.id);
    return record;
  }

  async appendConversationTurn(conversationId: string, turn: NewConversationTurn): Promise<ConversationTurnRecord> {
    const record: ConversationTurnRecord = {
      id: randomUUID(),
      conversationId,
      createdAt: turn.createdAt ?? new Date().toISOString(),
      ...turn,
    };
    const list = this.turns.get(conversationId) ?? [];
    list.push(record);
    this.turns.set(conversationId, list);

    const conversation = this.conversations.get(conversationId);
    if (conversation) conversation.updatedAt = record.createdAt;

    return record;
  }

  async listConversationTurns(conversationId: string, limit?: number): Promise<ConversationTurnRecord[]> {
    const list = (this.turns.get(conversationId) ?? []).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return limit ? list.slice(-limit) : list;
  }

  async saveEndpointConfig(id: string, config: Record<string, unknown>): Promise<void> {
    this.endpointConfigs.set(id, config);
  }

  async listEndpointConfigs(): Promise<Array<{ id: string; config: Record<string, unknown> }>> {
    return [...this.endpointConfigs.entries()].map(([id, config]) => ({ id, config }));
  }

  async shutdown(): Promise<void> {
    this.calls.clear();
    this.messages.clear();
    this.subscribers.clear();
    this.seenKeys.clear();
    this.conversations.clear();
    this.conversationsByKey.clear();
    this.turns.clear();
    this.endpointConfigs.clear();
  }
}
