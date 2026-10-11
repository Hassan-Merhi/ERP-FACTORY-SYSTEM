/**
 * The period general ledger (accounting audit phase 23, G18).
 *
 * There was no general-ledger detail: only the as-of trial balance and the
 * daybook. This report gives, for every row of the one balance engine (each
 * ledger account, bank, fixed asset, supplier, employee, factory supplier and
 * customer, plus the lines on missing accounts and the lines with no target)
 * over a period:
 *   - the opening at the period start: the master opening plus every line
 *     booked before it (ledgerBalanceEngine, `from`);
 *   - every line booked in the period, in date order, with its voucher and a
 *     running balance;
 *   - the period debit and credit and the closing balance.
 *
 * Lines are attributed exactly as the engine attributes them (same CASE,
 * built from partyLineRules.ts), so a row's opening plus its lines equals the
 * engine's closing for that row, and the totals equal the trial balance at the
 * period end. Amounts are the posted base amounts in exact Decimals, debit
 * positive. The data endpoint is GET /api/accounting/general-ledger; the
 * report page and exports are phase 27's.
 */
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";

import { db, type DatabaseOrTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { loadBalanceRows, type BalanceRowKind, VOUCHER_BOOKED_ON } from "./balances/ledgerBalanceEngine";
import { customerLinksBody, intLiteral, noNonCustomerTarget } from "./balances/partyLineRules";

export const GENERAL_LEDGER_MAX_LINES = 20_000;

export interface GeneralLedgerQuery {
  companyId: number;
  from: string;
  to: string;
  kind?: BalanceRowKind;
  ids?: readonly number[];
}

export interface GeneralLedgerLine {
  entryId: number;
  voucherId: number;
  voucherNumber: string;
  voucherType: string;
  bookedOn: string;
  narration: string | null;
  debit: string;
  credit: string;
  /** Balance after this line, debit positive. */
  balance: string;
}

export interface GeneralLedgerAccount {
  kind: BalanceRowKind;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  opening: string;
  periodDebit: string;
  periodCredit: string;
  closing: string;
  lines: GeneralLedgerLine[];
}

export interface GeneralLedgerReport {
  companyId: number;
  from: string;
  to: string;
  accounts: GeneralLedgerAccount[];
  totals: { opening: string; periodDebit: string; periodCredit: string; closing: string };
  truncated: boolean;
}

interface RawLine {
  entry_id: number;
  voucher_id: number;
  voucher_number: string;
  voucher_type: string;
  booked_on: string;
  narration: string | null;
  kind: BalanceRowKind;
  target_id: number | null;
  net: string;
}

const ZERO = new MoneyDecimal(0);
const money = (value: Decimal) => value.toFixed(2);
const keyOf = (kind: BalanceRowKind, id: number | null) => `${kind}:${id ?? "-"}`;

async function periodLines(executor: DatabaseOrTransaction, query: GeneralLedgerQuery): Promise<RawLine[]> {
  const { companyId, from, to } = query;
  const scope = query.kind
    ? query.ids && query.ids.length > 0
      ? sql` AND a.kind = ${query.kind} AND a.target_id IN (${sql.join(
          query.ids.map((id) => sql`${id}`),
          sql`, `
        )})`
      : sql` AND a.kind = ${query.kind}`
    : sql``;
  const result = await executor.execute<RawLine & Record<string, unknown>>(sql`
    WITH customer_links AS (${sql.raw(customerLinksBody(intLiteral(companyId)))}),
    posted AS (
      SELECT ve.id AS entry_id, v.id AS voucher_id, v.voucher_number, v.voucher_type, ve.narration,
             ve.ledger_account_id, ve.bank_account_id, ve.fixed_asset_id, ve.supplier_id, ve.employee_id,
             ve.factory_supplier_id, ve.customer_id,
             COALESCE(ve.debit_amount, 0) - COALESCE(ve.credit_amount, 0) AS net,
             ${VOUCHER_BOOKED_ON} AS booked_on
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
       WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND v.optional = false
         AND ${VOUCHER_BOOKED_ON} BETWEEN ${from}::date AND ${to}::date
    ), attributed AS (
      SELECT p.*,
        CASE
          WHEN p.ledger_account_id IS NOT NULL AND la.id IS NULL THEN 'missingAccount'
          WHEN p.ledger_account_id IS NOT NULL AND cl.customer_id IS NOT NULL THEN 'customer'
          WHEN p.ledger_account_id IS NOT NULL THEN 'ledger'
          WHEN p.bank_account_id IS NOT NULL THEN 'bank'
          WHEN p.fixed_asset_id IS NOT NULL THEN 'fixedAsset'
          WHEN p.supplier_id IS NOT NULL THEN 'supplier'
          WHEN p.employee_id IS NOT NULL THEN 'employee'
          WHEN p.factory_supplier_id IS NOT NULL THEN 'factorySupplier'
          WHEN p.customer_id IS NOT NULL AND ${sql.raw(noNonCustomerTarget("p"))} THEN 'customer'
          ELSE 'unassigned'
        END AS kind,
        CASE
          WHEN cl.customer_id IS NOT NULL THEN cl.customer_id
          ELSE COALESCE(p.ledger_account_id, p.bank_account_id, p.fixed_asset_id, p.supplier_id, p.employee_id,
                        p.factory_supplier_id, p.customer_id)
        END AS target_id
      FROM posted p
      LEFT JOIN ledger_accounts la ON la.id = p.ledger_account_id AND la.company_id = ${companyId}
      LEFT JOIN customer_links cl ON cl.ledger_account_id = la.id
    )
    SELECT a.entry_id, a.voucher_id, a.voucher_number, a.voucher_type, a.booked_on::text AS booked_on, a.narration,
           a.kind, a.target_id, a.net::text AS net
      FROM attributed a
     WHERE a.net <> 0${scope}
     ORDER BY a.kind, a.target_id NULLS FIRST, a.booked_on, a.voucher_id, a.entry_id
     LIMIT ${GENERAL_LEDGER_MAX_LINES + 1}`);
  return result.rows as unknown as RawLine[];
}

export async function buildPeriodGeneralLedger(
  query: GeneralLedgerQuery,
  executor: DatabaseOrTransaction = db
): Promise<GeneralLedgerReport> {
  const [rows, rawLines] = await Promise.all([
    loadBalanceRows(executor, {
      companyId: query.companyId,
      from: query.from,
      asOf: query.to,
      kind: query.kind,
      ids: query.ids,
    }),
    periodLines(executor, query),
  ]);
  const truncated = rawLines.length > GENERAL_LEDGER_MAX_LINES;
  const lines = truncated ? rawLines.slice(0, GENERAL_LEDGER_MAX_LINES) : rawLines;
  const linesByRow = new Map<string, RawLine[]>();
  for (const line of lines) {
    const key = keyOf(line.kind, line.target_id === null ? null : Number(line.target_id));
    const list = linesByRow.get(key) ?? [];
    list.push(line);
    linesByRow.set(key, list);
  }

  const totals = { opening: ZERO, debit: ZERO, credit: ZERO, closing: ZERO };
  const accounts: GeneralLedgerAccount[] = [];
  for (const row of rows) {
    const opening = row.masterOpening.plus(row.carriedForward);
    const closing = opening.plus(row.periodDebit).minus(row.periodCredit);
    const own = linesByRow.get(keyOf(row.kind, row.id)) ?? [];
    if (opening.isZero() && own.length === 0 && row.periodDebit.isZero() && row.periodCredit.isZero()) continue;
    let running = opening;
    const ledgerLines: GeneralLedgerLine[] = own.map((line) => {
      const net = toMoney(line.net);
      running = running.plus(net);
      return {
        entryId: Number(line.entry_id),
        voucherId: Number(line.voucher_id),
        voucherNumber: line.voucher_number,
        voucherType: line.voucher_type,
        bookedOn: line.booked_on,
        narration: line.narration,
        debit: money(net.isPositive() ? net : ZERO),
        credit: money(net.isNegative() ? net.negated() : ZERO),
        balance: money(running),
      };
    });
    totals.opening = totals.opening.plus(opening);
    totals.debit = totals.debit.plus(row.periodDebit);
    totals.credit = totals.credit.plus(row.periodCredit);
    totals.closing = totals.closing.plus(closing);
    accounts.push({
      kind: row.kind,
      id: row.id,
      code: row.code,
      name: row.name,
      accountType: row.accountType,
      opening: money(opening),
      periodDebit: money(row.periodDebit),
      periodCredit: money(row.periodCredit),
      closing: money(closing),
      lines: ledgerLines,
    });
  }
  accounts.sort((a, b) => a.kind.localeCompare(b.kind) || (a.code ?? a.name).localeCompare(b.code ?? b.name));
  return {
    companyId: query.companyId,
    from: query.from,
    to: query.to,
    accounts,
    totals: {
      opening: money(totals.opening),
      periodDebit: money(totals.debit),
      periodCredit: money(totals.credit),
      closing: money(totals.closing),
    },
    truncated,
  };
}
