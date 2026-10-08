/**
 * The one balance engine (accounting audit wave 10).
 *
 * Every balance of a company — the trial balance, the balance sheet built on
 * it, and the per-party balances below — comes from this single source, so a
 * customer, supplier or account can never show one figure on a statement and
 * another on the trial balance. The rules (owner decisions, binding):
 *
 *   1. Openings are owned by the master record and counted exactly once, with
 *      their own Dr/Cr side (the usual side of the record type when missing).
 *      A customer's opening is customers.opening_balance, never its linked
 *      ledger account's: the opening of a ledger account linked to a customer
 *      (customers.ledger_account_id) is not counted, and the integrity
 *      diagnostic lists the linked accounts that carry one for review.
 *   2. A voucher counts from COALESCE(effective_date, voucher_date), for the
 *      as-of cut and the period start alike.
 *   3. Balances come from the ledger only: posted base amounts
 *      (debit_amount / credit_amount, USD) of vouchers of the company that are
 *      neither optional nor soft-deleted. Unposted operational amounts are not
 *      balances; they will be attached as memo lines (`memoLines`), never
 *      mixed into `closing`.
 *   4. A line belongs to its voucher's company (vouchers.company_id). A line on
 *      a ledger account that does not exist in that company is reported as
 *      `missingAccount`, never folded into another company's account.
 *
 * Attribution: each line goes to exactly one row, by target priority
 * ledger > bank > fixed asset > supplier > employee > factory supplier >
 * customer. A line on a ledger account linked to a customer goes to that
 * customer (the account has no row of its own), so a customer's balance is its
 * opening + the lines on its linked ledger + its customer_id lines that name no
 * other target, each line counted once. Where several customers link the same
 * account, the lowest customer id owns its lines (the diagnostic lists these).
 *
 * Legacy EMP-<code> employee ledger accounts are NOT rolled up into the
 * employee: the link is only a code convention (employee codes are not unique
 * across companies), the account keeps its own opening, and
 * POST /api/admin/migrate-employee-account moves those lines onto employee_id.
 * They stay ledger rows (counted once, under the account), and the integrity
 * diagnostic lists the ones still holding lines or an opening.
 *
 * A line carrying both a debit and a credit is netted: it contributes its net
 * to the period debit or the period credit, never dropped.
 */
import { sql, type SQL } from "drizzle-orm";
import type Decimal from "decimal.js";

import type { DatabaseOrTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";

export const PARTY_BALANCE_KINDS = [
  "ledger",
  "bank",
  "fixedAsset",
  "supplier",
  "employee",
  "factorySupplier",
  "customer",
] as const;
export type PartyBalanceKind = (typeof PARTY_BALANCE_KINDS)[number];
/** Party kinds plus the two rows that hold lines no party owns. */
export type BalanceRowKind = PartyBalanceKind | "missingAccount" | "unassigned";

/** The date a voucher counts from (rule 2). Use with the vouchers alias `v`. */
export const VOUCHER_BOOKED_ON = sql`COALESCE(v.effective_date, v.voucher_date)`;

/** Live vouchers of the company booked on or before `asOf` (rules 2–4). Alias `v`. */
export function liveVouchersOf(companyId: number, asOf: string | null | undefined): SQL {
  const cut = asOf ? sql` AND ${VOUCHER_BOOKED_ON} <= ${asOf}::date` : sql``;
  return sql`v.company_id = ${companyId} AND v.deleted_at IS NULL AND v.optional = false${cut}`;
}

/**
 * Ledger accounts linked to a customer of the company, one owner per account
 * (rule 1 and the attribution above). A CTE body named `customer_links`.
 */
function customerLinksCte(companyId: number): SQL {
  return sql`customer_links AS (
    SELECT DISTINCT ON (c.ledger_account_id) c.ledger_account_id, c.id AS customer_id
      FROM customers c
      JOIN ledger_accounts la ON la.id = c.ledger_account_id AND la.company_id = c.company_id
     WHERE c.company_id = ${companyId}
     ORDER BY c.ledger_account_id, c.id
  )`;
}

export interface BalanceScope {
  companyId: number;
  /** Inclusive end of the period (as-of date); null/undefined for everything posted. */
  asOf?: string | null;
  /** Inclusive start of the period; movements before it are carried into the opening. */
  from?: string | null;
  /** Restrict to one party kind. */
  kind?: PartyBalanceKind;
  /** Restrict to these ids of `kind`. */
  ids?: readonly number[];
}

/** One row of the engine, in exact Decimals (debit positive). */
export interface BalanceRow {
  kind: BalanceRowKind;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  deleted: boolean;
  /** For a customer: the ledger account whose lines roll up into it. */
  linkedLedgerAccountId: number | null;
  /** The master record's opening with its side (rule 1). */
  masterOpening: Decimal;
  /** Whether that opening had no Dr/Cr side and the usual side was assumed. */
  openingSideAssumed: boolean;
  /** Net movements booked before `from` (zero without `from`). */
  carriedForward: Decimal;
  periodDebit: Decimal;
  periodCredit: Decimal;
}

interface RawLineRow {
  kind: BalanceRowKind;
  target_id: number | null;
  carried: string | null;
  period_debit: string | null;
  period_credit: string | null;
}

interface RawOpeningRow {
  kind: PartyBalanceKind;
  id: number;
  code: string | null;
  name: string;
  account_type: string | null;
  deleted: boolean;
  linked_ledger_account_id: number | null;
  opening_balance: string | null;
  opening_side: string | null;
}

const ZERO = new MoneyDecimal(0);

/** Default side for an opening stored without one (openingBalanceResolutionRoutes rules). */
function defaultOpeningSide(kind: BalanceRowKind): "Dr" | "Cr" {
  return kind === "supplier" || kind === "employee" || kind === "factorySupplier" ? "Cr" : "Dr";
}

function scopeFilter(scope: BalanceScope, kindColumn: SQL, idColumn: SQL): SQL {
  if (!scope.kind) return sql`TRUE`;
  const ids = scope.ids
    ? sql` AND ${idColumn} IN (${sql.join(
        scope.ids.map((id) => sql`${id}`),
        sql`, `
      )})`
    : sql``;
  return sql`${kindColumn} = ${scope.kind}${ids}`;
}

async function loadLines(executor: DatabaseOrTransaction, scope: BalanceScope) {
  const { companyId, from } = scope;
  const beforeFrom = from ? sql`a.booked_on < ${from}::date` : sql`FALSE`;
  const inPeriod = from ? sql`a.booked_on >= ${from}::date` : sql`TRUE`;
  const result = await executor.execute<RawLineRow & Record<string, unknown>>(sql`
    WITH ${customerLinksCte(companyId)},
    posted AS (
      SELECT ve.ledger_account_id, ve.bank_account_id, ve.fixed_asset_id, ve.supplier_id, ve.employee_id,
             ve.factory_supplier_id, ve.customer_id,
             COALESCE(ve.debit_amount, 0) - COALESCE(ve.credit_amount, 0) AS net,
             ${VOUCHER_BOOKED_ON} AS booked_on
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
       WHERE ${liveVouchersOf(companyId, scope.asOf)}
    ), attributed AS (
      SELECT
        CASE
          WHEN p.ledger_account_id IS NOT NULL AND la.id IS NULL THEN 'missingAccount'
          WHEN p.ledger_account_id IS NOT NULL AND cl.customer_id IS NOT NULL THEN 'customer'
          WHEN p.ledger_account_id IS NOT NULL THEN 'ledger'
          WHEN p.bank_account_id IS NOT NULL THEN 'bank'
          WHEN p.fixed_asset_id IS NOT NULL THEN 'fixedAsset'
          WHEN p.supplier_id IS NOT NULL THEN 'supplier'
          WHEN p.employee_id IS NOT NULL THEN 'employee'
          WHEN p.factory_supplier_id IS NOT NULL THEN 'factorySupplier'
          WHEN p.customer_id IS NOT NULL THEN 'customer'
          ELSE 'unassigned'
        END AS kind,
        CASE
          WHEN cl.customer_id IS NOT NULL THEN cl.customer_id
          ELSE COALESCE(p.ledger_account_id, p.bank_account_id, p.fixed_asset_id, p.supplier_id, p.employee_id,
                        p.factory_supplier_id, p.customer_id)
        END AS target_id,
        p.net, p.booked_on
      FROM posted p
      LEFT JOIN ledger_accounts la ON la.id = p.ledger_account_id AND la.company_id = ${companyId}
      LEFT JOIN customer_links cl ON cl.ledger_account_id = la.id
    )
    SELECT a.kind, a.target_id,
           COALESCE(SUM(a.net) FILTER (WHERE ${beforeFrom}), 0)::text AS carried,
           COALESCE(SUM(GREATEST(a.net, 0)) FILTER (WHERE ${inPeriod}), 0)::text AS period_debit,
           COALESCE(SUM(GREATEST(-a.net, 0)) FILTER (WHERE ${inPeriod}), 0)::text AS period_credit
      FROM attributed a
     WHERE ${scopeFilter(scope, sql`a.kind`, sql`a.target_id`)}
     GROUP BY a.kind, a.target_id
  `);
  return result.rows;
}

async function loadOpenings(executor: DatabaseOrTransaction, scope: BalanceScope) {
  const { companyId } = scope;
  const result = await executor.execute<RawOpeningRow & Record<string, unknown>>(sql`
    WITH ${customerLinksCte(companyId)},
    masters AS (
      -- A ledger account linked to a customer has no row: its lines belong to the customer
      -- and its own opening is not counted (rule 1).
      SELECT 'ledger' AS kind, la.id, la.code, la.name, la.account_type, (la.deleted_at IS NOT NULL) AS deleted,
             NULL::int AS linked_ledger_account_id,
             la.opening_balance::text AS opening_balance, la.opening_balance_side::text AS opening_side
        FROM ledger_accounts la
       WHERE la.company_id = ${companyId}
         AND NOT EXISTS (SELECT 1 FROM customer_links cl WHERE cl.ledger_account_id = la.id)
      UNION ALL
      SELECT 'bank', b.id, b.code, b.name, 'Bank', (b.deleted_at IS NOT NULL), NULL,
             b.opening_balance::text, b.opening_balance_side::text
        FROM bank_accounts b WHERE b.company_id = ${companyId}
      UNION ALL
      SELECT 'fixedAsset', f.id, f.code, f.name, 'Fixed Asset', false, NULL, f.opening_balance::text, 'Dr'
        FROM fixed_assets f WHERE f.company_id = ${companyId}
      UNION ALL
      SELECT 'supplier', s.id, s.code, s.legal_name, 'Supplier', (s.deleted_at IS NOT NULL), NULL,
             s.opening_balance::text, s.opening_balance_side::text
        FROM suppliers s WHERE s.company_id = ${companyId}
      UNION ALL
      SELECT 'employee', e.id, e.code, TRIM(CONCAT(e.first_name, ' ', e.last_name)), 'Employee',
             (e.deleted_at IS NOT NULL), NULL, e.opening_balance::text, e.opening_balance_side::text
        FROM employees e WHERE e.company_id = ${companyId}
      UNION ALL
      SELECT 'factorySupplier', fs.id, NULL, fs.name, 'Factory Supplier', false, NULL, fs.opening_balance::text, NULL
        FROM factory_suppliers fs WHERE fs.company_id = ${companyId}
      UNION ALL
      -- Every customer carries its own opening (rule 1), linked ledger or not.
      SELECT 'customer', c.id, c.code, c.legal_name, 'Customer', (c.deleted_at IS NOT NULL),
             (SELECT cl.ledger_account_id FROM customer_links cl WHERE cl.customer_id = c.id LIMIT 1),
             c.opening_balance::text, c.opening_balance_side::text
        FROM customers c WHERE c.company_id = ${companyId}
    )
    SELECT * FROM masters m WHERE ${scopeFilter(scope, sql`m.kind`, sql`m.id`)}
  `);
  return result.rows;
}

function fallbackName(kind: BalanceRowKind, id: number | null): string {
  if (kind === "unassigned") return "Lines with no account";
  if (kind === "missingAccount") return `Missing or other-company account #${id}`;
  return `${kind} #${id}`;
}

/**
 * The engine's rows for a scope: every master record of the scope (zero or
 * not) plus a row for every target that only has lines. Shared by the trial
 * balance and getPartyBalances so both apply the same rules.
 */
export async function loadBalanceRows(executor: DatabaseOrTransaction, scope: BalanceScope): Promise<BalanceRow[]> {
  if (scope.ids && scope.ids.length === 0) return [];
  const [openings, lines] = await Promise.all([loadOpenings(executor, scope), loadLines(executor, scope)]);

  const rows = new Map<string, BalanceRow>();
  const key = (kind: BalanceRowKind, id: number | null) => `${kind}:${id ?? "-"}`;
  for (const row of openings) {
    const amount = toMoney(row.opening_balance);
    const side = row.opening_side === "Dr" || row.opening_side === "Cr" ? row.opening_side : null;
    const signed = (side ?? defaultOpeningSide(row.kind)) === "Cr" ? amount.negated() : amount;
    rows.set(key(row.kind, row.id), {
      kind: row.kind,
      id: row.id,
      code: row.code,
      name: row.name,
      accountType: row.account_type,
      deleted: row.deleted,
      linkedLedgerAccountId: row.linked_ledger_account_id ?? null,
      masterOpening: signed,
      openingSideAssumed: !side && !amount.isZero(),
      carriedForward: ZERO,
      periodDebit: ZERO,
      periodCredit: ZERO,
    });
  }
  for (const line of lines) {
    const k = key(line.kind, line.target_id);
    let entry = rows.get(k);
    if (!entry) {
      entry = {
        kind: line.kind,
        id: line.target_id,
        code: null,
        name: fallbackName(line.kind, line.target_id),
        accountType: null,
        deleted: false,
        linkedLedgerAccountId: null,
        masterOpening: ZERO,
        openingSideAssumed: false,
        carriedForward: ZERO,
        periodDebit: ZERO,
        periodCredit: ZERO,
      };
      rows.set(k, entry);
    }
    entry.carriedForward = entry.carriedForward.plus(toMoney(line.carried));
    entry.periodDebit = entry.periodDebit.plus(toMoney(line.period_debit));
    entry.periodCredit = entry.periodCredit.plus(toMoney(line.period_credit));
  }
  return [...rows.values()];
}

/**
 * An amount that is not on the ledger but belongs next to a party's balance
 * (an unposted invoice, an operational table's figure). Never part of
 * `closing`. Not produced yet: a later wave attaches them.
 */
export interface PartyBalanceMemoLine {
  source: string;
  reference: string | null;
  /** Debit positive. */
  amount: string;
  note: string | null;
}

/** A party's ledger balance. Amounts are 2-decimal strings, debit positive. */
export interface PartyBalance {
  kind: BalanceRowKind;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  deleted: boolean;
  linkedLedgerAccountId: number | null;
  /** The master record's opening with its side. */
  masterOpening: string;
  /** Net movements before `from` (zero without `from`). */
  carriedForward: string;
  /** Balance at the start of the period: masterOpening + carriedForward. */
  opening: string;
  periodDebit: string;
  periodCredit: string;
  /** opening + periodDebit − periodCredit. */
  closing: string;
  openingSideAssumed: boolean;
  memoLines: PartyBalanceMemoLine[];
}

export interface PartyBalanceQuery {
  companyId: number;
  kind: PartyBalanceKind;
  ids?: readonly number[];
  /** Inclusive end; omitted for everything posted. */
  asOf?: string | null;
  /** Inclusive start of the period; omitted for opening-to-date. */
  from?: string | null;
}

export interface PartyBalanceResult {
  companyId: number;
  kind: PartyBalanceKind;
  basis: "ledger";
  period: { from: string | null; to: string | null };
  parties: PartyBalance[];
}

function money(value: Decimal): string {
  return value.toFixed(2);
}

export function toPartyBalance(row: BalanceRow): PartyBalance {
  const opening = row.masterOpening.plus(row.carriedForward);
  return {
    kind: row.kind,
    id: row.id,
    code: row.code,
    name: row.name,
    accountType: row.accountType,
    deleted: row.deleted,
    linkedLedgerAccountId: row.linkedLedgerAccountId,
    masterOpening: money(row.masterOpening),
    carriedForward: money(row.carriedForward),
    opening: money(opening),
    periodDebit: money(row.periodDebit),
    periodCredit: money(row.periodCredit),
    closing: money(opening.plus(row.periodDebit).minus(row.periodCredit)),
    openingSideAssumed: row.openingSideAssumed,
    memoLines: [],
  };
}

/**
 * Ledger balances of one kind of party, on the trial balance's rules.
 * Returns every master record of the kind (or of `ids`) in the company, plus
 * any id of the kind that only has lines (for example a group supplier of the
 * parent company), sorted by code then name.
 */
export async function getPartyBalances(
  executor: DatabaseOrTransaction,
  query: PartyBalanceQuery
): Promise<PartyBalanceResult> {
  if (query.from && query.asOf && query.from > query.asOf) {
    throw new Error("Period start is after its end");
  }
  const rows = await loadBalanceRows(executor, query);
  const parties = rows
    .map(toPartyBalance)
    .sort((a, b) => (a.code ?? a.name).localeCompare(b.code ?? b.name) || (a.id ?? 0) - (b.id ?? 0));
  return {
    companyId: query.companyId,
    kind: query.kind,
    basis: "ledger",
    period: { from: query.from ?? null, to: query.asOf ?? null },
    parties,
  };
}

/** Convenience for one party; null when it has neither a master record nor lines. */
export async function getPartyBalance(
  executor: DatabaseOrTransaction,
  query: Omit<PartyBalanceQuery, "ids"> & { id: number }
): Promise<PartyBalance | null> {
  const result = await getPartyBalances(executor, { ...query, ids: [query.id] });
  return result.parties[0] ?? null;
}
