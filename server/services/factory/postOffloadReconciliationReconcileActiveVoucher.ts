// Extracted from ./postOffloadReconciliation.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { normalizeFactoryVoucherEntryAmounts } from "./factoryVoucherEntryAmounts";
import type {
  ChargeRow,
  VoucherRow,
  VoucherEntryRow,
  DaybookRow,
  ReconciliationQueryClient,
} from "./postOffloadReconciliationReconcileActiveVoucherTypes";
export type {
  PostOffloadReconciliationStatus,
  PostOffloadReconciliationResult,
  ChargeRow,
  ReconciliationQueryClient,
} from "./postOffloadReconciliationReconcileActiveVoucherTypes";

export const POST_OFFLOAD_REPORT_QUERY_KEYS = [
  "/api/factory/containers",
  "/api/factory/raw-stock",
  "/api/factory/raw-stock/by-container",
  "/api/factory/mix-batches",
  "/api/factory/bales",
  "/api/factory/bale-ledger",
  "/api/factory/suppliers",
  "/api/factory/suppliers/with-balances",
  "/api/factory/production-value-report",
  "/api/factory/daybook",
  "/api/accounts/all",
  "/api/vouchers",
] as const;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseDecimal(value: string | number | null | undefined, fallback = "0"): Decimal {
  try {
    const parsed = new Decimal(value ?? fallback);
    return parsed.isFinite() ? parsed : new Decimal(fallback);
  } catch {
    return new Decimal(fallback);
  }
}

export function closeEnough(left: Decimal, right: Decimal, tolerance = "0.000001"): boolean {
  return left.minus(right).abs().lte(new Decimal(tolerance));
}

export function metadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function uniqueIssues(values: string[]): string[] {
  return [...new Set(values)];
}

export async function loadDaybook(client: ReconciliationQueryClient, id: number | null): Promise<DaybookRow | null> {
  if (!id) return null;
  const result = await client.query<DaybookRow>(
    `SELECT id, company_id, tx_type, reference_id, amount_currency,
            fx_rate_to_usd, amount_usd, meta_json
     FROM factory_daybook_entries
     WHERE id = $1
     FOR UPDATE`,
    [id]
  );
  return result.rows[0] ?? null;
}

export function verifyOriginalDaybook(params: {
  row: DaybookRow | null;
  companyId: number;
  containerId: number;
  charge: ChargeRow;
  issues: string[];
}): void {
  const { row, companyId, containerId, charge, issues } = params;
  if (!row) {
    issues.push(`charge ${charge.id}: original daybook entry is missing`);
    return;
  }

  const amount = parseDecimal(charge.amount);
  const fxRate = parseDecimal(charge.fx_rate_to_usd);
  const expectedUsd = amount.times(fxRate);
  const meta = metadata(row.meta_json);

  if (row.company_id !== companyId || row.reference_id !== containerId || row.tx_type !== "OTHER_CHARGE") {
    issues.push(`charge ${charge.id}: original daybook scope or type does not match the charge`);
  }
  if (meta.sourceType !== "POST_OFFLOAD_ADDITIONAL" || Number(meta.chargeId) !== charge.id) {
    issues.push(`charge ${charge.id}: original daybook metadata does not identify the charge`);
  }
  if (!closeEnough(parseDecimal(row.amount_currency), amount, "0.01")) {
    issues.push(`charge ${charge.id}: original daybook transaction amount does not reconcile`);
  }
  if (!closeEnough(parseDecimal(row.fx_rate_to_usd), fxRate, "0.000001")) {
    issues.push(`charge ${charge.id}: original daybook FX rate does not reconcile`);
  }
  if (!closeEnough(parseDecimal(row.amount_usd), expectedUsd, "0.01")) {
    issues.push(`charge ${charge.id}: original daybook USD amount does not reconcile`);
  }
}

export async function reconcileActiveVoucher(params: {
  client: ReconciliationQueryClient;
  charge: ChargeRow;
  accountingIssues: string[];
}): Promise<{ voucherChecked: boolean; entriesNormalized: number }> {
  const { client, charge, accountingIssues } = params;
  const hasAccountingTarget = Boolean(charge.ledger_account_id || charge.supplier_id);

  if (!charge.voucher_id) {
    if (hasAccountingTarget) {
      accountingIssues.push(`charge ${charge.id}: active accounting target has no linked voucher`);
    }
    return { voucherChecked: false, entriesNormalized: 0 };
  }

  const voucherResult = await client.query<VoucherRow>(
    `SELECT id, company_id, total_amount, currency, exchange_rate, source_module, deleted_at
     FROM vouchers
     WHERE id = $1
     FOR UPDATE`,
    [charge.voucher_id]
  );
  const voucher = voucherResult.rows[0];
  if (!voucher) {
    accountingIssues.push(`charge ${charge.id}: linked voucher ${charge.voucher_id} is missing`);
    return { voucherChecked: false, entriesNormalized: 0 };
  }
  if (!hasAccountingTarget) {
    if (!voucher.deleted_at) {
      accountingIssues.push(`charge ${charge.id}: voucher remains active without an accounting target`);
    }
    return { voucherChecked: true, entriesNormalized: 0 };
  }
  if (voucher.deleted_at) {
    accountingIssues.push(`charge ${charge.id}: linked voucher is deleted while the charge is active`);
    return { voucherChecked: true, entriesNormalized: 0 };
  }

  const amount = parseDecimal(charge.amount);
  const currency = String(charge.currency_code || "USD").toUpperCase();
  const fxRate = parseDecimal(charge.fx_rate_to_usd);
  if (amount.lte(0) || fxRate.lte(0)) {
    accountingIssues.push(`charge ${charge.id}: amount or FX rate is invalid`);
    return { voucherChecked: true, entriesNormalized: 0 };
  }
  if (voucher.source_module !== "FACTORY") {
    accountingIssues.push(`charge ${charge.id}: linked voucher is not owned by the factory module`);
  }
  if (String(voucher.currency || "").toUpperCase() !== currency) {
    accountingIssues.push(`charge ${charge.id}: voucher currency does not match the charge`);
  }
  if (!closeEnough(parseDecimal(voucher.total_amount), amount, "0.01")) {
    accountingIssues.push(`charge ${charge.id}: voucher total does not match the charge`);
  }
  if (!closeEnough(parseDecimal(voucher.exchange_rate), fxRate, "0.000001")) {
    accountingIssues.push(`charge ${charge.id}: voucher FX rate does not match the charge`);
  }

  const entriesResult = await client.query<VoucherEntryRow>(
    `SELECT id, ledger_account_id, factory_supplier_id, debit_amount, credit_amount,
            transaction_debit_amount, transaction_credit_amount
     FROM voucher_entries
     WHERE voucher_id = $1
     ORDER BY id
     FOR UPDATE`,
    [voucher.id]
  );
  if (entriesResult.rows.length !== 2) {
    accountingIssues.push(`charge ${charge.id}: voucher must contain exactly two entries`);
    return { voucherChecked: true, entriesNormalized: 0 };
  }

  let debitCount = 0;
  let creditCount = 0;
  let baseDebitTotal = new Decimal(0);
  let baseCreditTotal = new Decimal(0);
  let entriesNormalized = 0;

  for (const entry of entriesResult.rows) {
    const storedDebit = parseDecimal(entry.transaction_debit_amount ?? entry.debit_amount);
    const storedCredit = parseDecimal(entry.transaction_credit_amount ?? entry.credit_amount);
    const debitSide = storedDebit.gt(0) && !storedCredit.gt(0);
    const creditSide = storedCredit.gt(0) && !storedDebit.gt(0);
    if (!debitSide && !creditSide) {
      accountingIssues.push(`charge ${charge.id}: voucher entry ${entry.id} has an invalid debit/credit side`);
      continue;
    }

    if (debitSide) {
      debitCount += 1;
      if (!entry.ledger_account_id) {
        accountingIssues.push(`charge ${charge.id}: payable debit entry has no ledger account`);
      }
    } else {
      creditCount += 1;
      if (charge.ledger_account_id && entry.ledger_account_id !== charge.ledger_account_id) {
        accountingIssues.push(`charge ${charge.id}: credit ledger account does not match the charge`);
      }
      if (charge.supplier_id && !charge.ledger_account_id && entry.factory_supplier_id !== charge.supplier_id) {
        accountingIssues.push(`charge ${charge.id}: credit supplier does not match the charge`);
      }
    }

    const normalized = normalizeFactoryVoucherEntryAmounts({
      transactionCurrency: currency,
      transactionDebitAmount: debitSide ? amount.toFixed() : "0",
      transactionCreditAmount: creditSide ? amount.toFixed() : "0",
      fxRateToUsd: fxRate.toFixed(),
    });

    const updateResult = await client.query(
      `UPDATE voucher_entries
       SET debit_amount = $1,
           credit_amount = $2,
           transaction_currency = $3,
           transaction_debit_amount = $4,
           transaction_credit_amount = $5,
           base_debit_amount = $6,
           base_credit_amount = $7,
           historical_exchange_rate = $8,
           rate_convention = $9
       WHERE id = $10 AND voucher_id = $11`,
      [
        normalized.debitAmount,
        normalized.creditAmount,
        normalized.transactionCurrency,
        normalized.transactionDebitAmount,
        normalized.transactionCreditAmount,
        normalized.baseDebitAmount,
        normalized.baseCreditAmount,
        normalized.historicalExchangeRate,
        normalized.rateConvention,
        entry.id,
        voucher.id,
      ]
    );
    if (updateResult.rowCount !== 1) {
      accountingIssues.push(`charge ${charge.id}: voucher entry ${entry.id} was not normalized exactly once`);
      continue;
    }

    entriesNormalized += 1;
    baseDebitTotal = baseDebitTotal.plus(normalized.baseDebitAmount);
    baseCreditTotal = baseCreditTotal.plus(normalized.baseCreditAmount);
  }

  if (debitCount !== 1 || creditCount !== 1) {
    accountingIssues.push(`charge ${charge.id}: voucher does not have one debit and one credit entry`);
  }
  if (!closeEnough(baseDebitTotal, baseCreditTotal, "0.000001")) {
    accountingIssues.push(`charge ${charge.id}: normalized voucher base amounts do not balance`);
  }

  return { voucherChecked: true, entriesNormalized };
}
