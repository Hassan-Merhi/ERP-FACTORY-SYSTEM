/**
 * Manual FX corrections change the USD book valuation ONLY.
 * They cannot introduce new accounts or alter the native currency quantity.
 * The FX gain/loss counter-line is regenerated from the signed account deltas.
 */
import Decimal from "decimal.js";

export type FxUsdAdjustmentOverride = {
  accountKind: "ledger" | "bank" | "customer";
  accountId: number;
  adjustmentUsd: string;
};

export type FxUsdAdjustmentLine = FxUsdAdjustmentOverride & {
  accountName: string;
  currency: string;
};

export type FxUsdAdjustmentRevisedLine = FxUsdAdjustmentLine & {
  automaticAdjustmentUsd: string;
  manuallyOverridden: boolean;
};

export class FxUsdAdjustmentOverrideError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FxUsdAdjustmentOverrideError";
  }
}

const MAX_ABS_USD = new Decimal("100000000");
const MONEY_FORMAT = /^-?(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/;

export function normalizeFxUsdAdjustment(input: string): string {
  if (typeof input !== "string" || !MONEY_FORMAT.test(input)) {
    throw new FxUsdAdjustmentOverrideError(
      "FX_CORRECTION_AMOUNT_INVALID",
      "Each USD adjustment must be a signed amount with no more than two decimal places."
    );
  }
  const parsed = new Decimal(input);
  if (!parsed.isFinite() || parsed.abs().gt(MAX_ABS_USD)) {
    throw new FxUsdAdjustmentOverrideError(
      "FX_CORRECTION_AMOUNT_OUT_OF_RANGE",
      "The USD adjustment exceeds the permitted range."
    );
  }
  return parsed.toFixed(2);
}

export function applyFxUsdAdjustmentOverrides(
  lines: readonly FxUsdAdjustmentLine[],
  overrides: readonly FxUsdAdjustmentOverride[] = []
): FxUsdAdjustmentRevisedLine[] {
  if (!Array.isArray(overrides) || overrides.length > 100) {
    throw new FxUsdAdjustmentOverrideError(
      "FX_CORRECTION_OVERRIDES_INVALID",
      "Too many edited FX accounts were supplied."
    );
  }
  const eligible = new Set(lines.map((line) => line.accountKind + ":" + line.accountId));
  const edited = new Map<string, string>();
  for (const item of overrides) {
    const id = item.accountKind + ":" + item.accountId;
    if (!eligible.has(id) || edited.has(id)) {
      throw new FxUsdAdjustmentOverrideError(
        "FX_CORRECTION_ACCOUNT_INVALID",
        "Only one adjustment per verified original FX account may be edited."
      );
    }
    edited.set(id, normalizeFxUsdAdjustment(item.adjustmentUsd));
  }
  return lines.map((line) => {
    const automaticAdjustmentUsd = normalizeFxUsdAdjustment(line.adjustmentUsd);
    const adjustmentUsd = edited.get(line.accountKind + ":" + line.accountId) ?? automaticAdjustmentUsd;
    return {
      ...line,
      adjustmentUsd,
      automaticAdjustmentUsd,
      manuallyOverridden: adjustmentUsd !== automaticAdjustmentUsd,
    };
  });
}
