import { eq, isNull, lte } from "drizzle-orm";

import { vouchers, type Company } from "@shared/schema";
import { pool } from "../../db";
import { storage } from "../../storage";
import { resultRows } from "../../lib/queryResult";

/** One ledger account row as mapped to camelCase below: the original columns
 *  guaranteed to exist in every deployment (including pre-migration prod).
 *  Satisfies the shared `AccountLike` the net-position classifiers accept. */
export type NetProfitLedgerAccount = {
  id: number;
  companyId: number;
  code: string;
  name: string;
  accountType: string;
  subType: string | null;
  openingBalance: string;
  openingBalanceSide: string;
  active: boolean;
  isHidden: boolean;
  parentId: number | null;
  deletedAt: string | null;
  createdAt: string;
  category: string | null;
};

export interface NetProfitData {
  companyRecord: Company | undefined;
  companyAccounts: NetProfitLedgerAccount[];
  parentCompanyId: number | null;
  hasMigratedEntries: boolean;
  companyBaseCurrency: string;
  accountBalances: Map<number, { debit: number; credit: number }>;
  supplierBalances: Map<number, { debit: number; credit: number }>;
  employeeBalances: Map<number, { debit: number; credit: number }>;
}

/**
 * Load everything /api/stats/net-profit computes from: the company row, its
 * ledger accounts, and the three grouped balance maps.
 *
 * Extracted verbatim from the handler. It is one step because the pieces are
 * genuinely coupled - the schema probe decides which SQL form every subsequent
 * query uses, and all of it runs in a single Promise.all so the probe costs no
 * sequential latency. Splitting it further would serialise the batch.
 *
 * config/report-characterization.json pins the endpoint's output across the move.
 */
export async function loadNetProfitData(companyId: number, toDate: string | null | undefined): Promise<NetProfitData> {
  const voucherConditions = [
    eq(vouchers.companyId, companyId),
    eq(vouchers.optional, false),
    isNull(vouchers.deletedAt),
  ];
  if (toDate) {
    voucherConditions.push(lte(vouchers.voucherDate, toDate));
  }

  // Program 6D optimization: replace the two large per-row entry materialisations
  // with three grouped-SQL queries.  This was validated by the Program 6D
  // reconciliation script (995/995 cases, max diff < 1e-9, zero semantic mismatches)
  // and by query-plan evidence showing 97-99% reduction in rows returned to the app.
  //
  // Three queries replace the original two:
  //   1. groupedLedgerRows   — SUM per ledger_account_id, scoped by ACCOUNT's companyId
  //      Preserves migrated-account attribution (rule 1+2).
  //   2. groupedSupplierRows — SUM per supplier_id with SQL CASE for pure-side filtering,
  //      scoped by VOUCHER's companyId.  Mixed debit+credit FX settlement rows
  //      contribute 0 to both sides (rules 3+4+5).
  //   3. groupedEmployeeRows — SUM per employee_id, scoped by VOUCHER's companyId (rule 3).
  //
  // pool.query is used (not db.select) to avoid the Drizzle ::cast-in-sql-template
  // issue documented in the project memory.
  const _entryParams = toDate ? [companyId, toDate] : [companyId];
  const _dateClause = toDate ? "AND v.voucher_date <= $2" : "";

  // ── Schema-resilient column probe ────────────────────────────────────────
  // Production may be running with RUN_STARTUP_MIGRATIONS=false so the
  // multi-currency columns (base_debit_amount, base_credit_amount) and the
  // ledger_account opening-balance currency columns may not yet exist.
  // We probe once (two lightweight information_schema lookups) and choose
  // the right SQL form for every subsequent query in this handler.
  // Both probes are run in the same parallel batch as the other startup calls
  // to add zero sequential latency on the happy path.
  const [
    companyRecord,
    companyAccounts,
    parentCompanyId,
    groupedLedgerRows,
    groupedSupplierRows,
    groupedEmployeeRows,
    hasMigratedResult,
  ] = await Promise.all([
    storage.getCompanyById(companyId),
    // Use a raw pool query so we only SELECT the original columns that are
    // guaranteed to exist in every deployment (including pre-migration prod).
    // Drizzle's db.select().from(ledgerAccounts) generates explicit column
    // names from the schema, which includes the new multi-currency columns —
    // those cause a "column does not exist" error on old production schemas.
    pool
      .query<{
        id: number;
        company_id: number;
        code: string;
        name: string;
        account_type: string;
        sub_type: string | null;
        opening_balance: string;
        opening_balance_side: string;
        active: boolean;
        is_hidden: boolean;
        parent_id: number | null;
        deleted_at: string | null;
        created_at: string;
        category: string | null;
      }>(
        `SELECT id, company_id, code, name, account_type, sub_type,
            opening_balance, opening_balance_side, active, is_hidden,
            parent_id, deleted_at, created_at, category
     FROM ledger_accounts
     WHERE company_id = $1 AND deleted_at IS NULL
     ORDER BY code ASC`,
        [companyId]
      )
      .catch(() =>
        // Fallback for schemas where the category column hasn't been added yet
        pool.query<{
          id: number;
          company_id: number;
          code: string;
          name: string;
          account_type: string;
          sub_type: string | null;
          opening_balance: string;
          opening_balance_side: string;
          active: boolean;
          is_hidden: boolean;
          parent_id: number | null;
          deleted_at: string | null;
          created_at: string;
          category: string | null;
        }>(
          `SELECT id, company_id, code, name, account_type, sub_type,
              opening_balance, opening_balance_side, active, is_hidden,
              parent_id, deleted_at, created_at, NULL::text AS category
       FROM ledger_accounts
       WHERE company_id = $1 AND deleted_at IS NULL
       ORDER BY code ASC`,
          [companyId]
        )
      )
      .then((r) =>
        r.rows.map((row) => ({
          id: row.id,
          companyId: row.company_id,
          code: row.code,
          name: row.name,
          accountType: row.account_type,
          subType: row.sub_type,
          openingBalance: row.opening_balance ?? "0",
          openingBalanceSide: row.opening_balance_side ?? "Dr",
          active: row.active,
          isHidden: row.is_hidden,
          parentId: row.parent_id,
          deletedAt: row.deleted_at,
          createdAt: row.created_at,
          category: row.category,
        }))
      ),
    storage.getParentCompanyId(),
    // 1. Ledger-account balances — account-company scoped (migrated-account rule)
    // COALESCE(base_debit_amount, debit_amount): uses historical USD base when available
    // (i.e. after backfill), falls back to debit_amount for legacy rows.
    // Falls back to plain debit_amount/credit_amount when base columns are absent.
    pool
      .query<{ ledger_account_id: string; total_debit: string; total_credit: string }>(
        `SELECT ve.ledger_account_id,
            SUM(COALESCE(ve.base_debit_amount,  ve.debit_amount)::numeric)  AS total_debit,
            SUM(COALESCE(ve.base_credit_amount, ve.credit_amount)::numeric) AS total_credit
     FROM voucher_entries ve
     JOIN vouchers        v  ON ve.voucher_id        = v.id
     JOIN ledger_accounts la ON ve.ledger_account_id = la.id
     WHERE la.company_id = $1
       AND v.optional    = false
       AND v.deleted_at IS NULL
       ${_dateClause}
     GROUP BY ve.ledger_account_id`,
        _entryParams
      )
      .catch(() =>
        pool.query<{ ledger_account_id: string; total_debit: string; total_credit: string }>(
          `SELECT ve.ledger_account_id,
              SUM(ve.debit_amount::numeric)  AS total_debit,
              SUM(ve.credit_amount::numeric) AS total_credit
       FROM voucher_entries ve
       JOIN vouchers        v  ON ve.voucher_id        = v.id
       JOIN ledger_accounts la ON ve.ledger_account_id = la.id
       WHERE la.company_id = $1
         AND v.optional    = false
         AND v.deleted_at IS NULL
         ${_dateClause}
       GROUP BY ve.ledger_account_id`,
          _entryParams
        )
      ),
    // 2. Supplier balances — voucher-company scoped, pure-side only (excludes mixed FX rows)
    pool
      .query<{ supplier_id: string; total_debit: string; total_credit: string }>(
        `SELECT ve.supplier_id,
            SUM(CASE WHEN COALESCE(ve.base_debit_amount,  ve.debit_amount)::numeric  > 0
                          AND COALESCE(ve.base_credit_amount, ve.credit_amount)::numeric = 0
                     THEN COALESCE(ve.base_debit_amount, ve.debit_amount)::numeric ELSE 0 END) AS total_debit,
            SUM(CASE WHEN COALESCE(ve.base_credit_amount, ve.credit_amount)::numeric > 0
                          AND COALESCE(ve.base_debit_amount,  ve.debit_amount)::numeric  = 0
                     THEN COALESCE(ve.base_credit_amount, ve.credit_amount)::numeric ELSE 0 END) AS total_credit
     FROM voucher_entries ve
     JOIN vouchers v ON ve.voucher_id = v.id
     WHERE v.company_id    = $1
       AND ve.supplier_id IS NOT NULL
       AND v.optional      = false
       AND v.deleted_at   IS NULL
       ${_dateClause}
     GROUP BY ve.supplier_id`,
        _entryParams
      )
      .catch(() =>
        pool.query<{ supplier_id: string; total_debit: string; total_credit: string }>(
          `SELECT ve.supplier_id,
              SUM(CASE WHEN ve.debit_amount::numeric  > 0 AND ve.credit_amount::numeric = 0
                       THEN ve.debit_amount::numeric ELSE 0 END) AS total_debit,
              SUM(CASE WHEN ve.credit_amount::numeric > 0 AND ve.debit_amount::numeric  = 0
                       THEN ve.credit_amount::numeric ELSE 0 END) AS total_credit
       FROM voucher_entries ve
       JOIN vouchers v ON ve.voucher_id = v.id
       WHERE v.company_id    = $1
         AND ve.supplier_id IS NOT NULL
         AND v.optional      = false
         AND v.deleted_at   IS NULL
         ${_dateClause}
       GROUP BY ve.supplier_id`,
          _entryParams
        )
      ),
    // 3. Employee balances — voucher-company scoped
    pool
      .query<{ employee_id: string; total_debit: string; total_credit: string }>(
        `SELECT ve.employee_id,
            SUM(COALESCE(ve.base_debit_amount,  ve.debit_amount)::numeric)  AS total_debit,
            SUM(COALESCE(ve.base_credit_amount, ve.credit_amount)::numeric) AS total_credit
     FROM voucher_entries ve
     JOIN vouchers v ON ve.voucher_id = v.id
     WHERE v.company_id    = $1
       AND ve.employee_id IS NOT NULL
       AND v.optional      = false
       AND v.deleted_at   IS NULL
       ${_dateClause}
     GROUP BY ve.employee_id`,
        _entryParams
      )
      .catch(() =>
        pool.query<{ employee_id: string; total_debit: string; total_credit: string }>(
          `SELECT ve.employee_id,
              SUM(ve.debit_amount::numeric)  AS total_debit,
              SUM(ve.credit_amount::numeric) AS total_credit
       FROM voucher_entries ve
       JOIN vouchers v ON ve.voucher_id = v.id
       WHERE v.company_id    = $1
         AND ve.employee_id IS NOT NULL
         AND v.optional      = false
         AND v.deleted_at   IS NULL
         ${_dateClause}
       GROUP BY ve.employee_id`,
          _entryParams
        )
      ),
    // Phase 6 guard: any entry with base_debit_amount set means COALESCE already
    // returns the correct historical USD base — legacy CFA revaluation must NOT run.
    // Falls back to { has_migrated: false } when column doesn't exist yet.
    pool
      .query<{ has_migrated: boolean }>(
        `SELECT EXISTS(
       SELECT 1 FROM voucher_entries ve
       JOIN vouchers v ON ve.voucher_id = v.id
       WHERE v.company_id = $1
         AND ve.base_debit_amount IS NOT NULL
     ) AS has_migrated`,
        [companyId]
      )
      .catch(() => ({ rows: [{ has_migrated: false }] })),
  ]);
  // true  → some entries have base_debit_amount → COALESCE returns USD base → skip legacy revaluation
  // false → all entries are pre-migration legacy OR base column absent → legacy CFA revaluation block applies
  const hasMigratedEntries = resultRows(hasMigratedResult)[0]?.has_migrated === true;
  const companyBaseCurrency = companyRecord?.baseCurrency || "USD";

  // Build accountBalances from grouped SQL result.
  // Account-company scoped: migrated accounts carry their full balance to the
  // destination company regardless of which company their vouchers belong to.
  const accountBalances = new Map<number, { debit: number; credit: number }>();
  for (const row of groupedLedgerRows.rows) {
    if (row.ledger_account_id) {
      accountBalances.set(Number(row.ledger_account_id), {
        debit: parseFloat(row.total_debit || "0"),
        credit: parseFloat(row.total_credit || "0"),
      });
    }
  }

  // Build supplierBalances from grouped SQL result.
  // Pure-side filtering is performed in SQL (CASE expressions above) so mixed
  // debit+credit FX settlement rows contribute 0 to both sides — matching the
  // /api/suppliers/stats logic and the original per-row application filter.
  const supplierBalances = new Map<number, { debit: number; credit: number }>();
  for (const row of groupedSupplierRows.rows) {
    if (row.supplier_id) {
      supplierBalances.set(Number(row.supplier_id), {
        debit: parseFloat(row.total_debit || "0"),
        credit: parseFloat(row.total_credit || "0"),
      });
    }
  }

  // Build employeeBalances from grouped SQL result (voucher-company scoped).
  const employeeBalances = new Map<number, { debit: number; credit: number }>();
  for (const row of groupedEmployeeRows.rows) {
    if (row.employee_id) {
      employeeBalances.set(Number(row.employee_id), {
        debit: parseFloat(row.total_debit || "0"),
        credit: parseFloat(row.total_credit || "0"),
      });
    }
  }
  return {
    companyRecord,
    companyAccounts,
    parentCompanyId,
    hasMigratedEntries,
    companyBaseCurrency,
    accountBalances,
    supplierBalances,
    employeeBalances,
  };
}
