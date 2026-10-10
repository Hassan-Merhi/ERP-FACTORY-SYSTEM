/**
 * Line-ownership rules of the one balance engine (accounting audit wave 10),
 * as SQL fragments.
 *
 * The engine (ledgerBalanceEngine.ts) attributes every posted voucher line to
 * exactly one row of the trial balance. Statements that list a party's lines
 * (customer transactions, the account statement, the factory customer
 * statement and its exports) must select the same lines, so the attribution
 * is defined here once and both the engine's CASE and the statements' WHERE
 * clauses are built from these fragments.
 *
 * Attribution priority: ledger account > bank account > fixed asset >
 * supplier > employee > factory supplier > customer. A line on a ledger
 * account linked to a customer belongs to that customer (the account has no
 * row of its own), the lowest customer id owning an account linked to several.
 * So a customer owns:
 *   - the lines on its owned linked ledger, and
 *   - the lines tagged with it (customer_id) that name no other target at all.
 * A customer-tagged line on another ledger, a bank, a supplier... is that
 * target's line. This is the double-entry rule: a voucher's customer side is
 * one line, and each line is counted for exactly one party, so the sum over
 * every party equals the trial balance.
 *
 * Fragments are built from integer literals (validated) or `$n` placeholders,
 * so they can be used with drizzle (`sql.raw`) and with node-postgres text
 * queries alike.
 */
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import * as schema from "@shared/schema";

/** Voucher-line columns that name a target other than a customer, in priority order. */
export const NON_CUSTOMER_TARGET_COLUMNS = [
  "ledger_account_id",
  "bank_account_id",
  "fixed_asset_id",
  "supplier_id",
  "employee_id",
  "factory_supplier_id",
] as const;

/**
 * A SQL value expression: a `$n` placeholder, a validated integer literal, or
 * an outer column reference such as `c.id` (aliases inside the fragments are
 * prefixed `link_` so they never shadow it).
 */
export type SqlValueExpr = string;

/** An integer as a SQL literal; throws on anything but a safe integer. */
export function intLiteral(value: number): SqlValueExpr {
  if (!Number.isSafeInteger(value)) throw new Error("party_line_rules_id_not_integer");
  return String(value);
}

function placeholderOrLiteral(value: SqlValueExpr): SqlValueExpr {
  if (/^\$\d+$/.test(value) || /^-?\d+$/.test(value) || /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(value)) {
    return value;
  }
  throw new Error("party_line_rules_unsafe_sql_expression");
}

/**
 * Body of the `customer_links` relation: each ledger account linked to a
 * customer of the company, with its owner (the lowest customer id linking it).
 * The account must exist in the customer's company.
 */
export function customerLinksBody(company: SqlValueExpr): string {
  const c = placeholderOrLiteral(company);
  return `SELECT link_c.ledger_account_id, link_c.id AS customer_id
      FROM customers link_c
      JOIN ledger_accounts link_la ON link_la.id = link_c.ledger_account_id AND link_la.company_id = link_c.company_id
     WHERE link_c.company_id = ${c}
       AND NOT EXISTS (
         SELECT 1 FROM customers link_c2
          WHERE link_c2.company_id = link_c.company_id AND link_c2.ledger_account_id = link_c.ledger_account_id
            AND link_c2.id < link_c.id
       )`;
}

/** The line (alias) names no target other than a customer. */
export function noNonCustomerTarget(alias: string): string {
  return NON_CUSTOMER_TARGET_COLUMNS.map((column) => `${alias}.${column} IS NULL`).join(" AND ");
}

/** The ledger account a customer owns (empty when it has none, or another customer owns it). */
export function ownedCustomerLedgerQuery(company: SqlValueExpr, customer: SqlValueExpr): string {
  const id = placeholderOrLiteral(customer);
  return `SELECT link_owner.ledger_account_id FROM (${customerLinksBody(company)}) link_owner WHERE link_owner.customer_id = ${id}`;
}

/** Predicate on a voucher-line alias: the line belongs to the customer (see the header). */
export function customerOwnedLinePredicate(alias: string, company: SqlValueExpr, customer: SqlValueExpr): string {
  const id = placeholderOrLiteral(customer);
  return `(${alias}.ledger_account_id IN (${ownedCustomerLedgerQuery(company, customer)})
        OR (${alias}.customer_id = ${id} AND ${noNonCustomerTarget(alias)}))`;
}

/** Predicate on a voucher alias: posted (not optional, not soft-deleted) in the company. */
export function liveVoucherPredicate(alias: string, company: SqlValueExpr): string {
  const c = placeholderOrLiteral(company);
  return `${alias}.company_id = ${c} AND ${alias}.optional = false AND ${alias}.deleted_at IS NULL`;
}

/** The date a voucher counts from (owner rule 2), for a voucher alias. */
export function voucherBookedOnText(alias: string): string {
  return `COALESCE(${alias}.effective_date, ${alias}.voucher_date)`;
}

// ── drizzle forms, on the un-aliased voucher_entries / vouchers tables ──────

const v = schema.vouchers;

/** COALESCE(effective_date, voucher_date) on the vouchers table. */
export const voucherBookedOnSql = sql`COALESCE(${v.effectiveDate}, ${v.voucherDate})`;

/** The voucher is posted in this company: not deleted, not optional. */
export function liveVoucherInCompany(companyId: number): SQL {
  return and(eq(v.companyId, companyId), eq(v.optional, false), isNull(v.deletedAt)) as SQL;
}

/** The voucher_entries row belongs to the customer (same rule as the engine). */
export function customerOwnedLineSql(companyId: number, customerId: number): SQL {
  return sql.raw(customerOwnedLinePredicate(`"voucher_entries"`, intLiteral(companyId), intLiteral(customerId)));
}

// ── non-customer parties (wave 13) ────────────────────────────────────────────

/** A voucher-line column that names a non-customer party. */
export type PartyTargetColumn = (typeof NON_CUSTOMER_TARGET_COLUMNS)[number];

/**
 * Predicate on a voucher-line alias: the line names no target of higher
 * priority than `column`, so the engine attributes a line naming `column` to
 * that party. A supplier-tagged line on a ledger account, a bank or a fixed
 * asset belongs to that account, not to the supplier; combine with
 * `<alias>.<column> = id` to list exactly the lines the engine counts.
 */
export function higherPriorityTargetsAbsent(alias: string, column: PartyTargetColumn): string {
  if (!/^[a-z_][a-z0-9_]*$|^"[a-z_]+"$/.test(alias)) throw new Error("party_line_rules_unsafe_alias");
  const higher = NON_CUSTOMER_TARGET_COLUMNS.slice(0, NON_CUSTOMER_TARGET_COLUMNS.indexOf(column));
  if (higher.length === 0) return "TRUE";
  return higher.map((target) => `${alias}.${target} IS NULL`).join(" AND ");
}

/** drizzle form on the un-aliased voucher_entries table. */
export function partyOwnedLineSql(column: PartyTargetColumn): SQL {
  return sql.raw(higherPriorityTargetsAbsent(`"voucher_entries"`, column));
}
