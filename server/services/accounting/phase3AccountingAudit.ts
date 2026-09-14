import Decimal from "decimal.js";
import type { VoucherLedgerExpectation } from "./voucherLedgerExpectation";

export type Phase3AuditDomain = "payments" | "vouchers" | "sales" | "payroll" | "stock" | "invariants";

export interface Phase3AuditIssue {
  domain: Phase3AuditDomain;
  identity: string;
  code: string;
  expected: string;
  actual: string;
}

export interface PaymentAuditSnapshot {
  voucherId: number;
  voucherType: "Payment" | "Receipt";
  totalAmount: string;
  ledgerDebit: string;
  ledgerCredit: string;
  cashDebit: string;
  cashCredit: string;
  cancelled?: boolean;
}

export interface VoucherAuditSnapshot {
  voucherId: number;
  voucherType: string;
  totalAmount: string;
  ledgerDebit: string;
  ledgerCredit: string;
  documentDebit?: string;
  documentCredit?: string;
  ledgerExpectation: VoucherLedgerExpectation;
  cancelled?: boolean;
}

export interface SaleAuditSnapshot {
  voucherId: number;
  totalAmount: string;
  revenueCredit: string;
  revenueRequired?: boolean;
  soldQuantity: string;
  recordedCogsValue: string;
  inventoryMovementQuantity: string;
  inventoryMovementValue: string;
  cancelled?: boolean;
}

export interface PayrollAuditSnapshot {
  payrollId: number;
  status: string;
  netSalary: string;
  cashAccountId: number | null;
  paymentVoucherCount: number;
  paymentVoucherTotal: string;
  paymentLedgerDebit: string;
  paymentLedgerCredit: string;
  paymentCashCredit: string;
  daybookCount: number;
  daybookAmount: string;
}

export interface StockAccountingAuditSnapshot {
  companyId: number;
  operationalInventoryValue: string;
  accountingInventoryValue: string;
  accountingInventoryAccountCount: number;
}

export interface DuplicateEntryGroup {
  voucherId: number;
  signature: string;
  occurrences: number;
}

export interface Phase3AccountingAuditInput {
  companyId: number;
  payments: PaymentAuditSnapshot[];
  vouchers: VoucherAuditSnapshot[];
  sales: SaleAuditSnapshot[];
  payrolls: PayrollAuditSnapshot[];
  stock: StockAccountingAuditSnapshot;
  duplicateEntries: DuplicateEntryGroup[];
}

export interface Phase3AccountingAuditReport {
  companyId: number;
  clean: boolean;
  issues: Phase3AuditIssue[];
  checked: {
    payments: number;
    vouchers: number;
    sales: number;
    payrolls: number;
    duplicateEntryGroups: number;
  };
}

export class Phase3AccountingAuditError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "Phase3AccountingAuditError";
    this.code = code;
  }
}

const MONEY_TOLERANCE = new Decimal("0.005");

function decimal(value: unknown, field: string): Decimal {
  try {
    const parsed = new Decimal(String(value ?? ""));
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw new Phase3AccountingAuditError("PHASE3_DECIMAL_INVALID", `${field} is not a finite decimal`);
  }
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Phase3AccountingAuditError("PHASE3_ID_INVALID", `${field} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Phase3AccountingAuditError("PHASE3_COUNT_INVALID", `${field} must be a non-negative integer`);
  }
  return parsed;
}

function addIssue(
  issues: Phase3AuditIssue[],
  domain: Phase3AuditDomain,
  identity: string,
  code: string,
  expected: Decimal | string,
  actual: Decimal | string
): void {
  issues.push({
    domain,
    identity,
    code,
    expected: expected instanceof Decimal ? expected.toFixed() : expected,
    actual: actual instanceof Decimal ? actual.toFixed() : actual,
  });
}

function compareExact(
  issues: Phase3AuditIssue[],
  domain: Phase3AuditDomain,
  identity: string,
  code: string,
  expected: Decimal,
  actual: Decimal
): void {
  if (!expected.eq(actual)) addIssue(issues, domain, identity, code, expected, actual);
}

function compareMoney(
  issues: Phase3AuditIssue[],
  domain: Phase3AuditDomain,
  identity: string,
  code: string,
  expected: Decimal,
  actual: Decimal
): void {
  if (expected.minus(actual).abs().gte(MONEY_TOLERANCE)) {
    addIssue(issues, domain, identity, code, expected, actual);
  }
}

function assertUniqueIds<T>(rows: T[], field: keyof T, label: string): void {
  const seen = new Set<number>();
  for (const row of rows) {
    const id = positiveInteger(row[field], `${label}.${String(field)}`);
    if (seen.has(id)) {
      throw new Phase3AccountingAuditError("PHASE3_DUPLICATE_SNAPSHOT", `Duplicate ${label} snapshot ${id}`);
    }
    seen.add(id);
  }
}

/** Pure, deterministic Phase 3 accounting reconciliation. */
export function auditPhase3Accounting(input: Phase3AccountingAuditInput): Phase3AccountingAuditReport {
  const companyId = positiveInteger(input.companyId, "companyId");
  if (positiveInteger(input.stock.companyId, "stock.companyId") !== companyId) {
    throw new Phase3AccountingAuditError("PHASE3_COMPANY_MISMATCH", "Stock snapshot crossed the company boundary");
  }

  assertUniqueIds(input.payments, "voucherId", "payment");
  assertUniqueIds(input.vouchers, "voucherId", "voucher");
  assertUniqueIds(input.sales, "voucherId", "sale");
  assertUniqueIds(input.payrolls, "payrollId", "payroll");

  const issues: Phase3AuditIssue[] = [];
  let balancedDebits = new Decimal(0);
  let balancedCredits = new Decimal(0);

  for (const voucher of input.vouchers) {
    const voucherId = positiveInteger(voucher.voucherId, "voucher.voucherId");
    const identity = `voucher:${voucherId}`;
    if (voucher.cancelled) continue;

    const total = decimal(voucher.totalAmount, `${identity}.totalAmount`);
    const baseDebit = decimal(voucher.ledgerDebit, `${identity}.ledgerDebit`);
    const baseCredit = decimal(voucher.ledgerCredit, `${identity}.ledgerCredit`);
    const documentDebit = decimal(voucher.documentDebit ?? voucher.ledgerDebit, `${identity}.documentDebit`);
    const documentCredit = decimal(voucher.documentCredit ?? voucher.ledgerCredit, `${identity}.documentCredit`);
    const expectation = voucher.ledgerExpectation;

    if (expectation === "unclassified") {
      addIssue(
        issues,
        "vouchers",
        identity,
        "VOUCHER_TYPE_UNCLASSIFIED",
        "classified voucher type",
        voucher.voucherType
      );
      continue;
    }

    if (expectation === "balanced" || expectation === "balanced-only") {
      balancedDebits = balancedDebits.plus(baseDebit);
      balancedCredits = balancedCredits.plus(baseCredit);

      if (expectation === "balanced") {
        compareMoney(issues, "vouchers", identity, "VOUCHER_DEBIT_TOTAL_MISMATCH", total, documentDebit);
        compareMoney(issues, "vouchers", identity, "VOUCHER_CREDIT_TOTAL_MISMATCH", total, documentCredit);
      }

      if (!baseDebit.eq(baseCredit)) {
        addIssue(
          issues,
          "vouchers",
          identity,
          voucher.voucherType === "Journal" ? "UNBALANCED_JOURNAL" : "UNBALANCED_VOUCHER",
          baseDebit,
          baseCredit
        );
      }
      continue;
    }

    if (expectation === "single-sided") {
      const debitPosted = !baseDebit.isZero();
      const creditPosted = !baseCredit.isZero();
      if (debitPosted === creditPosted) {
        addIssue(
          issues,
          "vouchers",
          identity,
          "SINGLE_SIDED_VOUCHER_INVALID",
          "exactly one ledger side",
          debitPosted ? "both ledger sides" : "no ledger side"
        );
      }
      continue;
    }

    if (expectation === "inventory-sided") {
      if (baseDebit.isZero() && baseCredit.isZero()) {
        addIssue(
          issues,
          "vouchers",
          identity,
          "INVENTORY_SIDED_VOUCHER_EMPTY",
          "at least one GL side",
          "no ledger side"
        );
      }
      continue;
    }

    if (expectation === "none" && (!baseDebit.isZero() || !baseCredit.isZero())) {
      addIssue(
        issues,
        "vouchers",
        identity,
        "NO_LEDGER_VOUCHER_HAS_ENTRIES",
        "0 debit / 0 credit",
        `${baseDebit.toFixed()} / ${baseCredit.toFixed()}`
      );
    }
  }

  compareExact(
    issues,
    "invariants",
    `company:${companyId}`,
    "TOTAL_DEBITS_CREDITS_MISMATCH",
    balancedDebits,
    balancedCredits
  );

  for (const payment of input.payments) {
    const voucherId = positiveInteger(payment.voucherId, "payment.voucherId");
    if (payment.cancelled) continue;
    const identity = `payment:${voucherId}`;
    const total = decimal(payment.totalAmount, `${identity}.totalAmount`);
    const debit = decimal(payment.ledgerDebit, `${identity}.ledgerDebit`);
    const credit = decimal(payment.ledgerCredit, `${identity}.ledgerCredit`);
    const cashDebit = decimal(payment.cashDebit, `${identity}.cashDebit`);
    const cashCredit = decimal(payment.cashCredit, `${identity}.cashCredit`);

    compareExact(issues, "payments", identity, "PAYMENT_LEDGER_NOT_BALANCED", debit, credit);
    if (payment.voucherType === "Payment") {
      compareMoney(issues, "payments", identity, "PAYMENT_CASH_CREDIT_MISMATCH", total, cashCredit);
    } else {
      compareMoney(issues, "payments", identity, "RECEIPT_CASH_DEBIT_MISMATCH", total, cashDebit);
    }
  }

  for (const sale of input.sales) {
    const voucherId = positiveInteger(sale.voucherId, "sale.voucherId");
    const identity = `sale:${voucherId}`;
    const movementQty = decimal(sale.inventoryMovementQuantity, `${identity}.inventoryMovementQuantity`);
    const movementValue = decimal(sale.inventoryMovementValue, `${identity}.inventoryMovementValue`);

    if (sale.cancelled) {
      compareExact(issues, "sales", identity, "CANCELLED_SALE_INVENTORY_NOT_REVERSED", new Decimal(0), movementQty);
      compareMoney(issues, "sales", identity, "CANCELLED_SALE_VALUE_NOT_REVERSED", new Decimal(0), movementValue);
      continue;
    }

    const total = decimal(sale.totalAmount, `${identity}.totalAmount`);
    const revenue = decimal(sale.revenueCredit, `${identity}.revenueCredit`);
    const soldQty = decimal(sale.soldQuantity, `${identity}.soldQuantity`).abs();
    const cogs = decimal(sale.recordedCogsValue, `${identity}.recordedCogsValue`).abs();

    if (sale.revenueRequired !== false) {
      compareMoney(issues, "sales", identity, "SALE_REVENUE_MISMATCH", total, revenue);
    }
    compareExact(issues, "sales", identity, "SALE_INVENTORY_QUANTITY_MISMATCH", soldQty, movementQty.abs());
    compareMoney(issues, "sales", identity, "SALE_COGS_INVENTORY_VALUE_MISMATCH", cogs, movementValue.abs());
  }

  for (const payroll of input.payrolls) {
    const payrollId = positiveInteger(payroll.payrollId, "payroll.payrollId");
    const identity = `payroll:${payrollId}`;
    const netSalary = decimal(payroll.netSalary, `${identity}.netSalary`).abs();
    const paymentVoucherCount = nonNegativeInteger(payroll.paymentVoucherCount, `${identity}.paymentVoucherCount`);
    const daybookCount = nonNegativeInteger(payroll.daybookCount, `${identity}.daybookCount`);
    const isPaid = String(payroll.status).toUpperCase() === "PAID";

    if (!isPaid) {
      if (paymentVoucherCount !== 0) {
        addIssue(issues, "payroll", identity, "UNPAID_PAYROLL_HAS_PAYMENT_VOUCHER", "0", String(paymentVoucherCount));
      }
      if (daybookCount !== 0) {
        addIssue(issues, "payroll", identity, "UNPAID_PAYROLL_HAS_DAYBOOK_PAYMENT", "0", String(daybookCount));
      }
      continue;
    }

    if (netSalary.isZero()) continue;
    if (!payroll.cashAccountId) {
      addIssue(issues, "payroll", identity, "PAID_PAYROLL_CASH_ACCOUNT_MISSING", "cash/bank account", "missing");
    }
    if (paymentVoucherCount !== 1) {
      addIssue(issues, "payroll", identity, "PAYROLL_PAYMENT_VOUCHER_COUNT_MISMATCH", "1", String(paymentVoucherCount));
    }

    compareMoney(
      issues,
      "payroll",
      identity,
      "PAYROLL_PAYMENT_TOTAL_MISMATCH",
      netSalary,
      decimal(payroll.paymentVoucherTotal, `${identity}.paymentVoucherTotal`)
    );
    const paymentDebit = decimal(payroll.paymentLedgerDebit, `${identity}.paymentLedgerDebit`);
    const paymentCredit = decimal(payroll.paymentLedgerCredit, `${identity}.paymentLedgerCredit`);
    compareMoney(issues, "payroll", identity, "PAYROLL_PAYMENT_DEBIT_MISMATCH", netSalary, paymentDebit);
    compareMoney(issues, "payroll", identity, "PAYROLL_PAYMENT_CREDIT_MISMATCH", netSalary, paymentCredit);
    compareMoney(
      issues,
      "payroll",
      identity,
      "PAYROLL_CASH_CREDIT_MISMATCH",
      netSalary,
      decimal(payroll.paymentCashCredit, `${identity}.paymentCashCredit`)
    );

    if (daybookCount !== 1) {
      addIssue(issues, "payroll", identity, "PAYROLL_DAYBOOK_COUNT_MISMATCH", "1", String(daybookCount));
    }
    compareMoney(
      issues,
      "payroll",
      identity,
      "PAYROLL_DAYBOOK_AMOUNT_MISMATCH",
      netSalary,
      decimal(payroll.daybookAmount, `${identity}.daybookAmount`)
    );
  }

  const operationalInventoryValue = decimal(input.stock.operationalInventoryValue, "stock.operationalInventoryValue");
  const accountingInventoryValue = decimal(input.stock.accountingInventoryValue, "stock.accountingInventoryValue");
  const inventoryAccountCount = nonNegativeInteger(
    input.stock.accountingInventoryAccountCount,
    "stock.accountingInventoryAccountCount"
  );
  if (inventoryAccountCount === 0 && !operationalInventoryValue.isZero()) {
    addIssue(
      issues,
      "stock",
      `company:${companyId}`,
      "STOCK_ACCOUNTING_MAPPING_MISSING",
      "at least one inventory ledger account",
      "0"
    );
  } else if (inventoryAccountCount > 0) {
    compareMoney(
      issues,
      "stock",
      `company:${companyId}`,
      "STOCK_ACCOUNTING_VALUE_MISMATCH",
      operationalInventoryValue,
      accountingInventoryValue
    );
  }

  for (const duplicate of input.duplicateEntries) {
    const voucherId = positiveInteger(duplicate.voucherId, "duplicateEntry.voucherId");
    const occurrences = nonNegativeInteger(duplicate.occurrences, "duplicateEntry.occurrences");
    if (occurrences <= 1) continue;
    addIssue(
      issues,
      "invariants",
      `voucher:${voucherId}`,
      "DUPLICATE_ACCOUNTING_ENTRY",
      "1",
      `${occurrences} × ${duplicate.signature}`
    );
  }

  return {
    companyId,
    clean: issues.length === 0,
    issues,
    checked: {
      payments: input.payments.length,
      vouchers: input.vouchers.length,
      sales: input.sales.length,
      payrolls: input.payrolls.length,
      duplicateEntryGroups: input.duplicateEntries.length,
    },
  };
}
