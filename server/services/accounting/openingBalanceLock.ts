import type { Pool } from "pg";

/**
 * Opening balances under the period lock (wave 12, re-audit section 8).
 *
 * Master opening balances (ledger accounts, customers, suppliers, bank
 * accounts, employees; factory suppliers and fixed assets since wave 16 B) are dated before the books start, so they sit inside
 * the first closed period: changing one after a close changes balances the
 * closing journal already moved. Rule chosen: once a company has ANY closed
 * fiscal period, no opening on those tables may be created non-zero, changed,
 * or moved to another company. Corrections are posted as a journal dated in
 * an open period, or the period is reopened.
 *
 * Enforced by BEFORE triggers so every writer (master edit routes,
 * zero-balances, imports, resets) is covered. The bypass is the closed-period
 * guard's: only a transaction-local `app.closed_period_override = 'on'` (set
 * by the fiscal reopen when it restores a legacy close's zeroed openings); the
 * maintenance scope no longer passes (phase 19 B). The rejection carries the
 * closed-period SQLSTATE and marker, so routes map it to 409 with
 * closedPeriodErrorResponse / errorStatus. A shared advisory lock on the
 * company serialises the check against a concurrent close.
 *
 * erp_assert_opening_balance_open, erp_opening_balance_lock_guard and the
 * `<table>_opening_balance_lock` triggers are defined by the schema migrations
 * (migrations/); nothing is installed at runtime. The version is the COMMENT on
 * erp_opening_balance_lock_guard(), read by installedOpeningBalanceLockVersion
 * and the integrity diagnostic.
 */

export const OPENING_BALANCE_LOCK_TABLES = [
  "ledger_accounts",
  "customers",
  "suppliers",
  "bank_accounts",
  "employees",
  // Wave 16 (B): the engine counts both openings (a factory supplier's is Cr
  // when it has no side, a fixed asset's always Dr). Neither table has an
  // opening_balance_side column, so the trigger reads the row generically.
  "factory_suppliers",
  "fixed_assets",
] as const;

/**
 * v3 (phase 19 B): the maintenance scope no longer bypasses the lock (DI2,
 * erp_closed_period_guard_bypassed), and deleting a master after a close is
 * locked too (DI4): a hard DELETE, or a soft delete / restore (deleted_at set
 * or cleared), of a row whose opening is not zero.
 */
export const OPENING_BALANCE_LOCK_VERSION = "2026-10-opening-balance-lock-v3";

export const openingBalanceLockTriggerName = (table: string) => `${table}_opening_balance_lock`;

type Queryable = { query: Pool["query"] };

/** The installed lock version, or null when any of its triggers is missing. */
export async function installedOpeningBalanceLockVersion(client: Queryable): Promise<string | null> {
  const names = OPENING_BALANCE_LOCK_TABLES.map((table) => `'${openingBalanceLockTriggerName(table)}'`).join(", ");
  const result = await client.query<{ version: string | null }>(
    `SELECT obj_description(to_regprocedure('erp_opening_balance_lock_guard()'), 'pg_proc') AS version
      WHERE (SELECT COUNT(DISTINCT tgname) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (${names}))
            = ${OPENING_BALANCE_LOCK_TABLES.length}`
  );
  return result.rows[0]?.version ?? null;
}
