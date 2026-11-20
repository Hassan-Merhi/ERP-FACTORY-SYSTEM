/**
 * Revaluation journals must reconcile against POSTED ledger cents, not the
 * six-decimal native/base history used to explain exchange differences.
 *
 * The balance engine and Net Position use sum(debit_amount-credit_amount).
 * For Zambia's 20.8 -> 20.9 change, the 6dp calculation gives KITWE 11.61 /
 * LUSAKA 34.02, while the actual posted USD balances require 11.60 / 34.03.
 * Using bookClosingUsd prevents a spurious one-cent FX gain/loss on the next
 * report and makes re-saving the same rate a no-op.
 */
import Decimal from "decimal.js";

export function postedFxRevaluationAdjustmentUsd(
  currentTranslatedUsd: string,
  postedBookClosingUsd: string
): string {
  const current = new Decimal(currentTranslatedUsd);
  const booked = new Decimal(postedBookClosingUsd);
  if (!current.isFinite() || !booked.isFinite()) {
    throw new Error("FX revaluation requires finite current and posted USD amounts.");
  }
  return current.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .minus(booked.toDecimalPlaces(2, Decimal.ROUND_HALF_UP))
    .toFixed(2);
}
