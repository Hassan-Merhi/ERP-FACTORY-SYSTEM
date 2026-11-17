import type { Pool } from "pg";

/**
 * Voucher balance guard (2026-10 accounting audit, waves 8.5, 9 and 12).
 *
 * A deferred constraint trigger: at COMMIT, an active (not deleted, not
 * optional) voucher must have debits equal to credits, so a writer may add
 * lines one by one inside its transaction and fails only if it leaves the
 * voucher unbalanced.
 *
 * v3 (wave 12, owner decision 1):
 *   - History is marked once, at the first v3 install, by an immutable column
 *     `vouchers.balance_guard_exempt_history`: it is added with DEFAULT true
 *     (every existing row is history, a catalogue-only change that rewrites
 *     nothing and fires no trigger), then its default becomes false. A trigger
 *     forces it to false on every insert and refuses any change to it, so no
 *     application path, bypass setting or imported `created_at` can make a
 *     voucher history. History vouchers are never checked and stay editable;
 *     the integrity diagnostic keeps reporting them. `created_at` is no longer
 *     read.
 *   - The stock adjustment types (Stock Adjustment, Production, Consumption,
 *     Mixed) are exempt only when the voucher has stock_adjustment_items rows
 *     (through stock_adjustment_vouchers) AND all its lines are on one side,
 *     before the company's perpetual-inventory cut-over or in a supplier-partner
 *     company (the stock sub-ledger carries the contra under periodic
 *     inventory). A two-sided stock voucher must balance. From a
 *     non-supplier-partner company's cut-over a stock voucher carries its
 *     inventory line and must balance, as in v2. Only the stock adjustment
 *     writers create these types (the generic voucher routes refuse them).
 *   - The base columns (debit_amount / credit_amount, USD) are always checked,
 *     rounded to cents. When every line shares one transaction currency the
 *     transaction columns must balance to the cent too, and the base columns may
 *     then differ by one cent at most (per-line conversion rounding).
 *   - Re-activating, re-dating, moving or re-typing a voucher is checked (the
 *     vouchers trigger fires on optional, deleted_at, voucher_date, company_id,
 *     voucher_type and created_at); removing a voucher's stock adjustment rows
 *     re-checks it as well.
 *
 * v5 (phase 19 B), D1: a history voucher is checked when its lines change (a
 * line inserted, deleted, or its voucher, targets or amounts changed): it must
 * balance after the edit. Header-only and narration edits of history vouchers
 * stay unchecked. (D5 — two lines and header total = line total — is reported
 * by the integrity diagnostic, `voucher_shape_new`, not enforced here: see the
 * phase 19 B wave log entry.)
 *
 * v6 (phase 22 A), D3 (owner decision): every non-history voucher balances
 * exactly in its 2 dp base columns (base tolerance 0); history keeps the
 * one-cent tolerance of single-currency vouchers. The central posting engine
 * adds a ROUNDING line for the per-line conversion remainder (engineRounding.ts)
 * and marks its vouchers (`vouchers.posted_by_engine`, set once, never
 * cleared); in-place line writers call rebalanceVoucherRoundingTx. The
 * ROUNDING line (USD) is left out of the transaction-currency check.
 *
 * A reviewed repair can `SET LOCAL app.ledger_integrity_bypass = 'on'` for its
 * own transaction; the bypass skips the balance check, never the history marker.
 *
 * The functions, the constraint triggers and the marker columns are defined by
 * the schema migrations (migrations/); nothing is installed at runtime.
 */

/** The immutable history marker column. */
export const VOUCHER_HISTORY_MARKER_COLUMN = "balance_guard_exempt_history";

/** Expected version: the comment on erp_voucher_balance_check(integer). */
export const VOUCHER_BALANCE_GUARD_VERSION = "2026-10-voucher-balance-v6";

/** v6: set by the central posting engine (voucherPostingService); set once, never cleared. */
export const VOUCHER_ENGINE_MARKER_COLUMN = "posted_by_engine";

/** Every trigger of the guard, as `[table, trigger]`. */
export const VOUCHER_BALANCE_GUARD_TRIGGERS: ReadonlyArray<readonly [table: string, trigger: string]> = [
  ["voucher_entries", "voucher_entries_balance_guard"],
  ["vouchers", "vouchers_balance_guard"],
  ["vouchers", "vouchers_balance_guard_history_marker"],
  ["stock_adjustment_vouchers", "stock_adjustment_vouchers_balance_guard"],
  ["stock_adjustment_items", "stock_adjustment_items_balance_guard"],
];

type Queryable = { query: Pool["query"] };

const TRIGGER_NAMES_SQL = VOUCHER_BALANCE_GUARD_TRIGGERS.map(([, name]) => `'${name}'`).join(", ");

/**
 * The installed guard version, or null when any trigger or the history marker
 * is missing.
 */
export async function installedVoucherBalanceGuardVersion(client: Queryable): Promise<string | null> {
  const result = await client.query<{ version: string | null }>(
    `SELECT obj_description(to_regprocedure('erp_voucher_balance_check(integer)'), 'pg_proc') AS version
      WHERE (SELECT COUNT(DISTINCT tgname) FROM pg_trigger
              WHERE NOT tgisinternal AND tgname IN (${TRIGGER_NAMES_SQL})) = ${VOUCHER_BALANCE_GUARD_TRIGGERS.length}
        AND EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2)`,
    ["vouchers", VOUCHER_HISTORY_MARKER_COLUMN]
  );
  return result.rows[0]?.version ?? null;
}
