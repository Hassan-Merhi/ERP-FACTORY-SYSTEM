import type { Express } from "express";
import { pool } from "../../../db";
import { registerRawStockRecalcRoutes as registerLegacyRawStockRecalcRoutes } from "./rawStockRecalcRoutes";

const UNDO_LOG_CREATE_TABLE_PATTERN = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+factory_recalc_undo_log/i;

/**
 * Register the raw-stock recalculation routes without allowing route registration
 * to mutate the database schema.
 *
 * The legacy route module still contains an idempotent CREATE TABLE call. The
 * schema is now owned exclusively by the versioned migration
 * migrations/20260717_factory_recalc_undo_log.sql. This narrow compatibility
 * guard prevents that one historical registration-time statement from executing
 * until the large route module is split and the obsolete helper can be deleted
 * directly without risking an unrelated rewrite.
 */
type PoolQuery = typeof pool.query;

export function registerRawStockRecalcRoutes(app: Express): void {
  const mutablePool = pool as unknown as { query: PoolQuery };
  const originalQuery = pool.query.bind(pool) as PoolQuery;

  mutablePool.query = ((...args: Parameters<PoolQuery>) => {
    const first: unknown = args[0];
    const sqlText = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text;
    if (typeof sqlText === "string" && UNDO_LOG_CREATE_TABLE_PATTERN.test(sqlText)) {
      return Promise.resolve({ rows: [], rowCount: 0, command: "SKIPPED_RUNTIME_DDL", fields: [] }) as unknown as ReturnType<
        PoolQuery
      >;
    }
    return originalQuery(...args);
  }) as PoolQuery;

  try {
    registerLegacyRawStockRecalcRoutes(app);
  } finally {
    mutablePool.query = originalQuery;
  }
}
