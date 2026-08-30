import { Redis } from "ioredis";
import { PersistenceStore, ConversationRecord, ConversationTurnRecord, NewConversationTurn } from "./types.js";
import { CallSession, MessageRecord } from "../core/types.js";
import { randomUUID } from "crypto";

export interface RedisStoreConfig {
  url: string; // e.g. redis://localhost:6379
  /** Key prefix so multiple deployments can share one Redis instance safely. */
  keyPrefix?: string;
}

/**
 * RedisStore — fast, cross-process pub/sub for live events (incoming calls,
 * incoming SMS, state changes) plus a simple key/value cache for the most
 * recent call/message state. Redis is NOT used here as the durable system
 * of record (Postgres is) — think of it as the nervous system, not the
 * filing cabinet: it's what lets a webhook-handling process and an
 * MCP-serving process, running separately, both react to the same event the
 * instant it happens.
 */
export class RedisStore implements PersistenceStore {
  private pub: Redis;
  private sub: Redis;
  private cache: Redis;
  private prefix: string;

  constructor(config: RedisStoreConfig) {
    this.pub = new Redis(config.url);
    this.sub = new Redis(config.url);
    this.cache = new Redis(config.url);
    this.prefix = config.keyPrefix ?? "ai-comms-gateway";
  }

  async init(): Promise<void> {
    await Promise.all([this.pub.ping(), this.sub.ping(), this.cache.ping()]);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try { await this.cache.ping(); return { ok: true, detail: "Redis reachable" }; }
    catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) }; }
  }

  async saveCall(call: CallSession): Promise<void> {
    await this.cache.set(`${this.prefix}:call:${call.id}`, JSON.stringify(call), "EX", 60 * 60 * 24);
  }

  async getCall(callId: string): Promise<CallSession | null> {
    const raw = await this.cache.get(`${this.prefix}:call:${callId}`);
    return raw ? JSON.parse(raw) : null;
  }

  async listCalls(): Promise<CallSession[]> {
    const keys = await this.cache.keys(`${this.prefix}:call:*`);
    if (keys.length === 0) return [];
    const values = await this.cache.mget(...keys);
    return values.filter((v): v is string => !!v).map((v: string) => JSON.parse(v));
  }

  async saveMessage(message: MessageRecord): Promise<void> {
    await this.cache.set(
      `${this.prefix}:message:${message.id}`,
      JSON.stringify(message),
      "EX",
      60 * 60 * 24
    );
  }

  async getMessage(messageId: string): Promise<MessageRecord | null> {
    const raw = await this.cache.get(`${this.prefix}:message:${messageId}`);
    return raw ? JSON.parse(raw) : null;
  }

  async listMessages(): Promise<MessageRecord[]> {
    const keys = await this.cache.keys(`${this.prefix}:message:*`);
    if (keys.length === 0) return [];
    const values = await this.cache.mget(...keys);
    return values.filter((v): v is string => !!v).map((v: string) => JSON.parse(v));
  }

  async publishEvent(channel: string, payload: unknown): Promise<void> {
    await this.pub.publish(`${this.prefix}:${channel}`, JSON.stringify(payload));
  }

  async subscribeEvents(channel: string, handler: (payload: unknown) => void): Promise<void> {
    const fullChannel = `${this.prefix}:${channel}`;
    await this.sub.subscribe(fullChannel);
    this.sub.on("message", (ch: string, message: string) => {
      if (ch !== fullChannel) return;
      try {
        handler(JSON.parse(message));
      } catch {
        handler(message);
      }
    });
  }

  /**
   * `SET key val NX EX ttl` is atomic: it only succeeds (returns "OK") the
   * first time, and fails (returns null) on every subsequent call until
   * the TTL expires — exactly the race-safe check-and-mark a webhook
   * retry de-dup needs, shared correctly across however many processes
   * point at this Redis instance.
   */
  async checkAndMarkSeen(namespace: string, key: string, ttlSeconds = 60 * 60 * 24): Promise<boolean> {
    const fullKey = `${this.prefix}:idempotency:${namespace}:${key}`;
    const result = await this.cache.set(fullKey, "1", "EX", ttlSeconds, "NX");
    return result === "OK";
  }

  /**
   * Redis implementation of the conversation timeline — used when
   * `persistence.type: redis` is configured standalone (not the
   * recommended `postgres+redis`, which delegates this to Postgres
   * instead; see composite-store.ts). A hash holds the conversation
   * record's fields; a list (RPUSH/LRANGE) holds its turns in order.
   */
  async getOrCreateConversation(endpointId: string, counterpart: string): Promise<ConversationRecord> {
    const indexKey = `${this.prefix}:conv-index:${endpointId}:${counterpart}`;
    let id = await this.cache.get(indexKey);
    if (id) {
      const raw = await this.cache.hgetall(`${this.prefix}:conv:${id}`);
      return { id, endpointId: raw.endpointId, counterpart: raw.counterpart, createdAt: raw.createdAt, updatedAt: raw.updatedAt };
    }

    id = randomUUID();
    const now = new Date().toISOString();
    const record: ConversationRecord = { id, endpointId, counterpart, createdAt: now, updatedAt: now };
    await this.cache.set(indexKey, id);
    await this.cache.hset(`${this.prefix}:conv:${id}`, record as unknown as Record<string, string>);
    return record;
  }

  async appendConversationTurn(conversationId: string, turn: NewConversationTurn): Promise<ConversationTurnRecord> {
    const record: ConversationTurnRecord = {
      id: randomUUID(),
      conversationId,
      createdAt: turn.createdAt ?? new Date().toISOString(),
      ...turn,
    };
    await this.cache.rpush(`${this.prefix}:conv-turns:${conversationId}`, JSON.stringify(record));
    await this.cache.hset(`${this.prefix}:conv:${conversationId}`, "updatedAt", record.createdAt);
    return record;
  }

  async listConversationTurns(conversationId: string, limit?: number): Promise<ConversationTurnRecord[]> {
    const key = `${this.prefix}:conv-turns:${conversationId}`;
    const raw = limit ? await this.cache.lrange(key, -limit, -1) : await this.cache.lrange(key, 0, -1);
    return raw.map((v: string) => JSON.parse(v));
  }

  async saveEndpointConfig(id: string, config: Record<string, unknown>): Promise<void> {
    await this.cache.hset(`${this.prefix}:endpoint-configs`, id, JSON.stringify(config));
  }

  async listEndpointConfigs(): Promise<Array<{ id: string; config: Record<string, unknown> }>> {
    const all = await this.cache.hgetall(`${this.prefix}:endpoint-configs`);
    return Object.entries(all).map(([id, raw]) => ({ id, config: JSON.parse(raw as string) }));
  }

  async shutdown(): Promise<void> {
    this.pub.disconnect();
    this.sub.disconnect();
    this.cache.disconnect();
  }
}
