/**
 * Trial balance over the whole ledger of one company.
 *
 * The 2026-10 accounting audit found no trial-balance route, and the reports in
 * use mixed ledger balances with operational tables and hid the difference with
 * a stored plug. This report is built from posted lines and opening balances
 * only, and it never forces balance: whatever does not balance is shown as an
 * explicit, decomposed difference.
 *
 * Sources:
 *   - posted lines: voucher_entries of vouchers that are not deleted and not
 *     optional, dated on or before `asOf` when given. Each line is attributed
 *     to exactly one row, by target priority ledger > bank > fixed asset >
 *     supplier > employee > factory supplier > customer, so a customer line
 *     posted on the customer's own ledger account counts once;
 *   - opening balances stored on master records (ledger accounts, banks, fixed
 *     assets, suppliers, employees, customers without their own ledger account).
 *     Openings are not journal entries in this system, so they are reported as
 *     their own column and their imbalance as its own component.
 *
 * Amounts are the posted base amounts (`debit_amount` / `credit_amount`).
 */
import { sql } from "drizzle-orm";

import { db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import type Decimal from "decimal.js";
import { classifyVoucherLedgerExpectation } from "../voucherLedgerExpectation";

export type TrialBalanceRowKind =
  | "ledger"
  | "bank"
  | "fixedAsset"
  | "supplier"
  | "employee"
  | "factorySupplier"
  | "customer"
  | "missingAccount"
  | "unassigned";

export interface TrialBalanceRow {
  kind: TrialBalanceRowKind;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  deleted: boolean;
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

interface RawLineRow {
  kind: TrialBalanceRowKind;
  target_id: number | null;
  debit: string | null;
  credit: string | null;
}

interface RawOpeningRow {
  kind: TrialBalanceRowKind;
  id: number;
  code: string | null;
  name: string;
  account_type: string | null;
  deleted: boolean;
  opening_balance: string | null;
  opening_side: string | null;
}

interface RawVoucherDiffRow {
  voucher_type: string;
  diff: string | null;
}

const ZERO = new MoneyDecimal(0);

/** Default side for an opening stored without one (openingBalanceResolutionRoutes rules). */
function defaultOpeningSide(kind: TrialBalanceRowKind): "Dr" | "Cr" {
  return kind === "supplier" || kind === "employee" || kind === "factorySupplier" ? "Cr" : "Dr";
}

function splitSigned(value: Decimal): { debit: Decimal; credit: Decimal } {
  return value.isNegative() ? { debit: ZERO, credit: value.negated() } : { debit: value, credit: ZERO };
}

function money(value: Decimal): string {
  return value.toFixed(2);
}

export async function buildTrialBalance(companyId: number, asOf: string | null): Promise<TrialBalanceReport> {
  const dateFilter = asOf ? sql`AND v.voucher_date <= ${asOf}::date` : sql``;

  const lineRows = await db.execute<RawLineRow & Record<string, unknown>>(sql`
    WITH posted AS (
      SELECT ve.*
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
       WHERE v.company_id = ${companyId}
         AND v.deleted_at IS NULL
         AND v.optional = false
         ${dateFilter}
    ), attributed AS (
      SELECT
        CASE
          WHEN p.ledger_account_id IS NOT NULL AND la.id IS NULL THEN 'missingAccount'
          WHEN p.ledger_account_id IS NOT NULL THEN 'ledger'
          WHEN p.bank_account_id IS NOT NULL THEN 'bank'
          WHEN p.fixed_asset_id IS NOT NULL THEN 'fixedAsset'
          WHEN p.supplier_id IS NOT NULL THEN 'supplier'
          WHEN p.employee_id IS NOT NULL THEN 'employee'
          WHEN p.factory_supplier_id IS NOT NULL THEN 'factorySupplier'
          WHEN p.customer_id IS NOT NULL THEN 'customer'
          ELSE 'unassigned'
        END AS kind,
        COALESCE(p.ledger_account_id, p.bank_account_id, p.fixed_asset_id, p.supplier_id, p.employee_id,
                 p.factory_supplier_id, p.customer_id) AS target_id,
        p.debit_amount, p.credit_amount
      FROM posted p
      LEFT JOIN ledger_accounts la ON la.id = p.ledger_account_id
    )
    SELECT kind, target_id, SUM(debit_amount)::text AS debit, SUM(credit_amount)::text AS credit
      FROM attributed
     GROUP BY kind, target_id
  `);

  const openingRows = await db.execute<RawOpeningRow & Record<string, unknown>>(sql`
    SELECT 'ledger' AS kind, la.id, la.code, la.name, la.account_type, (la.deleted_at IS NOT NULL) AS deleted,
           la.opening_balance::text AS opening_balance, la.opening_balance_side AS opening_side
      FROM ledger_accounts la WHERE la.company_id = ${companyId}
    UNION ALL
    SELECT 'bank', b.id, b.code, b.name, 'Bank', (b.deleted_at IS NOT NULL),
           b.opening_balance::text, b.opening_balance_side
      FROM bank_accounts b WHERE b.company_id = ${companyId}
    UNION ALL
    SELECT 'fixedAsset', f.id, f.code, f.name, 'Fixed Asset', false, f.opening_balance::text, 'Dr'
      FROM fixed_assets f WHERE f.company_id = ${companyId}
    UNION ALL
    SELECT 'supplier', s.id, s.code, s.legal_name, 'Supplier', false, s.opening_balance::text, s.opening_balance_side
      FROM suppliers s WHERE s.company_id = ${companyId}
    UNION ALL
    SELECT 'employee', e.id, e.code, TRIM(CONCAT(e.first_name, ' ', e.last_name)), 'Employee',
           (e.deleted_at IS NOT NULL), e.opening_balance::text, e.opening_balance_side
      FROM employees e WHERE e.company_id = ${companyId}
    UNION ALL
    SELECT 'factorySupplier', fs.id, NULL, fs.name, 'Factory Supplier', false, fs.opening_balance::text, NULL
      FROM factory_suppliers fs WHERE fs.company_id = ${companyId}
    UNION ALL
    -- A customer with its own ledger account carries its opening on that account.
    SELECT 'customer', c.id, c.code, c.legal_name, 'Customer', (c.deleted_at IS NOT NULL),
           c.opening_balance::text, c.opening_balance_side
      FROM customers c WHERE c.company_id = ${companyId} AND c.ledger_account_id IS NULL
  `);

  const voucherDiffRows = await db.execute<RawVoucherDiffRow & Record<string, unknown>>(sql`
    SELECT v.voucher_type, SUM(ve.debit_amount - ve.credit_amount)::text AS diff
      FROM vouchers v
      JOIN voucher_entries ve ON ve.voucher_id = v.id
     WHERE v.company_id = ${companyId}
       AND v.deleted_at IS NULL
       AND v.optional = false
       ${dateFilter}
     GROUP BY v.id, v.voucher_type
    HAVING SUM(ve.debit_amount) <> SUM(ve.credit_amount)
  `);

  const key = (kind: TrialBalanceRowKind, id: number | null) => `${kind}:${id ?? "-"}`;
  const rows = new Map<
    string,
    {
      meta: Omit<TrialBalanceRow, `${"opening" | "period" | "closing"}${"Debit" | "Credit"}`>;
      opening: Decimal;
      dr: Decimal;
      cr: Decimal;
    }
  >();
  let openingSidesAssumed = 0;

  for (const row of openingRows.rows) {
    const amount = toMoney(row.opening_balance);
    const side = row.opening_side === "Dr" || row.opening_side === "Cr" ? row.opening_side : null;
    if (!side && !amount.isZero()) openingSidesAssumed += 1;
    const signed = (side ?? defaultOpeningSide(row.kind)) === "Cr" ? amount.negated() : amount;
    rows.set(key(row.kind, row.id), {
      meta: {
        kind: row.kind,
        id: row.id,
        code: row.code,
        name: row.name,
        accountType: row.account_type,
        deleted: row.deleted,
      },
      opening: signed,
      dr: ZERO,
      cr: ZERO,
    });
  }

  for (const line of lineRows.rows) {
    const k = key(line.kind, line.target_id);
    let entry = rows.get(k);
    if (!entry) {
      const name =
        line.kind === "unassigned"
          ? "Lines with no account"
          : line.kind === "missingAccount"
            ? `Missing or other-company account #${line.target_id}`
            : `${line.kind} #${line.target_id}`;
      entry = {
        meta: { kind: line.kind, id: line.target_id, code: null, name, accountType: null, deleted: false },
        opening: ZERO,
        dr: ZERO,
        cr: ZERO,
      };
      rows.set(k, entry);
    }
    entry.dr = entry.dr.plus(toMoney(line.debit));
    entry.cr = entry.cr.plus(toMoney(line.credit));
  }

  const totals = { od: ZERO, oc: ZERO, pd: ZERO, pc: ZERO, cd: ZERO, cc: ZERO };
  let openingNet = ZERO;
  const out: TrialBalanceRow[] = [];
  for (const { meta, opening, dr, cr } of rows.values()) {
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
      ...meta,
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
