import { CLOSED_PERIOD_ERROR_CODE } from "../../lib/closedPeriodError";

/**
 * Database-enforced closed-period lock.
 *
 * The guard functions (erp_closed_period_guard_bypassed, erp_assert_accounting_date_open,
 * erp_assert_voucher_open, erp_vouchers_closed_period_guard,
 * erp_voucher_entries_closed_period_guard) and the triggers
 * vouchers_closed_period_guard / voucher_entries_closed_period_guard are
 * defined by the schema migrations (migrations/); nothing is installed at runtime.
 *
 * A fiscal close (closeFiscalPeriod in storage/accounting/fiscal-periods.ts)
 * posts a closing journal and records a fiscal_period_closures row, but nothing
 * stopped later writes dated inside the closed range: the balances the closing
 * journal moved to retained earnings could change underneath it. Vouchers are
 * written from dozens of routes and services, so the guard lives in BEFORE
 * triggers on vouchers and voucher_entries instead of in each caller.
 *
 * Rule: once a company has a CLOSED fiscal period, no voucher dated on or
 * before the latest closed period_end_date may be created, deleted, or have its
 * financial content changed (company, dates, type, amounts, currency, rate,
 * optional flag, soft-delete; for lines: voucher, accounts, parties, amounts).
 * Descriptions and narrations stay editable. Both voucher_date and
 * effective_date are checked because reports date by either.
 *
 * Bypass: only an explicit transaction-local
 * `SET LOCAL app.closed_period_override = 'on'`, which only the fiscal reopen
 * sets (storage/accounting/fiscal-periods.ts, audited with the reopen).
 * Phase 19 (B), DI2: the maintenance database scope (boot steps, scheduler
 * ticks, repairs) no longer bypasses it; process-owned writers post in a
 * company's tenant scope and skip a closed date themselves
 * (scheduledPostingScope.ts), and the trigger stays the backstop.
 *
 * Concurrency: every guarded write takes a shared advisory lock on the company
 * and closeFiscalPeriod takes the exclusive one, so a close cannot compute its
 * balances while another transaction is still writing into the period.
 */

export { CLOSED_PERIOD_ERROR_CODE };
export const CLOSED_PERIOD_LOCK_NAMESPACE = 74_122;

/**
 * Expected version of the guard: the comment on erp_closed_period_guard_bypassed()
 * (read by the integrity diagnostic). The functions and triggers themselves are
 * defined by the schema migrations (migrations/).
 */
export const CLOSED_PERIOD_GUARD_VERSION = "2026-10-closed-period-v2";

export { isClosedPeriodError, closedPeriodErrorResponse } from "../../lib/closedPeriodError";
