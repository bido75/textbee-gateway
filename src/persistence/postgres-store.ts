import pg from "pg";
import { randomUUID } from "crypto";
import { CallSession, MessageRecord } from "../core/types.js";
import { ConversationRecord, ConversationTurnRecord, NewConversationTurn, PersistenceStore } from "./types.js";

const { Pool } = pg;

export interface PostgresStoreConfig {
  connectionString: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  direction TEXT NOT NULL,
  from_address TEXT NOT NULL,
  from_label TEXT,
  to_address TEXT NOT NULL,
  to_label TEXT,
  state TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  media_stream_url TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  direction TEXT NOT NULL,
  from_address TEXT NOT NULL,
  from_label TEXT,
  to_address TEXT NOT NULL,
  to_label TEXT,
  body TEXT,
  media_urls JSONB,
  sent_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calls_started_at ON calls (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages (sent_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, key)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  counterpart TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, counterpart)
);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  call_id TEXT,
  message_id TEXT,
  provider TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_turns_conv_created ON conversation_turns (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS endpoint_configs (
  id TEXT PRIMARY KEY,
  config JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/**
 * PostgresStore — durable call/message history. This alone does NOT provide
 * a cross-process event bus (Postgres LISTEN/NOTIFY payloads are capped at
 * 8000 bytes and not designed for high-throughput fan-out); pair it with
 * RedisStore for that, via PostgresRedisStore below, in any real deployment.
 */
export class PostgresStore implements PersistenceStore {
  private pool: pg.Pool;
  private subscribers = new Map<string, Array<(payload: unknown) => void>>();

  constructor(config: PostgresStoreConfig) {
    this.pool = new Pool({ connectionString: config.connectionString });
  }

  async init(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const applied = await this.pool.query(`SELECT version FROM schema_migrations WHERE version = 1`);
    if (applied.rowCount === 0) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(SCHEMA_SQL);
        await client.query(`INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING`);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try { await this.pool.query("SELECT 1"); return { ok: true, detail: "PostgreSQL reachable" }; }
    catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) }; }
  }

  async saveCall(call: CallSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO calls (id, provider, direction, from_address, from_label, to_address, to_label,
                           state, started_at, ended_at, media_stream_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         state = EXCLUDED.state,
         ended_at = EXCLUDED.ended_at,
         media_stream_url = EXCLUDED.media_stream_url`,
      [
        call.id,
        call.provider,
        call.direction,
        call.from.address,
        call.from.label ?? null,
        call.to.address,
        call.to.label ?? null,
        call.state,
        call.startedAt,
        call.endedAt ?? null,
        call.mediaStreamUrl ?? null,
      ]
    );
  }

  async getCall(callId: string): Promise<CallSession | null> {
    const res = await this.pool.query(`SELECT * FROM calls WHERE id = $1`, [callId]);
    if (res.rows.length === 0) return null;
    return rowToCall(res.rows[0]);
  }

  async listCalls(opts?: { limit?: number }): Promise<CallSession[]> {
    const res = await this.pool.query(
      `SELECT * FROM calls ORDER BY started_at DESC LIMIT $1`,
      [opts?.limit ?? 200]
    );
    return res.rows.map(rowToCall);
  }

  async saveMessage(message: MessageRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO messages (id, provider, kind, direction, from_address, from_label,
                              to_address, to_label, body, media_urls, sent_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
      [
        message.id,
        message.provider,
        message.kind,
        message.direction,
        message.from.address,
        message.from.label ?? null,
        message.to.address,
        message.to.label ?? null,
        message.body ?? null,
        message.mediaUrls ? JSON.stringify(message.mediaUrls) : null,
        message.sentAt,
        message.status,
      ]
    );
  }

  async getMessage(messageId: string): Promise<MessageRecord | null> {
    const res = await this.pool.query(`SELECT * FROM messages WHERE id = $1`, [messageId]);
    if (res.rows.length === 0) return null;
    return rowToMessage(res.rows[0]);
  }

  async listMessages(opts?: { limit?: number }): Promise<MessageRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM messages ORDER BY sent_at DESC LIMIT $1`,
      [opts?.limit ?? 200]
    );
    return res.rows.map(rowToMessage);
  }

  /** In-process only unless composed with RedisStore — see PostgresRedisStore. */
  async publishEvent(channel: string, payload: unknown): Promise<void> {
    for (const handler of this.subscribers.get(channel) ?? []) handler(payload);
  }

  async subscribeEvents(channel: string, handler: (payload: unknown) => void): Promise<void> {
    const list = this.subscribers.get(channel) ?? [];
    list.push(handler);
    this.subscribers.set(channel, list);
  }

  /**
   * INSERT ... ON CONFLICT DO NOTHING is atomic and race-safe across
   * concurrent processes sharing this Postgres instance — exactly what a
   * webhook-retry de-dup needs. No TTL/cleanup here (kept simple); add a
   * periodic DELETE WHERE seen_at < now() - interval if the table's growth
   * becomes a concern in a long-running deployment.
   */
  async checkAndMarkSeen(namespace: string, key: string): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO idempotency_keys (namespace, key) VALUES ($1, $2)
       ON CONFLICT (namespace, key) DO NOTHING
       RETURNING namespace`,
      [namespace, key]
    );
    return res.rowCount === 1;
  }

  /**
   * Upsert-and-return: if (endpointId, counterpart) already has a
   * conversation, return it; otherwise create it. `ON CONFLICT ... DO
   * UPDATE` (rather than DO NOTHING) is used specifically so the RETURNING
   * clause always gives back a row either way, in one round trip.
   */
  async getOrCreateConversation(endpointId: string, counterpart: string): Promise<ConversationRecord> {
    const res = await this.pool.query(
      `INSERT INTO conversations (id, endpoint_id, counterpart)
       VALUES ($1, $2, $3)
       ON CONFLICT (endpoint_id, counterpart) DO UPDATE SET endpoint_id = EXCLUDED.endpoint_id
       RETURNING *`,
      [randomUUID(), endpointId, counterpart]
    );
    return rowToConversation(res.rows[0]);
  }

  async appendConversationTurn(conversationId: string, turn: NewConversationTurn): Promise<ConversationTurnRecord> {
    const id = randomUUID();
    const createdAt = turn.createdAt ?? new Date().toISOString();
    const res = await this.pool.query(
      `INSERT INTO conversation_turns (id, conversation_id, channel, role, content, call_id, message_id, provider, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [id, conversationId, turn.channel, turn.role, turn.content, turn.callId ?? null, turn.messageId ?? null, turn.provider, createdAt]
    );
    await this.pool.query(`UPDATE conversations SET updated_at = $1 WHERE id = $2`, [createdAt, conversationId]);
    return rowToTurn(res.rows[0]);
  }

  async listConversationTurns(conversationId: string, limit?: number): Promise<ConversationTurnRecord[]> {
    const res = limit
      ? await this.pool.query(
          `SELECT * FROM conversation_turns WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
          [conversationId, limit]
        )
      : await this.pool.query(
          `SELECT * FROM conversation_turns WHERE conversation_id = $1 ORDER BY created_at ASC`,
          [conversationId]
        );
    // When limited, we fetched the most recent N in DESC order — reverse
    // back to chronological order for the caller.
    const rows = limit ? res.rows.reverse() : res.rows;
    return rows.map(rowToTurn);
  }

  async saveEndpointConfig(id: string, config: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO endpoint_configs (id, config) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
      [id, JSON.stringify(config)]
    );
  }

  async listEndpointConfigs(): Promise<Array<{ id: string; config: Record<string, unknown> }>> {
    const res = await this.pool.query(`SELECT id, config FROM endpoint_configs`);
    return res.rows.map((r) => ({ id: r.id, config: r.config }));
  }

  async shutdown(): Promise<void> {
    await this.pool.end();
  }
}

function rowToCall(row: any): CallSession {
  return {
    id: row.id,
    provider: row.provider,
    direction: row.direction,
    from: row.from_label ? { address: row.from_address, label: row.from_label } : { address: row.from_address },
    to: row.to_label ? { address: row.to_address, label: row.to_label } : { address: row.to_address },
    state: row.state,
    startedAt: new Date(row.started_at).toISOString(),
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : undefined,
    mediaStreamUrl: row.media_stream_url ?? undefined,
  };
}

function rowToConversation(row: any): ConversationRecord {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    counterpart: row.counterpart,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function rowToTurn(row: any): ConversationTurnRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    channel: row.channel,
    role: row.role,
    content: row.content,
    callId: row.call_id ?? undefined,
    messageId: row.message_id ?? undefined,
    provider: row.provider,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function rowToMessage(row: any): MessageRecord {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    direction: row.direction,
    from: row.from_label ? { address: row.from_address, label: row.from_label } : { address: row.from_address },
    to: row.to_label ? { address: row.to_address, label: row.to_label } : { address: row.to_address },
    body: row.body ?? undefined,
    mediaUrls: row.media_urls ?? undefined,
    sentAt: new Date(row.sent_at).toISOString(),
    status: row.status,
  };
}
