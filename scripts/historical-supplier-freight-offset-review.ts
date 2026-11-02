/**
 * No-write proof flags for freight journal pairings.
 * Equal debit/credit on FREIGHT means only that this ledger nets to zero
 * for a source container; it does NOT prove the corresponding accrued cost
 * was duplicated, expensed correctly or paid.
 */
import Decimal from "decimal.js";

export interface FreightOffsetEvidence {
  containerId: number;
  freightVoucherCount: number;
  freightDebitUsd: string;
  freightCreditUsd: string;
  chargeClearingDebitUsd: string;
  duplicateImportVoucherCount: number;
  duplicateImportExpenseUsd: string;
}
const amount = (value: string) => new Decimal(value);
export function classifyFreightOffsetEvidence(row: FreightOffsetEvidence) {
  const debit = amount(row.freightDebitUsd);
  const credit = amount(row.freightCreditUsd);
  const delta = debit.minus(credit).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const flags: string[] = [];
  if (debit.gt(0) && credit.gt(0) && delta.abs().lte("0.01")) {
    flags.push("FREIGHT_DEBIT_CREDIT_EXACT_OFFSET");
  } else if (debit.gt(0) && credit.gt(0)) {
    flags.push("FREIGHT_DEBIT_CREDIT_DIFFERENCE");
  } else if (debit.gt(0) || credit.gt(0)) {
    flags.push("FREIGHT_ONLY_ONE_SIDE_RECORDED");
  }
  if (row.duplicateImportVoucherCount > 0) flags.push("SECOND_IMPORT_VOUCHER_SAME_CONTAINER_REQUIRES_REVIEW");
  if (!amount(row.chargeClearingDebitUsd).isZero()) flags.push("FACTORY_CHARGES_PAYABLE_USED_AS_CLEARING_ACCOUNT");
  return {
    containerId: row.containerId,
    sourceFreightVouchers: row.freightVoucherCount,
    freightDebitUsd: debit.toFixed(2),
    freightCreditUsd: credit.toFixed(2),
    freightNetDebitUsd: delta.toFixed(2),
    linkedChargesPayableDebitUsd: amount(row.chargeClearingDebitUsd).toFixed(2),
    additionalImportVoucherCount: row.duplicateImportVoucherCount,
    additionalImportExpenseUsd: amount(row.duplicateImportExpenseUsd).toFixed(2),
    reviewFlags: flags,
    isProvenOverstatement: false,
    proposedCorrectionAmountUsd: null,
    proposedGLPosting: null,
    supplierMovement: null,
  };
}
