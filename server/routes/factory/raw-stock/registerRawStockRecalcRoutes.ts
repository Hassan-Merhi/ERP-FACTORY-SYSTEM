import type { Express } from "express";
import { registerRawStockRecalcRoutes as registerLegacyRawStockRecalcRoutes } from "./rawStockRecalcRoutes";

/**
 * Register the raw-stock recalculation routes. Route registration never touches
 * the database schema: factory_recalc_undo_log and factory_replay_consumed_tokens
 * are defined by the schema migrations (migrations/).
 */
export function registerRawStockRecalcRoutes(app: Express): void {
  registerLegacyRawStockRecalcRoutes(app);
}
