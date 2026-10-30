# Phase 16 — Weekly production bonus release certification

Status: **implementation and audit regression coverage added; production certification PENDING**.

Branch: `feature/production-target-bonuses-unified` (Phases 1–16). Do not merge to main or deploy Render while the blocking gates remain open.

## Implemented in Phase 16

1. Reconciliation policy and read-only route `GET /api/factory/production-target-bonuses/weekly-reconciliation?start=YYYY-MM-DD&end=YYYY-MM-DD` available only to company-scoped Admin/Owner with Production Targets access. It never mutates financial records.
2. Per-payment checks verify worker/week review identity and approved amount; expense account is the company's `PAYROLL_DEPOSIT_EXPENSE`; paying account is a company Cash/Bank account; Payment voucher is present, live, dated correctly, denominated in USD, and exactly balances two entries: debit expense and credit Cash/Bank.
3. For POSTED claims, exactly one positive USD Daybook source entry is required and no reversal. For REVERSED claims, the reversing Receipt voucher must reverse both entry sides, and exactly one negative Daybook entry must reconcile. Zero rows do not qualify as proof of financial posting.
4. Permanent claims remain one per company/worker/week even following reversal; cross-method daily review/payment collisions and effective-week method exclusivity remain in effect.
5. Weekly source-backed Daybook transaction types are registered in the integrity registry so valid entries are visible and invalid sources can be excluded.
6. The payment admin panel exposes a **Verify accounting** button and immutable discrepancy list; it never silently repairs vouchers or marks a worker as paid.
7. Added Vitest cases for balanced payment/reversal, missing/wrong voucher sides, bad company/account, duplicate Daybook entries, JSONB-stable hashes and Phase 1–16 startup/routing/accounting UI wiring.
8. Wording corrected after posting was added: an approved review is not inherently unpaid; actual payment status comes from the dedicated payment ledger.

## Business cases covered in calculation/approval/payout code

- 56 target and 56 produced: no weekly-flat bonus. 57/56 and 90/56: same configured flat fee once.
- Linked and unlinked credited bale allocation across days; category switching does not create multiple awards.
- Monday–Sunday Asia/Beirut date boundaries and completed weeks only.
- One effective weekly method (weekly-flat versus the daily per-bale/category approval paths); old reviewed/posted records are not rewritten.
- Permission and company isolation; stale review hash/expected amount; missing immutable physical-bale capture; duplicate bale across days.
- Selected Cash/Bank account; USD-only exact cents; balanced expense/cash posting; idempotency; reversal never reopens the entitlement.
- Formatted Excel audit totals and statuses, with names escaped against spreadsheet formulas.

## Production certification gates (blockers)

These are not marked passed merely because source and tests have been committed:

- **CI**: GitHub Actions full typecheck, lint/format, build, test suites, security/CodeQL/Semgrep and required policy workflows must all finish successfully at the same final head SHA.
- **PostgreSQL integration**: Test unconditional startup DDL and immutable review trigger against real PostgreSQL, not only string/mock assertions.
- **Actual accounting**: Run a company-scoped sandbox round-trip (approve → post → validate voucher entries and Daybook → idempotent retry → reverse → cannot pay again) and ensure `weekly-reconciliation` returns zero discrepancies on the test postings. Verify the chosen Cash/Bank account and Deposit Expense balances with an independent GL query.
- **Concurrent transaction testing**: race two approved worker/week posting requests and daily-vs-weekly posting attempts; prove exactly one voucher, claim and Daybook entry, and all-or-nothing rollback.
- **Tenant/security**: send worker IDs, account IDs, review IDs and payment IDs belonging to a different company; test non-Admin, non-Owner, view-only and pressing-worker roles get no financial access.
- **Review deployment**: code review for existing Production Planner/payroll paths that might not share the 84023 company lock; if any can grant another award for the same worker/week, add reciprocal exclusion before live enablement.
- **Manual UX/Excel**: verify dates, confirmation, amount/account/worker display, category-switch balances, export totals, and empty/no-posting reconciliation.

No main merge, Render deploy, voucher posting or live employee payments are part of Phase 16 work in this branch.

## Safe certification decision

- **SOURCE IMPLEMENTED** when the branch contains the files and wiring.
- **TESTED** only when CI records exact-sha passing test/build results and real PostgreSQL accounting scenarios pass.
- **PRODUCTION CERTIFIED** only when all the gates above pass and an authorized reviewer approves release.

Current designation: **SOURCE IMPLEMENTED — NOT YET PRODUCTION CERTIFIED**.
