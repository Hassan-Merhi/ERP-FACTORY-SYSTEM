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
 *     factory writers store it), never a current rate. A voucher whose own
 *     rate was never set is rated, per line, at the factory's confirmed rate
 *     for its currency ON OR BEFORE the voucher date (wave 14, owner decision
 *     1; wave 17 C, owner decision 4, repairRateFor: a rate dated exactly on
 *     the voucher date, manual or auto, first; else the latest manual rate on
 *     or before it, else the latest recorded auto rate; never a rate dated
 *     after the voucher). Such a line is only
 *     repaired when it holds the native amount (the voucher total): with an
 *     unset rate the writers stored native amounts on every leg. Each line
 *     shows its rate and the rate's source ("line", "dated-manual",
 *     "dated-auto"); a line with no rate at all stays listed and untouched;
 *   - the plan is read-only and carries a hash of what it would change;
 *     applying it requires an explicit confirmation and the reviewed hash
 *     (wave 17 C: required, 400 without it), refuses a plan that no longer
 *     matches it (for example after a rate was added), re-derives the plan inside the
 *     transaction, changes only lines that are still legacy, and writes its
 *     audit in that transaction. The voucher-entry currency trigger validates
 *     every converted line, and the closed-period guard is not bypassed.
 *
 * Factory supplier balances are not affected: they are computed from the
 * container, charge and payment tables, and their voucher-payment readers
 * exclude FACTORY-PAY vouchers. What changes is the USD figure of these lines
 * in the general ledger (expense, payable and cash accounts, trial balance).
 */
import { createHash } from "node:crypto";

import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db, type DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { writeAuditEvent, type AuditActor } from "../audit";
import {
  findFactoryFxRateOnOrBefore,
  storedFactoryFxRateOnOrBefore,
  type FactoryFxRateOnDate,
} from "./factoryFxRateOnDate";

type Executor = typeof db | DbTransaction;

export type LegacyLineKind = "native" | "usd";

/** Where a line's rate comes from: its voucher, or the factory rate on or before the voucher date. */
export type LegacyRateSource = "line" | "dated-manual" | "dated-auto";

export type LegacySkipReason =
  "RATE_NOT_SET" | "PERIOD_CLOSED" | "AMOUNT_NOT_RECOGNISED" | "AMOUNT_AMBIGUOUS" | "OTHER_LINE_NOT_REPAIRABLE";

export interface LegacyLinePlan {
  entryId: number;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  currency: string;
  /** The rate the line is converted at (USD per unit, 10 places); the voucher's own when there is none. */
  rate: string;
  rateSource: LegacyRateSource | null;
  /** For a dated factory rate, the date it applies from. */
  rateEffectiveDate: string | null;
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
  /** Lines converted at a dated factory rate (their voucher had no rate of its own). */
  datedRateLines: number;
  /** sha256 of what the apply would change; the apply refuses a different plan when given it. */
  planHash: string;
  lines: LegacyLinePlan[];
}

/** The plan re-derived inside the apply no longer matches the reviewed one. */
export class FactoryFxRepairPlanChangedError extends Error {
  readonly code = "FACTORY_FX_REPAIR_PLAN_CHANGED";
  constructor() {
    super("The repair plan changed since it was reviewed; review it again before applying");
  }
}

/** The apply was called without the reviewed plan's hash. */
export class FactoryFxRepairPlanHashRequiredError extends Error {
  readonly code = "FACTORY_FX_REPAIR_PLAN_HASH_REQUIRED";
  constructor() {
    super("The reviewed plan's planHash is required to apply the repair");
  }
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
           -- A voucher counts from its effective date (wave 10), so the closed
           -- period check reads COALESCE(effective_date, voucher_date) (wave 17 C).
           COALESCE(COALESCE(v.effective_date, v.voucher_date) <= (
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

/** A usable rate stored on the voucher itself: positive and not the column default 1. */
function ownRate(row: LegacyRow): Decimal | null {
  const rate = toMoney(row.exchange_rate ?? 0).toDecimalPlaces(10);
  // Factory currencies are never pegged 1:1 to USD; a stored 1 is the
  // column default, i.e. a rate nobody set.
  return rate.gt(0) && !rate.eq(1) ? rate : null;
}

function classify(row: LegacyRow, dated: FactoryFxRateOnDate | null): LegacyLinePlan {
  const debit = toMoney(row.debit_amount ?? 0);
  const credit = toMoney(row.credit_amount ?? 0);
  const side: "debit" | "credit" = debit.gt(0) ? "debit" : "credit";
  const amount = side === "debit" ? debit : credit;
  const own = ownRate(row);
  const datedRate = !own && dated && toMoney(dated.rate).gt(0) ? toMoney(dated.rate).toDecimalPlaces(10) : null;
  const rate = own ?? datedRate ?? toMoney(row.exchange_rate ?? 0).toDecimalPlaces(10);
  const total = toMoney(row.total_amount ?? 0);
  const plan: LegacyLinePlan = {
    entryId: row.id,
    voucherId: row.voucher_id,
    voucherNumber: row.voucher_number,
    voucherDate: row.voucher_date,
    currency: row.currency,
    rate: rate.toFixed(10),
    rateSource: own ? "line" : datedRate ? (dated!.source === "manual" ? "dated-manual" : "dated-auto") : null,
    rateEffectiveDate: datedRate ? dated!.effectiveDate : null,
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
  if (!own && !datedRate) return { ...plan, skipReason: "RATE_NOT_SET" };
  if (row.period_closed) return { ...plan, skipReason: "PERIOD_CLOSED" };

  const isNative = amount.eq(total);
  // With no rate of its own, a writer stored the native amount on every leg
  // (an own-account leg's "USD" was native × 1), so only the native shape is
  // recognised at a dated rate.
  const isUsd = own ? amount.eq(cents(total.times(rate))) : false;
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

/**
 * The rate the repair uses for a voucher with no usable rate of its own
 * (wave 17 C, owner decision 4): a rate dated exactly on the voucher date,
 * manual or recorded auto (manual first), beats an older manual rate, since it
 * is the market rate of that day; otherwise the confirmed rate on or before
 * the date as before (findFactoryFxRateOnOrBefore: the latest manual rate,
 * else the latest recorded auto rate). A rate dated after the voucher is never
 * used.
 */
async function repairRateFor(
  executor: Executor,
  companyId: number,
  currency: string,
  voucherDate: string
): Promise<FactoryFxRateOnDate | null> {
  for (const source of ["manual", "auto"] as const) {
    const exact = await storedFactoryFxRateOnOrBefore(executor, companyId, currency, voucherDate, source);
    if (exact && exact.effectiveDate === voucherDate) return exact;
  }
  return findFactoryFxRateOnOrBefore(executor, companyId, currency, voucherDate);
}

/**
 * The dated factory rate for every (currency, voucher date) whose voucher has
 * no usable rate of its own, read with the plan's executor.
 */
async function datedRatesFor(
  executor: Executor,
  companyId: number,
  rows: LegacyRow[]
): Promise<Map<string, FactoryFxRateOnDate | null>> {
  const rates = new Map<string, FactoryFxRateOnDate | null>();
  for (const row of rows) {
    if (ownRate(row)) continue;
    const key = `${row.currency}|${row.voucher_date}`;
    if (rates.has(key)) continue;
    rates.set(key, await repairRateFor(executor, companyId, row.currency, row.voucher_date));
  }
  return rates;
}

function planHashOf(lines: LegacyLinePlan[]): string {
  const changes = lines
    .filter((line) => !line.skipReason)
    .map((line) => [line.entryId, line.side, line.rate, line.rateSource, line.transactionAmount, line.baseAmount]);
  return createHash("sha256").update(JSON.stringify(changes)).digest("hex");
}

function buildPlan(
  companyId: number,
  rows: LegacyRow[],
  datedRates: Map<string, FactoryFxRateOnDate | null>
): LegacyRepairPlan {
  const classified = rows.map((row) => classify(row, datedRates.get(`${row.currency}|${row.voucher_date}`) ?? null));
  // A voucher is repaired whole or not at all.
  const blockedVouchers = new Set(classified.filter((line) => line.skipReason).map((line) => line.voucherId));
  const lines = classified.map((line): LegacyLinePlan =>
    !line.skipReason && blockedVouchers.has(line.voucherId)
      ? {
          ...line,
          kind: null,
          skipReason: "OTHER_LINE_NOT_REPAIRABLE",
          transactionAmount: null,
          baseAmount: null,
          newStoredAmount: null,
          usdChange: null,
        }
      : line
  );
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
    datedRateLines: repairable.filter((line) => line.rateSource !== "line").length,
    planHash: planHashOf(lines),
    lines,
  };
}

async function derivePlan(executor: Executor, companyId: number, lock: boolean): Promise<LegacyRepairPlan> {
  const rows = await loadLegacyRows(executor, companyId, lock);
  return buildPlan(companyId, rows, await datedRatesFor(executor, companyId, rows));
}

/** Read-only: what the repair would do for one company. */
export async function planFactoryFxLegacyRepair(companyId: number, executor: Executor = db): Promise<LegacyRepairPlan> {
  return derivePlan(executor, companyId, false);
}

export interface ApplyFactoryFxRepairOptions {
  /** Who applies it; the audit row is written in the apply transaction. */
  actor?: AuditActor & { userId: string | number };
  /** The reviewed plan's hash (required): the apply refuses a plan that no longer matches it. */
  expectedPlanHash: string;
}

/**
 * Converts the repairable lines in one transaction, from a plan re-derived
 * under row locks, and audits them in that transaction. Returns that plan.
 */
export async function applyFactoryFxLegacyRepair(
  companyId: number,
  options: ApplyFactoryFxRepairOptions
): Promise<LegacyRepairPlan> {
  if (!options?.expectedPlanHash) throw new FactoryFxRepairPlanHashRequiredError();
  return db.transaction(async (tx) => {
    const plan = await derivePlan(tx, companyId, true);
    if (options.expectedPlanHash !== plan.planHash) {
      throw new FactoryFxRepairPlanChangedError();
    }
    const repaired = plan.lines.filter((line) => !line.skipReason && line.transactionAmount && line.baseAmount);
    for (const line of repaired) {
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
    if (options.actor && repaired.length > 0) {
      await writeAuditEvent(
        {
          ...options.actor,
          companyId,
          action: "update",
          tableName: "voucher_entries",
          recordIdentifier: "factory-fx-legacy-repair",
          changes: {
            lines: {
              old: repaired.map((line) => ({ id: line.entryId, amount: line.storedAmount })),
              new: repaired.map((line) => ({
                id: line.entryId,
                amount: line.newStoredAmount,
                native: `${line.currency} ${line.transactionAmount}`,
                rate: line.rate,
                rateSource: line.rateSource,
                rateEffectiveDate: line.rateEffectiveDate,
              })),
            },
            // writeAuditEvent keeps `metadata` only without `changes`, so these are change fields.
            planHash: { new: plan.planHash },
            usdChangeByTarget: { new: plan.usdChangeByTarget },
          },
        },
        tx
      );
    }
    return plan;
  });
}
