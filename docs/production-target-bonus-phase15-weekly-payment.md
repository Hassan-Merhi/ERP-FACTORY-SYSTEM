# Phase 15 — Weekly flat-bonus payment posting, Deposit Expense, reversal and Excel

Branch: `feature/production-target-bonuses-unified`. No main merge, deployment or live payment was requested.

## Implemented code

- The separate **Weekly Flat Bonus Payments** panel is mounted alongside the existing daily bonus payment panel under Production Targets. Admin/Owner users can select Monday-start weeks (up to 366 days apart), select only immutable approved/unpaid worker/week decisions, pick an active USD Cash or Bank account, choose a payment date, review the amount and explicitly confirm posting.
- Payment history endpoint: `GET /api/factory/production-target-bonuses/weekly-payments?start=...&end=...`. Company-scoped, role/tab guarded, no-store, includes approved/rejected reviews, permanent payment claim status, Voucher ID, account, and frozen category breakdown.
- Financial posting endpoint: `POST /api/factory/production-target-bonuses/weekly-payments/post`, with `confirm: true`, exact USD amount, payment date, Cash/Bank account ID and up to 100 distinct `weekStart + workerId` selections.
- The financial service holds the **same per-company review/payment advisory lock 84023** used by earlier phases and posts all selected workers in **one database transaction**, rolling back all vouchers and Daybook entries if any selection fails.
- It verifies the stored immutable weekly review **and canonical SHA-256 snapshot** including company/worker, selected fee version, dates, credits and amount. PostgreSQL JSONB key reordering does not invalidate the fingerprint.
- Each approved worker/week creates an idempotently sourced **Payment voucher**: Debit **Payroll Deposit Expense**, Credit the chosen active **Cash / Bank** ledger account; USD only, no assumed FX. It creates a Factory Daybook entry, complete payment claim and actor audit log.
- Payment date must be at least the week end. A rejected review, changed expected amount, unapproved worker, missing/mismatched method, foreign-company worker, prior per-day review/payment/position bonus, or approved/paid salary payroll overlap prevents a new payout.
- Exactly matching retries return the original payment and voucher; changed details return a conflict. **Reversed claims are never reopened**, preventing the same worker/week being paid twice automatically.
- Confirmed reversal endpoint `POST /api/factory/production-target-bonuses/weekly-payments/:id/reverse` requires a reason and date. It posts a reversing **Receipt voucher** (Debit Cash/Bank, Credit Payroll Deposit Expense), negative Daybook entry, audit, and marks the existing claim `REVERSED`. The original claim remains.
- The older direct **daily** bonus payment service now refuses *new* payments that would overlap a weekly review or a configured `weekly_flat` method. Its exact prior paid-payment replay behavior is preserved.
- Weekly payments have their own `factory_target_bonus_weekly_payments` table, created in the existing unconditional factory bonus payment startup flow, after weekly review tables, with unique company/review, company/worker/week, and payment voucher IDs, and permanent reversal-state checks.
- **Export Excel** creates `Weekly_Production_Bonuses_<start>_to_<end>.xlsx` with formatted `Weekly Bonus Audit` and `Worker Totals` sheets. Exports frozen worker/week amounts rather than multiplying categories or linked shares; shows payment status, Cash/Bank account, vouchers and reversals separately. Names are escaped against spreadsheet formulas.

## Financial safety and limits

One worker/week is one reviewed flat bonus, even if the person moves across Bags, Toys, Shoes or more. Weekly **review approval** is separate from **payment posting**. No payroll salary merge or automatic deposit is claimed; this is the same reviewed-bonus direct Cash/Bank payment workflow as earlier per-bale awards.

The new accounting workflow is not production certified until Phase 16 completes end-to-end verification of tenant permissions, actual PostgreSQL DDL, dollar amounts, payment and reversal vouchers, concurrent reviews and payouts, duplicate source bales, export totals, and all critical CI checks. Do not merge/deploy before those checks are green.
