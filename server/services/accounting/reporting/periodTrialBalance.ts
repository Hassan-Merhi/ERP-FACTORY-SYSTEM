/**
 * Period trial balance with comparatives (accounting audit phase 27, RP-7/RP-8).
 *
 * The as-of trial balance (integrity/trialBalance.ts) reports openings,
 * every movement to the date and the closing. A period trial balance reports,
 * for each engine row, the balance at the start of the period (master opening
 * plus the movements booked before `from`), the period's debits and credits
 * and the closing at `to`, on the same engine scan (loadBalanceRows with
 * `from`), so each closing equals the as-of trial balance's at `to`.
 *
 * Comparatives (`compare`):
 *   - "priorPeriod": the period of the same length ending the day before `from`;
 *   - "priorYear": the same dates one year earlier;
 * each row carries the comparative period's movement and closing, matched by
 * row (kind and id); a row only in the comparative is listed with zeros now.
 *
 * Dates: `to` defaults to the company's business date; `from` to the first
 * day of its fiscal year (calendar year). The response flags the live vouchers
 * booked after the business date (reportDates.ts) so future-dated lines are
 * visible.
 */
import type Decimal from "decimal.js";

import { db, type DatabaseOrTransaction } from "../../../db";
import { MoneyDecimal } from "../../../lib/money";
import { loadBalanceRows, type BalanceRow } from "../balances/ledgerBalanceEngine";
import { fiscalYearStart, priorPeriod, sameDateLastYear } from "./classificationMap";
import { futureDatedVouchers, resolveReportDate, type FutureDatedSummary } from "./reportDates";

export type TrialBalanceComparison = "none" | "priorPeriod" | "priorYear";
export const TRIAL_BALANCE_COMPARISONS: readonly TrialBalanceComparison[] = ["none", "priorPeriod", "priorYear"];

export interface PeriodTrialBalanceColumns {
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
}

export interface PeriodTrialBalanceRow extends PeriodTrialBalanceColumns {
  kind: string;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  deleted: boolean;
  comparative: PeriodTrialBalanceColumns | null;
}

export interface PeriodTrialBalance {
  companyId: number;
  from: string;
  to: string;
  /** True when `to` was not given and the business date was used. */
  toDefaulted: boolean;
  comparison: TrialBalanceComparison;
  comparativePeriod: { from: string; to: string } | null;
  rows: PeriodTrialBalanceRow[];
  totals: PeriodTrialBalanceColumns;
  comparativeTotals: PeriodTrialBalanceColumns | null;
  /** closingDebit − closingCredit; never plugged. */
  unexplainedDifference: string;
  balanced: boolean;
  futureDated: FutureDatedSummary;
}

const ZERO = new MoneyDecimal(0);

function split(value: Decimal): { debit: Decimal; credit: Decimal } {
  return value.isNegative() ? { debit: ZERO, credit: value.negated() } : { debit: value, credit: ZERO };
}

interface Accumulator {
  od: Decimal;
  oc: Decimal;
  pd: Decimal;
  pc: Decimal;
  cd: Decimal;
  cc: Decimal;
}

function emptyAccumulator(): Accumulator {
  return { od: ZERO, oc: ZERO, pd: ZERO, pc: ZERO, cd: ZERO, cc: ZERO };
}

function columnsOf(row: BalanceRow, totals: Accumulator): PeriodTrialBalanceColumns {
  const opening = row.masterOpening.plus(row.carriedForward);
  const o = split(opening);
  const c = split(opening.plus(row.periodDebit).minus(row.periodCredit));
  totals.od = totals.od.plus(o.debit);
  totals.oc = totals.oc.plus(o.credit);
  totals.pd = totals.pd.plus(row.periodDebit);
  totals.pc = totals.pc.plus(row.periodCredit);
  totals.cd = totals.cd.plus(c.debit);
  totals.cc = totals.cc.plus(c.credit);
  return {
    openingDebit: o.debit.toFixed(2),
    openingCredit: o.credit.toFixed(2),
    periodDebit: row.periodDebit.toFixed(2),
    periodCredit: row.periodCredit.toFixed(2),
    closingDebit: c.debit.toFixed(2),
    closingCredit: c.credit.toFixed(2),
  };
}

function totalsOf(totals: Accumulator): PeriodTrialBalanceColumns {
  return {
    openingDebit: totals.od.toFixed(2),
    openingCredit: totals.oc.toFixed(2),
    periodDebit: totals.pd.toFixed(2),
    periodCredit: totals.pc.toFixed(2),
    closingDebit: totals.cd.toFixed(2),
    closingCredit: totals.cc.toFixed(2),
  };
}

const ZERO_COLUMNS: PeriodTrialBalanceColumns = {
  openingDebit: "0.00",
  openingCredit: "0.00",
  periodDebit: "0.00",
  periodCredit: "0.00",
  closingDebit: "0.00",
  closingCredit: "0.00",
};

function isEmpty(row: BalanceRow): boolean {
  return row.masterOpening.plus(row.carriedForward).isZero() && row.periodDebit.isZero() && row.periodCredit.isZero();
}

const rowKey = (row: { kind: string; id: number | null }) => `${row.kind}:${row.id ?? "-"}`;

export interface PeriodTrialBalanceQuery {
  companyId: number;
  from?: string | null;
  to?: string | null;
  compare?: TrialBalanceComparison;
  executor?: DatabaseOrTransaction;
}

export async function buildPeriodTrialBalance(query: PeriodTrialBalanceQuery): Promise<PeriodTrialBalance> {
  const executor = query.executor ?? db;
  const { companyId } = query;
  const resolved = await resolveReportDate(companyId, query.to ?? null, executor);
  const to = resolved.asOf;
  const from = query.from ?? fiscalYearStart(to);
  if (from > to) throw new RangeError("Period start is after its end");
  const comparison = query.compare ?? "none";
  const comparativePeriod =
    comparison === "priorPeriod"
      ? priorPeriod(from, to)
      : comparison === "priorYear"
        ? { from: sameDateLastYear(from), to: sameDateLastYear(to) }
        : null;

  const [rows, comparativeRows, futureDated] = await Promise.all([
    loadBalanceRows(executor, { companyId, asOf: to, from }),
    comparativePeriod
      ? loadBalanceRows(executor, { companyId, asOf: comparativePeriod.to, from: comparativePeriod.from })
      : Promise.resolve([] as BalanceRow[]),
    futureDatedVouchers(companyId, resolved.businessDate, executor),
  ]);

  const totals = emptyAccumulator();
  const compareTotals = emptyAccumulator();
  const comparativeByKey = new Map<string, PeriodTrialBalanceColumns>();
  const comparativeOnly = new Map<string, BalanceRow>();
  for (const row of comparativeRows) {
    if (isEmpty(row)) continue;
    comparativeByKey.set(rowKey(row), columnsOf(row, compareTotals));
    comparativeOnly.set(rowKey(row), row);
  }

  const out: PeriodTrialBalanceRow[] = [];
  for (const row of rows) {
    const key = rowKey(row);
    const comparative = comparativePeriod ? (comparativeByKey.get(key) ?? ZERO_COLUMNS) : null;
    if (isEmpty(row) && !comparativeByKey.has(key)) continue;
    comparativeOnly.delete(key);
    out.push({
      kind: row.kind,
      id: row.id,
      code: row.code,
      name: row.name,
      accountType: row.accountType,
      deleted: row.deleted,
      ...columnsOf(row, totals),
      comparative,
    });
  }
  for (const row of comparativeOnly.values()) {
    out.push({
      kind: row.kind,
      id: row.id,
      code: row.code,
      name: row.name,
      accountType: row.accountType,
      deleted: row.deleted,
      ...ZERO_COLUMNS,
      comparative: comparativeByKey.get(rowKey(row)) ?? ZERO_COLUMNS,
    });
  }
  out.sort((a, b) => a.kind.localeCompare(b.kind) || (a.code ?? a.name).localeCompare(b.code ?? b.name));

  const difference = totals.cd.minus(totals.cc);
  return {
    companyId,
    from,
    to,
    toDefaulted: resolved.defaulted,
    comparison,
    comparativePeriod,
    rows: out,
    totals: totalsOf(totals),
    comparativeTotals: comparativePeriod ? totalsOf(compareTotals) : null,
    unexplainedDifference: difference.toFixed(2),
    balanced: difference.isZero(),
    futureDated,
  };
}
