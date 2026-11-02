/**
 * Pure, conservative expense classification. Flags need review; they do NOT
 * authorize a voucher reversal or an expense reclassification.
 */
import Decimal from "decimal.js";

export interface HistoricalSupplierVoucherEvidence {
  voucherDate: string;
  postingDate: string;
  businessDate: string;
  expenseDebitUsd: string;
  supplierCreditUsd: string;
  expectedUsd: string | null;
  receivedKg: string;
  usedKg: string;
  remainingKg: string;
  relatedExpenseCount: number;
  storedArrivalDate?: string | null;
  firstOffloadedAt?: string | null;
  expectedSupplierId?: number | null;
  linkedSupplierId?: number | null;
  sourceCurrency?: string | null;
  voucherCurrency?: string | null;
  voucherDebitsUsd?: string;
  voucherCreditsUsd?: string;
}

export function classifyHistoricalSupplierVoucher(row: HistoricalSupplierVoucherEvidence): string[] {
  const flags: string[] = [];
  const amount = (n: string) => new Decimal(n);
  if (row.voucherDate > row.postingDate) flags.push("DATED_AFTER_POSTING");
  if (row.voucherDate > row.businessDate) flags.push("FUTURE_DATED");
  if (row.expectedUsd != null &&
      amount(row.expectedUsd).minus(row.expenseDebitUsd).abs().gt("0.05")) {
    flags.push("SOURCE_VS_GL_AMOUNT_REQUIRES_REVIEW");
  }
  if (amount(row.expenseDebitUsd).minus(row.supplierCreditUsd).abs().gt("0.01")) {
    flags.push("EXPENSE_VS_SUPPLIER_GL_DIFFERENCE");
  }
  if (amount(row.receivedKg).gt(0) && amount(row.remainingKg).eq(0) &&
      amount(row.usedKg).gte(row.receivedKg)) {
    flags.push("RAW_MATERIAL_ALREADY_CONSUMED");
  }
  if (row.relatedExpenseCount > 0) flags.push("OTHER_FACTORY_EXPENSE_LINES_CHECK_FOR_OVERLAP");
  if (row.expectedSupplierId !== undefined && row.linkedSupplierId !== undefined &&
      row.expectedSupplierId !== row.linkedSupplierId) {
    flags.push("SOURCE_SUPPLIER_MISMATCH");
  }
  if (row.sourceCurrency != null && row.voucherCurrency != null &&
      row.sourceCurrency.toUpperCase() !== row.voucherCurrency.toUpperCase()) {
    flags.push("SOURCE_VOUCHER_CURRENCY_MISMATCH");
  }
  if (row.storedArrivalDate && row.firstOffloadedAt &&
      row.storedArrivalDate > row.firstOffloadedAt.slice(0, 10)) {
    flags.push("ARRIVAL_DATE_AFTER_STOCK_OFFLOAD");
  }
  if (row.voucherDebitsUsd != null && row.voucherCreditsUsd != null &&
      amount(row.voucherDebitsUsd).minus(row.voucherCreditsUsd).abs().gt("0.01")) {
    flags.push("VOUCHER_NOT_BALANCED");
  }
  // Mere receipt/consumption alone does not prove how a source was expensed.
  flags.push("ACCOUNTING_TREATMENT_REQUIRES_MANUAL_PROOF");
  return flags;
}
