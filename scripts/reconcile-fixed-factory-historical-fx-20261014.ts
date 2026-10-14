/**
 * Explicit one-time company-12 repair: EUR 1.18 and AUD 0.75 USD per unit.
 *
 * Called only when ERP_RECONCILE_FACTORY_HISTORICAL_FX_20261014 matches the
 * approved, exact value. Never guesses historical rates or changes documents
 * that already have normalized native/base figures.
 */
import { db } from "../server/db";
import {
  applyFactoryFxLegacyRepair,
  planFactoryFxLegacyRepair,
} from "../server/services/factory/factoryFxLegacyRepair";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";

const COMPANY_ID = 12;
const EXPECTED_LEGACY_LINES = 462;

export async function reconcileFixedFactoryHistoricalFx20261014(): Promise<{
  status: "already-repaired" | "applied";
  lines: number;
  vouchers: number;
}> {
  return runWithDatabaseScopeRuntimeContext(
    createTenantDatabaseScope(COMPANY_ID),
    async () => {
      const plan = await planFactoryFxLegacyRepair(COMPANY_ID, db, true);
      if (plan.legacyLines === 0) {
        return { status: "already-repaired", lines: 0, vouchers: 0 };
      }

      // Fail closed if the source has changed since the reviewed live audit.
      // Never apply a partial repair or modify another currency.
      if (
        plan.legacyLines !== EXPECTED_LEGACY_LINES ||
        plan.repairableLines !== EXPECTED_LEGACY_LINES ||
        plan.fixedRateLines !== EXPECTED_LEGACY_LINES ||
        plan.skippedLines !== 0 ||
        plan.fixedRatesUsed?.EUR !== "1.18" ||
        plan.fixedRatesUsed?.AUD !== "0.75" ||
        plan.lines.some(
          (line) =>
            (line.currency !== "EUR" && line.currency !== "AUD") ||
            line.rateSource !== "approved-fixed" ||
            line.skipReason !== null
        )
      ) {
        throw new Error(
          "Historical FX documents changed or contain unsafe classifications; no journal changes made. Refresh the repair preview."
        );
      }

      const applied = await applyFactoryFxLegacyRepair(COMPANY_ID, {
        expectedPlanHash: plan.planHash,
        useFixedHistoricalRates: true,
        actor: {
          userId: "system",
          username: "approved-historical-factory-fx-repair-20261014",
        },
      });
      if (applied.repairableLines !== EXPECTED_LEGACY_LINES) {
        throw new Error("Applied historical FX repair did not match the reviewed source count.");
      }
      return {
        status: "applied",
        lines: applied.repairableLines,
        vouchers: applied.repairableVouchers,
      };
    }
  );
}
