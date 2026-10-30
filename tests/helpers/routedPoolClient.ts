import type { PoolClient } from "pg";
import { vi } from "vitest";

import { pool } from "../../server/db";

/**
 * Sends every `pool.connect` / `pool.query` (and so every drizzle `db` call)
 * to one already-open client, so code that runs its own queries or
 * transactions can be exercised inside a test transaction that is rolled back.
 * BEGIN / COMMIT / ROLLBACK issued by that code become savepoints.
 *
 * The scoped pool wrappers lease from the physical pool's `connect`, which is
 * what the spy replaces. Returns a function that removes the routing.
 */
export function routePoolToClient(client: PoolClient): () => void {
  let depth = 0;
  const translate = (sql: string): string | null => {
    const statement = sql.trim().toUpperCase();
    if (statement.startsWith("BEGIN")) return `SAVEPOINT routed_pool_${++depth}`;
    if (statement === "COMMIT") return depth > 0 ? `RELEASE SAVEPOINT routed_pool_${depth--}` : "SELECT 1";
    if (statement === "ROLLBACK") return depth > 0 ? `ROLLBACK TO SAVEPOINT routed_pool_${depth--}` : "SELECT 1";
    return null;
  };
  const query = (text: unknown, ...rest: unknown[]) => {
    const sql = typeof text === "string" ? text : (text as { text?: string })?.text;
    const translated = typeof sql === "string" ? translate(sql) : null;
    return translated
      ? client.query(translated)
      : (client.query as (...args: unknown[]) => Promise<unknown>)(text, ...rest);
  };
  const routed = new Proxy(client, {
    get(target, property) {
      if (property === "release") return () => undefined;
      if (property === "query") return query;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const connect = vi.spyOn(pool, "connect").mockImplementation((async () => routed) as never);
  const poolQuery = vi.spyOn(pool, "query").mockImplementation(query as never);
  return () => {
    connect.mockRestore();
    poolQuery.mockRestore();
  };
}

/**
 * Runs `work` with all database access routed to one client inside a
 * transaction that is always rolled back.
 */
export async function withRolledBackPool<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let unroute: (() => void) | null = null;
  try {
    await client.query("BEGIN");
    unroute = routePoolToClient(client);
    return await work(client);
  } finally {
    unroute?.();
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}
