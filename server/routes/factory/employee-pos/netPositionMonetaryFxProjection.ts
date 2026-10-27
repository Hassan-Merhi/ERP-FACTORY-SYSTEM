/**
 * Factory Net Position: current-rate monetary USD projection (FX monetary
 * valuation, Phase 4). Report-only. Factory carries substantial nonmonetary
 * stock / WIP / order cost valuations and historical replay safeguards, so only
 * TODAY's verified monetary ledger, customer and loan rows are replaced, never
 * inventory, supplier or operational memo rows. A pinned secondary company is a
 * separate authorized reporting scope and never borrows the ERP session's rate.
 */
import { logger } from "../../../lib/logger";
import { round2 } from "../../../netPositionHelper";
import { getMonetaryFxValuation } from "../../../services/accounting/monetaryFxValuationService";
import {
  applyVerifiedMonetaryFxOverlay,
  type MonetaryNetPositionPayload,
} from "../../../services/accounting/monetaryFxReportOverlay";

export interface FactoryMonetaryFxProjectionScope {
  companyId: number;
  /** A dated (historical) report keeps its booked USD. */
  isHistorical: boolean;
  /** The ERP session's company; the projection runs only when it is the factory company. */
  sessionCompanyId: number | null | undefined;
}

type FactoryNetPositionReport = {
  ledgerAssets: number;
  ledgerLiabilities: number;
  [key: string]: unknown;
};

/** Returns the report with today's monetary rows at the current rate, or the report unchanged. */
export async function projectFactoryNetPositionMonetaryFx<T extends FactoryNetPositionReport>(
  finished: T,
  scope: FactoryMonetaryFxProjectionScope
): Promise<T | (MonetaryNetPositionPayload & { ledgerAssets: number; ledgerLiabilities: number })> {
  if (scope.isHistorical || Number(scope.sessionCompanyId) !== scope.companyId) return finished;
  try {
    const valuation = await getMonetaryFxValuation(scope.companyId);
    const projected = applyVerifiedMonetaryFxOverlay(finished as unknown as MonetaryNetPositionPayload, valuation);
    const report = projected.payload as MonetaryNetPositionPayload & { ledgerAssets: number; ledgerLiabilities: number };
    if (projected.appliedKeys.length) {
      report.ledgerAssets = round2(Number(finished.ledgerAssets) + projected.ledgerForUsDelta);
      report.ledgerLiabilities = round2(Number(finished.ledgerLiabilities) + projected.ledgerOnUsDelta);
    }
    report.currencyRevaluation = {
      valuationMode: "CURRENT",
      currentMonetaryTranslationApplied: projected.appliedKeys.length > 0,
      appliedAccountKeys: projected.appliedKeys,
      skippedAccountKeys: projected.skipped,
      unresolvedAccountCount: valuation.unresolvedAccountCount,
      needsReviewCount: valuation.needsReviewCount,
      rateErrorsByCurrency: valuation.rateErrorsByCurrency,
      currentMonetaryTranslationDifferenceUsd: projected.currentMonetaryTranslationDifferenceUsd,
    };
    return report;
  } catch (error) {
    // Original currency evidence, company scope or the rate resolver is not
    // safe to revalue: keep the original USD book.
    logger.error("Factory current monetary FX projection unavailable; keeping original USD book", {
      companyId: scope.companyId, error,
    });
    return finished;
  }
}
