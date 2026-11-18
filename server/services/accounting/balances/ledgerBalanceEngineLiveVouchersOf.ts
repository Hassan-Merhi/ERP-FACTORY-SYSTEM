// Extracted from ./ledgerBalanceEngine.ts to keep that module under the source-size cap.
import { sql, type SQL } from "drizzle-orm";
import type Decimal from "decimal.js";
import type { DatabaseOrTransaction } from "../../../db";
import { MoneyDecimal } from "../../../lib/money";
import { customerLinksBody, intLiteral, noNonCustomerTarget } from "./partyLineRules";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import {
  netPositionKnownTransactionThrough,
  netPositionRecordedThrough,
  netPositionVoucherEntryKnown,
} from "../../factory/netPositionAsOf";
import { notFiscalClosingVoucher } from "./periodReportRules";
import { HADI_ERP_RENT_MERGE } from "../../rental/hadiRentExpenseConsolidation";

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
 * (rule 1 and the attribution above). A CTE body named `customer_links`,
 * defined once in partyLineRules.ts so the statements select the same lines.
 */
export function customerLinksCte(companyId: number): SQL {
  return sql.raw(`customer_links AS (${customerLinksBody(intLiteral(companyId))})`);
}

export interface BalanceScope {
  /** Opt-in historical-knowledge cutoff for Factory Net Position; does not change normal statements. */
  knownAt?: FactoryNetPositionAsOf;
  companyId: number;
  /** Inclusive end of the period (as-of date); null/undefined for everything posted. */
  asOf?: string | null;
  /** Inclusive start of the period; movements before it are carried into the opening. */
  from?: string | null;
  /**
   * Restrict to one row kind. `missingAccount` selects only the lines on
   * ledger accounts that are missing or belong to another company (no master
   * rows); `unassigned` the lines with no target.
   */
  kind?: BalanceRowKind;
  /** Restrict to these ids of `kind`. */
  ids?: readonly number[];
  /**
   * Leave the fiscal closing journals out (periodReportRules.ts): for period
   * reports (P&L views) only. Balances keep them; that is what moves profit
   * into retained earnings.
   */
  excludeFiscalClose?: boolean;
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
  /**
   * Net historical base amounts (base_debit/base_credit, falling back to
   * debit/credit) of every line up to `asOf`, before and inside the period.
   */
  baseMovement: Decimal;
}

interface RawLineRow {
  kind: BalanceRowKind;
  target_id: number | null;
  carried: string | null;
  period_debit: string | null;
  period_credit: string | null;
  base_movement: string | null;
}

export interface RawOpeningRow {
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

export const ZERO = new MoneyDecimal(0);

export function scopeFilter(scope: BalanceScope, kindColumn: SQL, idColumn: SQL): SQL {
  if (!scope.kind) return sql`TRUE`;
  const ids = scope.ids
    ? sql` AND ${idColumn} IN (${sql.join(
        scope.ids.map((id) => sql`${id}`),
        sql`, `
      )})`
    : sql``;
  return sql`${kindColumn} = ${scope.kind}${ids}`;
}

export async function loadLines(executor: DatabaseOrTransaction, scope: BalanceScope) {
  const { companyId, from } = scope;
  const beforeFrom = from ? sql`a.booked_on < ${from}::date` : sql`FALSE`;
  const inPeriod = from ? sql`a.booked_on >= ${from}::date` : sql`TRUE`;
  const closingJournalFilter = scope.excludeFiscalClose ? sql` AND ${notFiscalClosingVoucher("v")}` : sql``;
  const postedCut = scope.knownAt
    ? sql`v.company_id = ${companyId} AND v.optional = false
           AND ${netPositionKnownTransactionThrough(VOUCHER_BOOKED_ON, sql`v.created_at`, scope.knownAt, "utc-naive-timestamp")}
           AND ${netPositionVoucherEntryKnown(sql`ve.created_at`, sql`ve.voucher_id`, scope.knownAt)}
           AND (v.deleted_at IS NULL OR NOT ${netPositionRecordedThrough(sql`v.deleted_at`, scope.knownAt, "utc-naive-timestamp")})`
    : liveVouchersOf(companyId, scope.asOf);
  // Fold intact old voucher lines into the surviving rent expense only after
  // account #881 is retired. This keeps financial views consistent without
  // rewriting immutable posted voucher history.
  const mergedHadiRentTarget =
    companyId === HADI_ERP_RENT_MERGE.companyId
      ? sql`WHEN p.ledger_account_id = ${HADI_ERP_RENT_MERGE.legacyLedgerId}
           AND EXISTS (
             SELECT 1 FROM ledger_accounts rent_alias
             WHERE rent_alias.id = ${HADI_ERP_RENT_MERGE.legacyLedgerId}
               AND rent_alias.company_id = ${companyId}
               AND rent_alias.active = false AND rent_alias.is_hidden = true
               AND rent_alias.deleted_at IS NULL
               AND COALESCE(rent_alias.opening_balance, 0) = 0
           )
           THEN ${HADI_ERP_RENT_MERGE.targetLedgerId}`
      : sql``;
  const result = await executor.execute<RawLineRow & Record<string, unknown>>(sql`
    WITH ${customerLinksCte(companyId)},
    posted AS (
      SELECT ve.ledger_account_id, ve.bank_account_id, ve.fixed_asset_id, ve.supplier_id, ve.employee_id,
             ve.factory_supplier_id, ve.customer_id,
             COALESCE(ve.debit_amount, 0) - COALESCE(ve.credit_amount, 0) AS net,
             COALESCE(ve.base_debit_amount, ve.debit_amount, 0) - COALESCE(ve.base_credit_amount, ve.credit_amount, 0)
               AS base_net,
             ${VOUCHER_BOOKED_ON} AS booked_on
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
       WHERE ${postedCut}${closingJournalFilter}
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
          WHEN p.customer_id IS NOT NULL AND ${sql.raw(noNonCustomerTarget("p"))} THEN 'customer'
          ELSE 'unassigned'
        END AS kind,
        CASE
          WHEN cl.customer_id IS NOT NULL THEN cl.customer_id
          ${mergedHadiRentTarget}
          ELSE COALESCE(p.ledger_account_id, p.bank_account_id, p.fixed_asset_id, p.supplier_id, p.employee_id,
                        p.factory_supplier_id, p.customer_id)
        END AS target_id,
        p.net, p.base_net, p.booked_on
      FROM posted p
      LEFT JOIN ledger_accounts la ON la.id = p.ledger_account_id AND la.company_id = ${companyId}
      LEFT JOIN customer_links cl ON cl.ledger_account_id = la.id
    )
    SELECT a.kind, a.target_id,
           COALESCE(SUM(a.net) FILTER (WHERE ${beforeFrom}), 0)::text AS carried,
           COALESCE(SUM(GREATEST(a.net, 0)) FILTER (WHERE ${inPeriod}), 0)::text AS period_debit,
           COALESCE(SUM(GREATEST(-a.net, 0)) FILTER (WHERE ${inPeriod}), 0)::text AS period_credit,
           COALESCE(SUM(a.base_net), 0)::text AS base_movement
      FROM attributed a
     WHERE ${scopeFilter(scope, sql`a.kind`, sql`a.target_id`)}
     GROUP BY a.kind, a.target_id
  `);
  return result.rows;
}
