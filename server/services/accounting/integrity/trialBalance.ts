/**
 * Trial balance over the whole ledger of one company.
 *
 * The 2026-10 accounting audit found no trial-balance route, and the reports in
 * use mixed ledger balances with operational tables and hid the difference with
 * a stored plug. This report is built from posted lines and opening balances
 * only, and it never forces balance: whatever does not balance is shown as an
 * explicit, decomposed difference.
 *
 * Its rows come from the one balance engine (balances/ledgerBalanceEngine.ts,
 * wave 10), which getPartyBalances shares, so a party's row here is exactly
 * its per-party balance. The engine's rules, in short:
 *   - posted lines of vouchers of the company that are not deleted and not
 *     optional, booked (COALESCE(effective_date, voucher_date)) on or before
 *     `asOf` when given; each line attributed to exactly one row by target
 *     priority ledger > bank > fixed asset > supplier > employee > factory
 *     supplier > customer, a line on a customer's linked ledger account
 *     rolling up into that customer;
 *   - opening balances owned by master records (ledger accounts not linked to
 *     a customer, banks, fixed assets, suppliers, employees, factory
 *     suppliers, every customer). Openings are not journal entries in this
 *     system, so they are reported as their own column and their imbalance as
 *     its own component.
 *
 * Amounts are the posted base amounts (`debit_amount` / `credit_amount`); a
 * line with both a debit and a credit contributes its net.
 */
import { sql } from "drizzle-orm";

import { db, type DatabaseOrTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import type Decimal from "decimal.js";
import { classifyVoucherLedgerExpectation } from "../voucherLedgerExpectation";
import { liveVouchersOf, loadBalanceRows, type BalanceRowKind } from "../balances/ledgerBalanceEngine";

export type TrialBalanceRowKind = BalanceRowKind;

export interface TrialBalanceRow {
  kind: TrialBalanceRowKind;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  deleted: boolean;
  /** For a customer: the ledger account whose lines are included in this row. */
  linkedLedgerAccountId: number | null;
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
}

export interface TrialBalanceReport {
  companyId: number;
  asOf: string | null;
  rows: TrialBalanceRow[];
  totals: {
    openingDebit: string;
    openingCredit: string;
    periodDebit: string;
    periodCredit: string;
    closingDebit: string;
    closingCredit: string;
  };
  balanced: boolean;
  /** closingDebit − closingCredit. Never plugged. */
  unexplainedDifference: string;
  /** Where the difference comes from; the components add up to unexplainedDifference. */
  differenceComponents: {
    openingBalances: string;
    singleSidedStockVouchers: string;
    otherUnbalancedVouchers: string;
  };
  openingSidesAssumed: number;
}

interface RawVoucherDiffRow {
  voucher_type: string;
  diff: string | null;
}

const ZERO = new MoneyDecimal(0);

function splitSigned(value: Decimal): { debit: Decimal; credit: Decimal } {
  return value.isNegative() ? { debit: ZERO, credit: value.negated() } : { debit: value, credit: ZERO };
}

function money(value: Decimal): string {
  return value.toFixed(2);
}

export async function buildTrialBalance(
  companyId: number,
  asOf: string | null,
  executor: DatabaseOrTransaction = db
): Promise<TrialBalanceReport> {
  const balanceRows = await loadBalanceRows(executor, { companyId, asOf });

  const voucherDiffRows = await executor.execute<RawVoucherDiffRow & Record<string, unknown>>(sql`
    SELECT v.voucher_type, SUM(ve.debit_amount - ve.credit_amount)::text AS diff
      FROM vouchers v
      JOIN voucher_entries ve ON ve.voucher_id = v.id
     WHERE v.company_id = ${companyId} AND ${liveVouchersOf(companyId, asOf)}
     GROUP BY v.id, v.voucher_type
    HAVING SUM(ve.debit_amount) <> SUM(ve.credit_amount)
  `);

  let openingSidesAssumed = 0;
  const totals = { od: ZERO, oc: ZERO, pd: ZERO, pc: ZERO, cd: ZERO, cc: ZERO };
  let openingNet = ZERO;
  const out: TrialBalanceRow[] = [];
  for (const row of balanceRows) {
    if (row.openingSideAssumed) openingSidesAssumed += 1;
    const { masterOpening: opening, periodDebit: dr, periodCredit: cr } = row;
    if (opening.isZero() && dr.isZero() && cr.isZero()) continue;
    const o = splitSigned(opening);
    const c = splitSigned(opening.plus(dr).minus(cr));
    totals.od = totals.od.plus(o.debit);
    totals.oc = totals.oc.plus(o.credit);
    totals.pd = totals.pd.plus(dr);
    totals.pc = totals.pc.plus(cr);
    totals.cd = totals.cd.plus(c.debit);
    totals.cc = totals.cc.plus(c.credit);
    openingNet = openingNet.plus(opening);
    out.push({
      kind: row.kind,
      id: row.id,
      code: row.code,
      name: row.name,
      accountType: row.accountType,
      deleted: row.deleted,
      linkedLedgerAccountId: row.linkedLedgerAccountId,
      openingDebit: money(o.debit),
      openingCredit: money(o.credit),
      periodDebit: money(dr),
      periodCredit: money(cr),
      closingDebit: money(c.debit),
      closingCredit: money(c.credit),
    });
  }
  out.sort((a, b) => a.kind.localeCompare(b.kind) || (a.code ?? a.name).localeCompare(b.code ?? b.name));

  let singleSided = ZERO;
  let otherUnbalanced = ZERO;
  for (const row of voucherDiffRows.rows) {
    const expectation = classifyVoucherLedgerExpectation(row.voucher_type);
    const diff = toMoney(row.diff);
    if (expectation === "single-sided" || expectation === "inventory-sided") singleSided = singleSided.plus(diff);
    else otherUnbalanced = otherUnbalanced.plus(diff);
  }

  const difference = totals.cd.minus(totals.cc);
  return {
    companyId,
    asOf,
    rows: out,
    totals: {
      openingDebit: money(totals.od),
      openingCredit: money(totals.oc),
      periodDebit: money(totals.pd),
      periodCredit: money(totals.pc),
      closingDebit: money(totals.cd),
      closingCredit: money(totals.cc),
    },
    balanced: difference.isZero(),
    unexplainedDifference: money(difference),
    differenceComponents: {
      openingBalances: money(openingNet),
      singleSidedStockVouchers: money(singleSided),
      otherUnbalancedVouchers: money(otherUnbalanced),
    },
    openingSidesAssumed,
  };
}
