/**
 * Legacy factory foreign-currency lines (2026-10 accounting audit, wave 6).
 *
 * Factory vouchers in EUR, AUD and other non-USD currencies were posted with
 * the native amount in debit_amount/credit_amount (the USD base columns) and no
 * dual-currency fields, except their own-account legs, which carried USD. The
 * writers now post every leg normalized. This repairs the existing lines so the
 * ledger's USD columns hold USD:
 *
 *   - a line is classified from its own voucher: an amount equal to the
 *     voucher total is native; an amount equal to the total at the voucher's
 *     rate (rounded to cents) is already USD. Anything else, an amount matching
 *     both, a rate that was never set (0 or 1) or a voucher in a closed period
 *     is reported and left alone, and so is every other line of that voucher,
 *     so no voucher is ever half-converted;
 *   - the conversion uses the voucher's own stored rate (USD per unit, as the
 *     factory writers store it), never a current rate;
 *   - the plan is read-only; applying it requires an explicit confirmation,
 *     re-derives the plan inside the transaction, changes only lines that are
 *     still legacy, and is audited. The voucher-entry trigger validates every
 *     converted line, and the closed-period guard is not bypassed.
 *
 * Factory supplier balances are not affected: they are computed from the
 * container, charge and payment tables, and their voucher-payment readers
 * exclude FACTORY-PAY vouchers. What changes is the USD figure of these lines
 * in the general ledger (expense, payable and cash accounts, trial balance).
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db, type DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";

type Executor = typeof db | DbTransaction;

export type LegacyLineKind = "native" | "usd";

export type LegacySkipReason =
  "RATE_NOT_SET" | "PERIOD_CLOSED" | "AMOUNT_NOT_RECOGNISED" | "AMOUNT_AMBIGUOUS" | "OTHER_LINE_NOT_REPAIRABLE";

export interface LegacyLinePlan {
  entryId: number;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  currency: string;
  rate: string;
  target: string;
  side: "debit" | "credit";
  storedAmount: string;
  kind: LegacyLineKind | null;
  skipReason: LegacySkipReason | null;
  /** The native amount the line will carry. */
  transactionAmount: string | null;
  /** The USD base (6 places) the line will carry. */
  baseAmount: string | null;
  /** debit_amount/credit_amount after the repair (cents). */
  newStoredAmount: string | null;
  /** Change of this line's USD figure, signed debit-positive. */
  usdChange: string | null;
}

export interface LegacyRepairPlan {
  companyId: number;
  legacyLines: number;
  repairableLines: number;
  repairableVouchers: number;
  skippedLines: number;
  skippedByReason: Record<string, number>;
  /** Net change of the ledger's USD figures by target, debit-positive. */
  usdChangeByTarget: Record<string, string>;
  lines: LegacyLinePlan[];
}

interface LegacyRow {
  id: number;
  voucher_id: number;
  voucher_number: string;
  voucher_date: string;
  currency: string;
  exchange_rate: string | null;
  total_amount: string | null;
  debit_amount: string | null;
  credit_amount: string | null;
  ledger_account_id: number | null;
  bank_account_id: number | null;
  factory_supplier_id: number | null;
  supplier_id: number | null;
  employee_id: number | null;
  customer_id: number | null;
  fixed_asset_id: number | null;
  period_closed: boolean;
}

async function loadLegacyRows(executor: Executor, companyId: number, lock: boolean): Promise<LegacyRow[]> {
  const result = await executor.execute<LegacyRow & Record<string, unknown>>(sql`
    SELECT ve.id, ve.voucher_id, v.voucher_number, v.voucher_date::text AS voucher_date,
           UPPER(v.currency) AS currency, v.exchange_rate::text AS exchange_rate,
           v.total_amount::text AS total_amount,
           ve.debit_amount::text AS debit_amount, ve.credit_amount::text AS credit_amount,
           ve.ledger_account_id, ve.bank_account_id, ve.factory_supplier_id, ve.supplier_id,
           ve.employee_id, ve.customer_id, ve.fixed_asset_id,
           COALESCE(v.voucher_date <= (
             SELECT max(c.period_end_date) FROM fiscal_period_closures c
              WHERE c.company_id = v.company_id AND c.status = 'CLOSED'
           ), false) AS period_closed
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.company_id = ${companyId}
       AND v.source_module = 'FACTORY'
       AND UPPER(COALESCE(v.currency, 'USD')) <> 'USD'
       AND ve.transaction_currency IS NULL
     ORDER BY v.id, ve.id
     ${lock ? sql`FOR UPDATE OF ve` : sql``}
  `);
  return result.rows as unknown as LegacyRow[];
}

function targetOf(row: LegacyRow): string {
  if (row.factory_supplier_id) return `factorySupplier:${row.factory_supplier_id}`;
  if (row.customer_id) return `customer:${row.customer_id}`;
  if (row.supplier_id) return `supplier:${row.supplier_id}`;
  if (row.employee_id) return `employee:${row.employee_id}`;
  if (row.bank_account_id) return `bank:${row.bank_account_id}`;
  if (row.fixed_asset_id) return `fixedAsset:${row.fixed_asset_id}`;
  if (row.ledger_account_id) return `ledger:${row.ledger_account_id}`;
  return "none";
}

const cents = (value: Decimal) => value.toDecimalPlaces(2);
const base6 = (value: Decimal) => value.toDecimalPlaces(6);

function classify(row: LegacyRow): LegacyLinePlan {
  const debit = toMoney(row.debit_amount ?? 0);
  const credit = toMoney(row.credit_amount ?? 0);
  const side: "debit" | "credit" = debit.gt(0) ? "debit" : "credit";
  const amount = side === "debit" ? debit : credit;
  const rate = toMoney(row.exchange_rate ?? 0).toDecimalPlaces(10);
  const total = toMoney(row.total_amount ?? 0);
  const plan: LegacyLinePlan = {
    entryId: row.id,
    voucherId: row.voucher_id,
    voucherNumber: row.voucher_number,
    voucherDate: row.voucher_date,
    currency: row.currency,
    rate: rate.toFixed(10),
    target: targetOf(row),
    side,
    storedAmount: amount.toFixed(2),
    kind: null,
    skipReason: null,
    transactionAmount: null,
    baseAmount: null,
    newStoredAmount: null,
    usdChange: null,
  };
  // Factory currencies are never pegged 1:1 to USD; a stored 1 is the
  // column default, i.e. a rate nobody set.
  if (!rate.gt(0) || rate.eq(1)) return { ...plan, skipReason: "RATE_NOT_SET" };
  if (row.period_closed) return { ...plan, skipReason: "PERIOD_CLOSED" };

  const totalUsd = cents(total.times(rate));
  const isNative = amount.eq(total);
  const isUsd = amount.eq(totalUsd);
  if (isNative && isUsd) return { ...plan, skipReason: "AMOUNT_AMBIGUOUS" };
  if (!isNative && !isUsd) return { ...plan, skipReason: "AMOUNT_NOT_RECOGNISED" };

  const native = isNative ? amount : total;
  const base = base6(native.toDecimalPlaces(6).times(rate));
  const newStored = cents(base);
  const signed = (value: Decimal) => (side === "debit" ? value : value.negated());
  return {
    ...plan,
    kind: isNative ? "native" : "usd",
    transactionAmount: native.toDecimalPlaces(6).toFixed(6),
    baseAmount: base.toFixed(6),
    newStoredAmount: newStored.toFixed(2),
    usdChange: signed(newStored.minus(amount)).toFixed(2),
  };
}

function buildPlan(companyId: number, rows: LegacyRow[]): LegacyRepairPlan {
  const lines = rows.map(classify);
  // A voucher is repaired whole or not at all.
  const blockedVouchers = new Set(lines.filter((line) => line.skipReason).map((line) => line.voucherId));
  for (const line of lines) {
    if (!line.skipReason && blockedVouchers.has(line.voucherId)) {
      Object.assign(line, {
        kind: null,
        skipReason: "OTHER_LINE_NOT_REPAIRABLE",
        transactionAmount: null,
        baseAmount: null,
        newStoredAmount: null,
        usdChange: null,
      });
    }
  }
  const skippedByReason: Record<string, number> = {};
  const usdChange = new Map<string, Decimal>();
  for (const line of lines) {
    if (line.skipReason) {
      skippedByReason[line.skipReason] = (skippedByReason[line.skipReason] ?? 0) + 1;
    } else if (line.usdChange) {
      usdChange.set(line.target, (usdChange.get(line.target) ?? new MoneyDecimal(0)).plus(line.usdChange));
    }
  }
  const repairable = lines.filter((line) => !line.skipReason);
  return {
    companyId,
    legacyLines: lines.length,
    repairableLines: repairable.length,
    repairableVouchers: new Set(repairable.map((line) => line.voucherId)).size,
    skippedLines: lines.length - repairable.length,
    skippedByReason,
    usdChangeByTarget: Object.fromEntries(
      [...usdChange.entries()].filter(([, value]) => !value.isZero()).map(([key, value]) => [key, value.toFixed(2)])
    ),
    lines,
  };
}

/** Read-only: what the repair would do for one company. */
export async function planFactoryFxLegacyRepair(companyId: number, executor: Executor = db): Promise<LegacyRepairPlan> {
  return buildPlan(companyId, await loadLegacyRows(executor, companyId, false));
}

/**
 * Converts the repairable lines in one transaction, from a plan re-derived
 * under row locks. Returns that plan.
 */
export async function applyFactoryFxLegacyRepair(companyId: number): Promise<LegacyRepairPlan> {
  return db.transaction(async (tx) => {
    const plan = buildPlan(companyId, await loadLegacyRows(tx, companyId, true));
    for (const line of plan.lines) {
      if (line.skipReason || !line.transactionAmount || !line.baseAmount) continue;
      const debit = line.side === "debit";
      const updated = await tx.execute(sql`
        UPDATE voucher_entries
           SET transaction_currency = ${line.currency},
               transaction_debit_amount = ${debit ? line.transactionAmount : "0"},
               transaction_credit_amount = ${debit ? "0" : line.transactionAmount},
               base_debit_amount = ${debit ? line.baseAmount : "0"},
               base_credit_amount = ${debit ? "0" : line.baseAmount},
               historical_exchange_rate = ${line.rate},
               rate_convention = 'BASE_PER_TRANSACTION',
               debit_amount = ${debit ? line.baseAmount : "0"},
               credit_amount = ${debit ? "0" : line.baseAmount}
         WHERE id = ${line.entryId} AND transaction_currency IS NULL
      `);
      if (updated.rowCount !== 1) throw new Error("A legacy line changed during the repair; nothing was applied");
    }
    return plan;
  });
}
