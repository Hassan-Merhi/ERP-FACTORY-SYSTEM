/**
 * Ledger monthly summary and month detail on the one balance engine
 * (accounting audit phase 27, RP-9).
 *
 * Before, /api/reports/ledger-monthly-summary and /ledger-vouchers summed
 * every line naming the account by voucher_date, took a sideless opening as
 * Dr, read base amounts in one query and book amounts in the other, counted
 * the opening of a ledger linked to a customer, and built month boundaries
 * in the server's local time. Now:
 *   - the account's row is the engine's: a ledger account's own row, or, for
 *     a ledger linked to a customer, that customer's row (the engine's rule 1:
 *     the customer owns the account's lines and its opening is the
 *     customer's);
 *   - the opening at the start date and every closing are the engine's
 *     (loadBalanceRows with `from`), with its side rule for sideless openings;
 *   - month movements are the engine's owned lines (partyLineRules), booked on
 *     COALESCE(effective_date, voucher_date), in book amounts
 *     (debit_amount / credit_amount, as the engine), months as YYYY-MM strings.
 * The reports keep their credit-positive sign.
 */
import { sql, type SQL } from "drizzle-orm";
import type Decimal from "decimal.js";

import { db, type DatabaseOrTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { loadBalanceRows } from "../balances/ledgerBalanceEngine";
import { customerOwnedLinePredicate, intLiteral } from "../balances/partyLineRules";
import { addDays } from "./classificationMap";

export interface LedgerOwnership {
  kind: "ledger" | "customer";
  id: number;
  /** Predicate on the voucher_entries alias `ve`: the lines the engine counts for this row. */
  lines: SQL;
}

/** The engine row a ledger account's balance lives in. */
export async function ledgerOwnership(
  companyId: number,
  accountId: number,
  executor: DatabaseOrTransaction = db
): Promise<LedgerOwnership> {
  const result = await executor.execute<{ customer_id: number }>(sql`
    SELECT c.id AS customer_id FROM customers c
     WHERE c.company_id = ${companyId} AND c.ledger_account_id = ${accountId}
     ORDER BY c.id LIMIT 1
  `);
  const customerId = result.rows[0]?.customer_id;
  if (customerId !== undefined && customerId !== null) {
    return {
      kind: "customer",
      id: Number(customerId),
      lines: sql.raw(customerOwnedLinePredicate("ve", intLiteral(companyId), intLiteral(Number(customerId)))),
    };
  }
  return { kind: "ledger", id: accountId, lines: sql`ve.ledger_account_id = ${accountId}` };
}

/** Debit-positive engine balance of the row before `from` (its opening at `from`). */
export async function engineOpeningAt(
  companyId: number,
  owner: LedgerOwnership,
  from: string,
  executor: DatabaseOrTransaction = db
): Promise<Decimal> {
  const [row] = await loadBalanceRows(executor, {
    companyId,
    kind: owner.kind,
    ids: [owner.id],
    asOf: addDays(from, -1),
  });
  if (!row) return new MoneyDecimal(0);
  return row.masterOpening.plus(row.carriedForward).plus(row.periodDebit).minus(row.periodCredit);
}

export interface MonthMovement {
  yearMonth: string;
  debit: Decimal;
  credit: Decimal;
}

/** Owned-line movements per booked month in [from, to]. */
export async function monthlyMovements(
  companyId: number,
  owner: LedgerOwnership,
  from: string,
  to: string,
  executor: DatabaseOrTransaction = db
): Promise<Map<string, MonthMovement>> {
  const result = await executor.execute<{ year_month: string; debit: string; credit: string }>(sql`
    SELECT to_char(COALESCE(v.effective_date, v.voucher_date), 'YYYY-MM') AS year_month,
           COALESCE(SUM(GREATEST(COALESCE(ve.debit_amount, 0) - COALESCE(ve.credit_amount, 0), 0)), 0)::text AS debit,
           COALESCE(SUM(GREATEST(COALESCE(ve.credit_amount, 0) - COALESCE(ve.debit_amount, 0), 0)), 0)::text AS credit
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND v.optional = false
       AND COALESCE(v.effective_date, v.voucher_date) BETWEEN ${from}::date AND ${to}::date
       AND ${owner.lines}
     GROUP BY 1
  `);
  return new Map(
    result.rows.map((row) => [
      row.year_month,
      { yearMonth: row.year_month, debit: toMoney(row.debit), credit: toMoney(row.credit) },
    ])
  );
}

/** Every YYYY-MM from the month of `from` to the month of `to`. */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const endKey = to.slice(0, 7);
  for (let guard = 0; guard < 1200; guard += 1) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    months.push(key);
    if (key >= endKey) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/** Last day of a YYYY-MM month. */
export function monthEnd(yearMonth: string): string {
  const [year, month] = yearMonth.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}
