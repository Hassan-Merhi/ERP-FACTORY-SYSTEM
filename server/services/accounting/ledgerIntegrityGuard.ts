/**
 * Ledger integrity guards (2026-10 accounting audit, wave 4).
 *
 * Production held posted lines on hard-deleted accounts (there was no foreign
 * key on voucher_entries.ledger_account_id), on soft-deleted accounts, on
 * another company's accounts and with negative amounts, and accounts carrying
 * history had been deleted. These guards stop new cases at the database,
 * whatever code path writes:
 *   - foreign keys (ON DELETE RESTRICT) from voucher_entries to ledger, bank and
 *     fixed-asset accounts, so an account with lines cannot be hard-deleted;
 *   - CHECK constraints: amounts non-negative, at most one side per line;
 *   - a BEFORE trigger on voucher_entries: a new line (or one whose targets
 *     change) has one owner under the engine's attribution — one account
 *     (ledger, bank or fixed asset; a bank with its linked ledger counts once)
 *     with at most one party tag, or one party alone (wave 16 B); every
 *     account a line names belongs
 *     to the line's company (a supplier may belong to the parent company or a
 *     subsidiary: the group shares suppliers in intercompany POs) and is not
 *     deleted;
 *   - a BEFORE trigger on ledger_accounts: an account whose balance (opening
 *     plus posted lines; a sideless opening on its type's side, as the engine
 *     reads it — wave 16 B) is not zero cannot be soft-deleted;
 *   - the same BEFORE trigger on bank_accounts (wave 18 B, v3): a bank whose
 *     opening plus the lines it owns under the engine's rule is not zero cannot
 *     be soft-deleted;
 *   - the account tree (phase 19 B, v4): a parent foreign key and a BEFORE
 *     trigger refusing a parent of another company, a deleted parent, a parent
 *     of another class (classifyAccountType) and cycles.
 *
 * Existing rows are left as they are: constraints are NOT VALID and the line
 * trigger only checks accounts when they are set or changed. The accounting
 * integrity diagnostic reports the existing cases for a reviewed correction.
 *
 * A reviewed repair can `SET LOCAL app.ledger_integrity_bypass = 'on'` for its
 * own transaction; nothing in the application does.
 *
 * The constraints, functions (erp_ledger_integrity_bypassed,
 * erp_voucher_entry_target_guard, erp_ledger_account_class,
 * erp_default_ledger_opening_side, erp_ledger_account_tree_guard, ...) and
 * triggers are defined by the schema migrations (migrations/); nothing is
 * installed at runtime. erp_ledger_account_class and
 * erp_default_ledger_opening_side mirror accountClassification's type lists
 * (pinned by tests/ledger-integrity-guard-scope.test.ts).
 */
/** Phase 19 (B), C5: the parent foreign key and the tree trigger on ledger_accounts. */
export const LEDGER_ACCOUNT_PARENT_FK = "ledger_accounts_parent_id_fkey";
export const LEDGER_ACCOUNT_TREE_TRIGGER = "ledger_accounts_tree_guard";

/**
 * Expected version of the guards: the comment on erp_voucher_entry_target_guard()
 * (read by the integrity diagnostic).
 */
export const LEDGER_INTEGRITY_GUARD_VERSION = "2026-10-ledger-integrity-v4";

// The integrity diagnostic checks these constraints as well as the version.
export const LEDGER_GUARD_CONSTRAINTS: readonly string[] = [
  "voucher_entries_ledger_account_id_fkey",
  "voucher_entries_bank_account_id_fkey",
  "voucher_entries_fixed_asset_id_fkey",
  "voucher_entries_amounts_non_negative",
  "voucher_entries_single_side",
];
