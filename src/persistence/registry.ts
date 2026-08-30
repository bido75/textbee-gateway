import { PersistenceStore } from "./types.js";
import { MemoryStore } from "./memory-store.js";
import { PostgresStore } from "./postgres-store.js";
import { RedisStore } from "./redis-store.js";
import { PostgresRedisStore } from "./composite-store.js";

export interface PersistenceConfig {
  type: "memory" | "postgres" | "redis" | "postgres+redis";
  config?: Record<string, unknown>;
}

export function createPersistenceStore(cfg: PersistenceConfig | undefined): PersistenceStore {
  if (!cfg || cfg.type === "memory") return new MemoryStore();

  if (cfg.type === "postgres") {
    return new PostgresStore({ connectionString: cfg.config!.connectionString as string });
  }

  if (cfg.type === "redis") {
    return new RedisStore({
      url: cfg.config!.url as string,
      keyPrefix: cfg.config?.keyPrefix as string | undefined,
    });
  }

  if (cfg.type === "postgres+redis") {
    const postgres = new PostgresStore({ connectionString: cfg.config!.postgresUrl as string });
    const redis = new RedisStore({ url: cfg.config!.redisUrl as string });
    return new PostgresRedisStore(postgres, redis);
  }

  throw new Error(`Unknown persistence type "${cfg.type}"`);
}
