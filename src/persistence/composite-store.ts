import { PersistenceStore, ConversationRecord, ConversationTurnRecord, NewConversationTurn } from "./types.js";
import { CallSession, MessageRecord } from "../core/types.js";
import { PostgresStore } from "./postgres-store.js";
import { RedisStore } from "./redis-store.js";

/**
 * PostgresRedisStore — the recommended production setup: durable
 * call/message history in Postgres, fast cross-process pub/sub in Redis.
 * Delegates every method to whichever backend is actually good at it.
 */
export class PostgresRedisStore implements PersistenceStore {
  constructor(private postgres: PostgresStore, private redis: RedisStore) {}

  async init(): Promise<void> {
    await this.postgres.init();
    await this.redis.init();
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const [postgres, redis] = await Promise.all([this.postgres.healthCheck(), this.redis.healthCheck()]);
    return { ok: postgres.ok && redis.ok, detail: `postgres=${postgres.ok ? "ok" : postgres.detail}; redis=${redis.ok ? "ok" : redis.detail}` };
  }

  saveCall(call: CallSession): Promise<void> {
    return this.postgres.saveCall(call);
  }
  getCall(callId: string): Promise<CallSession | null> {
    return this.postgres.getCall(callId);
  }
  listCalls(opts?: { limit?: number }): Promise<CallSession[]> {
    return this.postgres.listCalls(opts);
  }

  saveMessage(message: MessageRecord): Promise<void> {
    return this.postgres.saveMessage(message);
  }
  getMessage(messageId: string): Promise<MessageRecord | null> {
    return this.postgres.getMessage(messageId);
  }
  listMessages(opts?: { limit?: number }): Promise<MessageRecord[]> {
    return this.postgres.listMessages(opts);
  }

  publishEvent(channel: string, payload: unknown): Promise<void> {
    return this.redis.publishEvent(channel, payload);
  }
  subscribeEvents(channel: string, handler: (payload: unknown) => void): Promise<void> {
    return this.redis.subscribeEvents(channel, handler);
  }

  /** Delegates to Redis: SET NX EX is the right primitive for ephemeral, low-latency dedup. */
  checkAndMarkSeen(namespace: string, key: string, ttlSeconds?: number): Promise<boolean> {
    return this.redis.checkAndMarkSeen(namespace, key, ttlSeconds);
  }

  /**
   * Delegates to Postgres, NOT Redis: the conversation timeline is the
   * canonical durable record (unlike webhook dedup, which is intentionally
   * ephemeral), so it belongs in the system-of-record store, matching
   * calls/messages.
   */
  getOrCreateConversation(endpointId: string, counterpart: string): Promise<ConversationRecord> {
    return this.postgres.getOrCreateConversation(endpointId, counterpart);
  }
  appendConversationTurn(conversationId: string, turn: NewConversationTurn): Promise<ConversationTurnRecord> {
    return this.postgres.appendConversationTurn(conversationId, turn);
  }
  listConversationTurns(conversationId: string, limit?: number): Promise<ConversationTurnRecord[]> {
    return this.postgres.listConversationTurns(conversationId, limit);
  }
  saveEndpointConfig(id: string, config: Record<string, unknown>): Promise<void> {
    return this.postgres.saveEndpointConfig(id, config);
  }
  listEndpointConfigs(): Promise<Array<{ id: string; config: Record<string, unknown> }>> {
    return this.postgres.listEndpointConfigs();
  }

  async shutdown(): Promise<void> {
    await this.postgres.shutdown();
    await this.redis.shutdown();
  }
}
