import type { Express } from "express";
import { pool } from "../../../db";
import { registerHistoricalReplayFullCompanyScopeRoutes } from "./historicalReplayFullCompanyScopeRoutes";
import { registerHistoricalReplayPhase6GuardRoutes } from "./historicalReplayPhase6GuardRoutes";
import { registerHistoricalReplayPhase8ReadinessRoutes } from "./historicalReplayPhase8ReadinessRoutes";
import { registerHistoricalReplayPhase8VerificationRoutes } from "./historicalReplayPhase8VerificationRoutes";
import { registerHistoricalReplayRoutesV4 } from "./historicalReplayRoutesV4";
import { registerRawStockRecalcRoutes as registerPreservedRawStockRecalcRoutes } from "./recalc";

/**
 * The preserved legacy module still contains an old route-registration-time
 * CREATE TABLE call. Migration 0007 now owns that schema. Suppress only that one
 * synchronous registration query while retaining every legacy non-replay route.
 * The patch exists for one call stack only; normal pool.query is restored before
 * the event loop can process any other work.
 */
type PoolQuery = typeof pool.query;

function registerLegacyRawStockRecalcRoutes(app: Express): void {
  const mutablePool = pool as unknown as { query: PoolQuery };
  const originalQuery = pool.query.bind(pool) as PoolQuery;
  mutablePool.query = ((...args: Parameters<PoolQuery>) => {
    const first: unknown = args[0];
    const sqlText = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text;
    if (typeof sqlText === "string" && /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+factory_recalc_undo_log/i.test(sqlText)) {
      return Promise.resolve({ rows: [], rowCount: 0 }) as unknown as ReturnType<PoolQuery>;
    }
    return originalQuery(...args);
  }) as PoolQuery;
  try {
    registerPreservedRawStockRecalcRoutes(app);
  } finally {
    mutablePool.query = originalQuery;
  }
}

/**
 * V8 production readiness and apply authorization run first. Read-only exact
 * verification is registered independently. The full-company scope middleware
 * then expands the selected supplier dependency closure, the fail-closed V7
 * safety/impact guard validates it, and the exact signed Prepare/Apply/Undo
 * handlers own the transaction. Legacy routes remain available only for unrelated
 * recalculation, audit, history, and non-replay undo.
 */
export function registerRawStockRecalcRoutes(app: Express): void {
  registerHistoricalReplayPhase8ReadinessRoutes(app);
  registerHistoricalReplayPhase8VerificationRoutes(app);
  registerHistoricalReplayFullCompanyScopeRoutes(app);
  registerHistoricalReplayPhase6GuardRoutes(app);
  registerHistoricalReplayRoutesV4(app);
  registerLegacyRawStockRecalcRoutes(app);
}
