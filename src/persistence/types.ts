import { CallSession, MessageRecord } from "../core/types.js";

export interface ConversationRecord {
  id: string;
  endpointId: string;
  counterpart: string;
  createdAt: string;
  updatedAt: string;
}

export type ConversationChannel = "sms" | "mms" | "chat" | "voice";
export type ConversationRole = "user" | "assistant";

export interface ConversationTurnRecord {
  id: string;
  conversationId: string;
  channel: ConversationChannel;
  role: ConversationRole;
  content: string;
  callId?: string;
  messageId?: string;
  provider: string;
  createdAt: string;
}

export interface NewConversationTurn {
  channel: ConversationChannel;
  role: ConversationRole;
  content: string;
  callId?: string;
  messageId?: string;
  provider: string;
  createdAt?: string;
}

/**
 * PersistenceStore is the same "swap the implementation, not the interface"
 * pattern as CommunicationAdapter — it just applies to storage instead of
 * telephony/messaging providers.
 *
 * - Durable methods (save/get/list) back call & message history so it
 *   survives a process restart. Postgres is the natural fit here.
 * - The event bus (publishEvent/subscribeEvents) lets more than one gateway
 *   process share live state — e.g. the MCP server process and a separate
 *   webhook process both see the same inbound events. Redis pub/sub is the
 *   natural fit here.
 *
 * A given implementation can satisfy both roles (Postgres + LISTEN/NOTIFY),
 * or you can compose two stores (Postgres for durability, Redis for the
 * event bus) — see PostgresRedisStore below.
 */
export interface PersistenceStore {
  init(): Promise<void>;
  /** Lightweight live dependency probe used by /readyz. */
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;

  saveCall(call: CallSession): Promise<void>;
  getCall(callId: string): Promise<CallSession | null>;
  listCalls(opts?: { limit?: number }): Promise<CallSession[]>;

  saveMessage(message: MessageRecord): Promise<void>;
  getMessage(messageId: string): Promise<MessageRecord | null>;
  listMessages(opts?: { limit?: number }): Promise<MessageRecord[]>;

  /** Publish an event for other processes sharing this store to see. */
  publishEvent(channel: string, payload: unknown): Promise<void>;
  /** Subscribe to events published by any process sharing this store. */
  subscribeEvents(channel: string, handler: (payload: unknown) => void): Promise<void>;

  /**
   * Generic idempotency check-and-mark, shared across processes via the
   * durable store (not an in-memory Set, which forgets on restart and
   * can't be shared between processes). Returns true the FIRST time a
   * given (namespace, key) pair is seen — e.g. for de-duplicating a
   * webhook provider's retried deliveries by their event id. Returns false
   * on every subsequent call with the same key.
   */
  checkAndMarkSeen(namespace: string, key: string, ttlSeconds?: number): Promise<boolean>;

  /**
   * The canonical cross-channel conversation timeline: one durable
   * `ConversationRecord` per (endpointId, counterpart) pair, with an
   * ordered log of `ConversationTurnRecord`s underneath it — SMS/MMS turns,
   * and (unlike the plain call/message records) VOICE TRANSCRIPT turns too.
   * This is what makes cross-channel AI context survive a restart, not
   * just live in ConversationService's process memory.
   */
  getOrCreateConversation(endpointId: string, counterpart: string): Promise<ConversationRecord>;
  appendConversationTurn(conversationId: string, turn: NewConversationTurn): Promise<ConversationTurnRecord>;
  listConversationTurns(conversationId: string, limit?: number): Promise<ConversationTurnRecord[]>;

  /**
   * Durable storage for CellularEndpoint configuration (id + arbitrary
   * config blob), so endpoints declared in YAML are also queryable/durable
   * across restarts — a deliberately generic (not CellularEndpointConfig-
   * typed) store method to avoid coupling the persistence layer to the
   * cellular domain model. This is a scoped-down first step toward the
   * fuller Agent/Contact/CommunicationIdentity schema described in the
   * project notes, not that schema itself.
   */
  saveEndpointConfig(id: string, config: Record<string, unknown>): Promise<void>;
  listEndpointConfigs(): Promise<Array<{ id: string; config: Record<string, unknown> }>>;

  shutdown(): Promise<void>;
}
