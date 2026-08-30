-- Canonical schema mirrored by PostgresStore migration version 1.
-- Runtime applies this transactionally and records schema_migrations.version=1.
CREATE TABLE calls (id TEXT PRIMARY KEY, provider TEXT NOT NULL, direction TEXT NOT NULL, from_address TEXT NOT NULL, from_label TEXT, to_address TEXT NOT NULL, to_label TEXT, state TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ, media_stream_url TEXT);
CREATE TABLE messages (id TEXT PRIMARY KEY, provider TEXT NOT NULL, kind TEXT NOT NULL, direction TEXT NOT NULL, from_address TEXT NOT NULL, from_label TEXT, to_address TEXT NOT NULL, to_label TEXT, body TEXT, media_urls JSONB, sent_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL);
CREATE TABLE idempotency_keys (namespace TEXT NOT NULL, key TEXT NOT NULL, seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(namespace,key));
CREATE TABLE conversations (id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, counterpart TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(endpoint_id,counterpart));
CREATE TABLE conversation_turns (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, channel TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, call_id TEXT, message_id TEXT, provider TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX idx_conversation_turns_conv_created ON conversation_turns(conversation_id,created_at);
CREATE TABLE endpoint_configs (id TEXT PRIMARY KEY, config JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
