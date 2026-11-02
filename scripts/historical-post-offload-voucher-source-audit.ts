/**
 * Historical post-offload voucher-source identity audit; no data mutation.
 *
 * Header totals and source-charge amounts are stored in their native
 * currency. Comparing either with a derived USD FX amount can falsely
 * suggest a mismatch. The source's voucher_id is not an enforced FK in
 * production, so a stale link is not proof the active voucher is duplicate.
 */
import Decimal from "decimal.js";

export interface HistoricalPostOffloadLink {
  voucherId: number;
  voucherNumber: string;
  voucherContainerId: number | null;
  parsedSourceChargeId: number | null;
  voucherNativeAmount: string;
  voucherCurrency: string | null;
  sourceChargeId: number | null;
  sourceVoucherId: number | null;
  sourceContainerId: number | null;
  sourceNativeAmount: string | null;
  sourceCurrency: string | null;
  sourceDeletedAt: string | null;
  sourceInventoryValueDeltaUsd: string | null;
}
export function inspectHistoricalPostOffloadLink(link: HistoricalPostOffloadLink) {
  const flags: string[] = [];
  if (link.parsedSourceChargeId == null || link.sourceChargeId == null) {
    flags.push("SOURCE_CHARGE_RECORD_MISSING");
  } else {
    if (link.parsedSourceChargeId !== link.sourceChargeId ||
        link.voucherContainerId !== link.sourceContainerId) {
      flags.push("SOURCE_IDENTITY_MISMATCH");
    }
    if (link.sourceVoucherId !== link.voucherId) {
      flags.push("SOURCE_POINTS_TO_DIFFERENT_OR_MISSING_VOUCHER");
    }
    if (link.sourceNativeAmount == null ||
        new Decimal(link.voucherNativeAmount).minus(new Decimal(link.sourceNativeAmount)).abs().gt("0.005")) {
      flags.push("VOUCHER_SOURCE_NATIVE_AMOUNT_MISMATCH");
    }
    if ((link.voucherCurrency ?? "").toUpperCase() !== (link.sourceCurrency ?? "").toUpperCase()) {
      flags.push("VOUCHER_SOURCE_CURRENCY_MISMATCH");
    }
    if (link.sourceDeletedAt != null) flags.push("SOURCE_CHARGE_RETIRED");
  }
  return {
    voucherId: link.voucherId,
    voucherNumber: link.voucherNumber,
    originalChargeId: link.sourceChargeId,
    voucherNativeAmount: link.voucherNativeAmount,
    sourceNativeAmount: link.sourceNativeAmount,
    originalCurrency: link.voucherCurrency,
    recordedInventoryDeltaUsd: link.sourceInventoryValueDeltaUsd,
    sourceVoucherLinkId: link.sourceVoucherId,
    status: flags.length ? "REVIEW_SOURCE_LINK" : "SOURCE_IDENTITY_MATCHED",
    flags,
    isDuplicateProven: false,
    isExpenseOverstatementProven: false,
    proposedSourceMutation: null,
    proposedGLCorrection: null,
  };
}
