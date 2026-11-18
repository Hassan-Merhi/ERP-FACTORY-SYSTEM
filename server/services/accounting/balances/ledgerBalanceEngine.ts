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
 *      balances; with `memo: true` they are attached as labelled memo lines
 *      (`memoLines`, `memoTotal`, see unpostedMemo.ts), never mixed into
 *      `closing`.
 *   4. A line belongs to its voucher's company (vouchers.company_id). A line on
 *      a ledger account that does not exist in that company is reported as
 *      `missingAccount`, never folded into another company's account.
 *
 * Attribution (defined once in partyLineRules.ts, which the statements use
 * to list the same lines): each line goes to exactly one row, by target
 * priority ledger > bank > fixed asset > supplier > employee > factory
 * supplier > customer. A line on a ledger account linked to a customer goes to that
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
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";

import type { DatabaseOrTransaction } from "../../../db";
import { toMoney } from "../../../lib/money";
import { defaultOpeningSide } from "./openingSide";
import { netPositionRecordedThrough } from "../../factory/netPositionAsOf";
import { loadPartyMemoLines, memoTotal, type MemoPartyKind } from "./unpostedMemo";
import {
  ZERO,
  customerLinksCte,
  loadLines,
  scopeFilter,
  type BalanceRow,
  type BalanceRowKind,
  type BalanceScope,
  type RawOpeningRow,
} from "./ledgerBalanceEngineLiveVouchersOf";
import type { PartyBalance, PartyBalanceQuery, PartyBalanceResult } from "./ledgerBalanceEngineTypes";
export type { PartyBalance, PartyBalanceQuery, PartyBalanceResult } from "./ledgerBalanceEngineTypes";
export { PARTY_BALANCE_KINDS, VOUCHER_BOOKED_ON, liveVouchersOf } from "./ledgerBalanceEngineLiveVouchersOf";
export type { BalanceRow, BalanceRowKind, BalanceScope, PartyBalanceKind } from "./ledgerBalanceEngineLiveVouchersOf";

export { openingSideOf, signedMasterOpening } from "./openingSide";

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
          ${
            scope.knownAt
              ? sql`AND e.join_date <= ${scope.knownAt.asOf}::date
          AND ${netPositionRecordedThrough(sql`e.created_at`, scope.knownAt, "utc-naive-timestamp")}`
              : sql``
          }
      UNION ALL
      SELECT 'factorySupplier', fs.id, NULL, fs.name, 'Factory Supplier', false, NULL, fs.opening_balance::text, NULL
        FROM factory_suppliers fs WHERE fs.company_id = ${companyId}
      UNION ALL
      -- Every customer carries its own opening (rule 1), linked ledger or not.
      SELECT 'customer', c.id, c.code, c.legal_name, 'Customer', (c.deleted_at IS NOT NULL),
             (SELECT cl.ledger_account_id FROM customer_links cl WHERE cl.customer_id = c.id LIMIT 1),
             c.opening_balance::text, c.opening_balance_side::text
        FROM customers c WHERE c.company_id = ${companyId}
          ${scope.knownAt ? sql`AND ${netPositionRecordedThrough(sql`c.created_at`, scope.knownAt, "utc-naive-timestamp")}` : sql``}
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
    const signed = (side ?? defaultOpeningSide(row.kind, row.account_type)) === "Cr" ? amount.negated() : amount;
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
      baseMovement: ZERO,
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
        baseMovement: ZERO,
      };
      rows.set(k, entry);
    }
    entry.carriedForward = entry.carriedForward.plus(toMoney(line.carried));
    entry.periodDebit = entry.periodDebit.plus(toMoney(line.period_debit));
    entry.periodCredit = entry.periodCredit.plus(toMoney(line.period_credit));
    entry.baseMovement = entry.baseMovement.plus(toMoney(line.base_movement));
  }
  return [...rows.values()];
}

export type { PartyBalanceMemoLine } from "./unpostedMemo";

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
    historicalBaseClosing: money(row.masterOpening.plus(row.baseMovement)),
    openingSideAssumed: row.openingSideAssumed,
    memoLines: [],
    memoTotal: "0.00",
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
  if (query.memo && (query.kind === "customer" || query.kind === "factorySupplier")) {
    await attachMemoLines(executor, query, query.kind, parties);
  }
  return {
    companyId: query.companyId,
    kind: query.kind,
    basis: "ledger",
    period: { from: query.from ?? null, to: query.asOf ?? null },
    parties,
  };
}

async function attachMemoLines(
  executor: DatabaseOrTransaction,
  query: PartyBalanceQuery,
  kind: MemoPartyKind,
  parties: PartyBalance[]
): Promise<void> {
  const ids = parties.map((party) => party.id).filter((id): id is number => id !== null);
  const memo = await loadPartyMemoLines(executor, {
    companyId: query.companyId,
    kind,
    ids,
    asOf: query.asOf,
    knownAt: query.knownAt,
  });
  for (const party of parties) {
    const lines = party.id === null ? [] : (memo.get(party.id) ?? []);
    party.memoLines = lines;
    party.memoTotal = memoTotal(lines).toFixed(2);
  }
}

/** Convenience for one party; null when it has neither a master record nor lines. */
export async function getPartyBalance(
  executor: DatabaseOrTransaction,
  query: Omit<PartyBalanceQuery, "ids"> & { id: number }
): Promise<PartyBalance | null> {
  const result = await getPartyBalances(executor, { ...query, ids: [query.id] });
  return result.parties[0] ?? null;
}
