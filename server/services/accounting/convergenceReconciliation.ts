import Decimal from "decimal.js";
import type { VoucherLedgerExpectation } from "./voucherLedgerExpectation";
import {
  assertTransactionCompanyScope,
  type CompanyScopedReadTransaction,
  type CompanyScopedTransaction,
} from "../security/transactionCompanyScope";

export interface AccountingConvergenceSnapshot {
  voucherId: number;
  companyId: number;
  voucherBaseDebit: string;
  voucherBaseCredit: string;
  ledgerBaseDebit: string;
  ledgerBaseCredit: string;
  daybookBaseAmount?: string | null;
  expectsDaybook: boolean;
  ledgerExpectation?: VoucherLedgerExpectation;
  voucherCancelled?: boolean;
}

export interface StockConvergenceSnapshot {
  sourceType: string;
  sourceId: string;
  companyId: number;
  documentQuantity: string;
  movementQuantity: string;
  documentValue: string;
  movementValue: string;
}

export interface ConvergenceReconciliationAdapter<TTransaction = CompanyScopedReadTransaction> {
  loadAccountingSnapshots(input: { tx: TTransaction; companyId: number }): Promise<AccountingConvergenceSnapshot[]>;
  loadStockSnapshots(input: { tx: TTransaction; companyId: number }): Promise<StockConvergenceSnapshot[]>;
}

export interface ConvergenceDiscrepancy {
  domain: "accounting" | "inventory";
  identity: string;
  code: string;
  expected: string;
  actual: string;
}

export interface ConvergenceReconciliationResult {
  companyId: number;
  accountingSnapshots: number;
  stockSnapshots: number;
  discrepancies: ConvergenceDiscrepancy[];
  clean: boolean;
}

export class ConvergenceReconciliationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConvergenceReconciliationError";
    this.code = code;
  }
}

function positiveId(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConvergenceReconciliationError("CONVERGENCE_ID_INVALID", `${field} must be a positive integer`);
  }
  return parsed;
}

function decimal(value: unknown, field: string): Decimal {
  try {
    const parsed = new Decimal(String(value));
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw new ConvergenceReconciliationError("CONVERGENCE_DECIMAL_INVALID", `${field} is invalid`);
  }
}

function compare(
  discrepancies: ConvergenceDiscrepancy[],
  domain: ConvergenceDiscrepancy["domain"],
  identity: string,
  code: string,
  expected: Decimal,
  actual: Decimal
): void {
  if (!expected.eq(actual)) {
    discrepancies.push({
      domain,
      identity,
      code,
      expected: expected.toFixed(),
      actual: actual.toFixed(),
    });
  }
}

function requiredIdentityPart(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new ConvergenceReconciliationError("CONVERGENCE_IDENTITY_INVALID", `${field} is required`);
  }
  return normalized;
}

function assertUniqueIdentity(seen: Set<string>, identity: string, domain: string): void {
  if (seen.has(identity)) {
    throw new ConvergenceReconciliationError(
      "CONVERGENCE_DUPLICATE_SNAPSHOT",
      `Duplicate ${domain} reconciliation snapshot ${identity}`
    );
  }
  seen.add(identity);
}

/**
 * Read-only transaction-owned reconciliation for the central convergence path.
 * It never repairs data. Repairs must use the source posting/reversal services.
 */
export async function reconcileConvergenceTx<
  TTransaction extends CompanyScopedTransaction = CompanyScopedReadTransaction,
>(
  tx: TTransaction,
  companyIdValue: unknown,
  adapter: ConvergenceReconciliationAdapter<TTransaction>
): Promise<ConvergenceReconciliationResult> {
  const companyId = positiveId(companyIdValue, "companyId");
  await assertTransactionCompanyScope(tx, companyId);

  const accounting = await adapter.loadAccountingSnapshots({ tx, companyId });
  const stock = await adapter.loadStockSnapshots({ tx, companyId });
  if (!Array.isArray(accounting) || !Array.isArray(stock)) {
    throw new ConvergenceReconciliationError(
      "CONVERGENCE_ADAPTER_INVALID",
      "Reconciliation adapters must return snapshot arrays"
    );
  }

  const discrepancies: ConvergenceDiscrepancy[] = [];
  const accountingIdentities = new Set<string>();
  const stockIdentities = new Set<string>();

  for (const row of accounting) {
    if (positiveId(row.companyId, "accounting.companyId") !== companyId) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_COMPANY_MISMATCH",
        `Accounting snapshot ${row.voucherId} crossed the transaction company boundary`
      );
    }

    const identity = `voucher:${positiveId(row.voucherId, "voucherId")}`;
    assertUniqueIdentity(accountingIdentities, identity, "accounting");

    if (row.voucherCancelled) {
      if (row.daybookBaseAmount != null) {
        discrepancies.push({
          domain: "accounting",
          identity,
          code: "CANCELLED_VOUCHER_DAYBOOK_MIRROR",
          expected: "missing",
          actual: decimal(row.daybookBaseAmount, "daybookBaseAmount").toFixed(),
        });
      }
      continue;
    }

    const voucherDebit = decimal(row.voucherBaseDebit, "voucherBaseDebit");
    const voucherCredit = decimal(row.voucherBaseCredit, "voucherBaseCredit");
    const ledgerDebit = decimal(row.ledgerBaseDebit, "ledgerBaseDebit");
    const ledgerCredit = decimal(row.ledgerBaseCredit, "ledgerBaseCredit");

    const expectation = row.ledgerExpectation ?? "balanced";
    if (expectation === "unclassified") {
      discrepancies.push({
        domain: "accounting",
        identity,
        code: "VOUCHER_TYPE_UNCLASSIFIED",
        expected: "a classified ledger expectation",
        actual: "unclassified",
      });
    } else if (expectation === "balanced") {
      compare(discrepancies, "accounting", identity, "VOUCHER_LEDGER_DEBIT_MISMATCH", voucherDebit, ledgerDebit);
      compare(discrepancies, "accounting", identity, "VOUCHER_LEDGER_CREDIT_MISMATCH", voucherCredit, ledgerCredit);
      compare(discrepancies, "accounting", identity, "VOUCHER_NOT_BALANCED", voucherDebit, voucherCredit);
      compare(discrepancies, "accounting", identity, "LEDGER_NOT_BALANCED", ledgerDebit, ledgerCredit);
    } else if (expectation === "balanced-only") {
      // Credit/Debit Notes can have a refund/receipt header that differs from
      // inventory cost. The variance account closes the journal at inventory
      // value, so only the actual ledger balance is invariant here.
      compare(discrepancies, "accounting", identity, "LEDGER_NOT_BALANCED", ledgerDebit, ledgerCredit);
    } else if (expectation === "single-sided") {
      const debitPosted = !ledgerDebit.isZero();
      const creditPosted = !ledgerCredit.isZero();
      if (debitPosted === creditPosted) {
        discrepancies.push({
          domain: "accounting",
          identity,
          code: "SINGLE_SIDED_LEDGER_INVALID",
          expected: "exactly one posted ledger side",
          actual: debitPosted ? "both sides posted" : "no side posted",
        });
      }
    } else if (expectation === "inventory-sided") {
      // Mixed stock documents can legitimately post both GL sides with inventory
      // carrying the net contra. They still must contain accounting evidence.
      if (ledgerDebit.isZero() && ledgerCredit.isZero()) {
        discrepancies.push({
          domain: "accounting",
          identity,
          code: "INVENTORY_SIDED_LEDGER_EMPTY",
          expected: "at least one posted ledger side",
          actual: "no ledger entries",
        });
      }
    } else if (expectation === "none" && (!ledgerDebit.isZero() || !ledgerCredit.isZero())) {
      discrepancies.push({
        domain: "accounting",
        identity,
        code: "NO_LEDGER_VOUCHER_HAS_ENTRIES",
        expected: "0 debit / 0 credit",
        actual: `${ledgerDebit.toFixed()} / ${ledgerCredit.toFixed()}`,
      });
    }

    if (row.expectsDaybook) {
      if (row.daybookBaseAmount == null) {
        discrepancies.push({
          domain: "accounting",
          identity,
          code: "DAYBOOK_MISSING",
          expected: voucherDebit.toFixed(),
          actual: "missing",
        });
      } else {
        compare(
          discrepancies,
          "accounting",
          identity,
          "DAYBOOK_AMOUNT_MISMATCH",
          voucherDebit,
          decimal(row.daybookBaseAmount, "daybookBaseAmount")
        );
      }
    } else if (row.daybookBaseAmount != null) {
      discrepancies.push({
        domain: "accounting",
        identity,
        code: "DAYBOOK_UNEXPECTED",
        expected: "missing",
        actual: decimal(row.daybookBaseAmount, "daybookBaseAmount").toFixed(),
      });
    }
  }

  for (const row of stock) {
    if (positiveId(row.companyId, "stock.companyId") !== companyId) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_COMPANY_MISMATCH",
        `Stock snapshot ${row.sourceType}:${row.sourceId} crossed the transaction company boundary`
      );
    }

    const sourceType = requiredIdentityPart(row.sourceType, "stock.sourceType");
    const sourceId = requiredIdentityPart(row.sourceId, "stock.sourceId");
    const identity = `${sourceType}:${sourceId}`;
    assertUniqueIdentity(stockIdentities, identity, "inventory");

    compare(
      discrepancies,
      "inventory",
      identity,
      "STOCK_QUANTITY_MISMATCH",
      decimal(row.documentQuantity, "documentQuantity"),
      decimal(row.movementQuantity, "movementQuantity")
    );
    compare(
      discrepancies,
      "inventory",
      identity,
      "STOCK_VALUE_MISMATCH",
      decimal(row.documentValue, "documentValue"),
      decimal(row.movementValue, "movementValue")
    );
  }

  return {
    companyId,
    accountingSnapshots: accounting.length,
    stockSnapshots: stock.length,
    discrepancies,
    clean: discrepancies.length === 0,
  };
}
