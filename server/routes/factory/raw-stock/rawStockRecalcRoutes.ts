import type { Express } from "express";
import { registerHistoricalReplayFullCompanyScopeRoutes } from "./historicalReplayFullCompanyScopeRoutes";
import { registerHistoricalReplayPhase6GuardRoutes } from "./historicalReplayGuardRoutes";
import { registerHistoricalReplayPhase8ReadinessRoutes } from "./historicalReplayReadinessRoutes";
import { registerHistoricalReplayPhase8VerificationRoutes } from "./historicalReplayVerificationRoutes";
import { registerHistoricalReplayRoutesV4 } from "./historicalReplayRoutesV4";
import { registerRawStockRecalcRoutes as registerLegacyRawStockRecalcRoutes } from "./recalc";

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
