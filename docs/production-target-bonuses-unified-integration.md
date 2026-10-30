# Production Targets bonuses — unified Phases 1–7 integration

## Sources and selection
- **Phase 1+2:** PR #2602 / feature/production-bonus-core: finalized daily excess-bale calculator and effective-dated company/worker USD rates.
- **Phase 3+4:** PR #2604 / feature/production-target-bonuses-phases-3-4: bonus panel and per-worker/day approvals.
- **Phase 5+6:** PR #2606 / feature/production-target-bonuses-phases-5-6: one canonical Cash/Bank payment workflow, Payroll Deposit Expense voucher/Daybook, duplicate and reversal controls.
- **Phase 7:** PR #2603 / feature/production-target-bonuses-phase7-reporting: bonus history, worker statements and four-sheet Excel.
- **Excluded on purpose:** alternative payment implementation PR #2605 / feature/production-bonus-accounting. Do not merge both claim tables/routes.

## Reconciliation
- Runtime startup ensures both the versioned Phase 1 bonus settings schema and Phase 3 reviews before the Phase 5 accounting claim.
- The Phase 3 review rate is read from the authoritative Phase 1 rate table. Its editor appends a dated worker override instead of updating the independent legacy rate table.
- The review/approval, payment and read-only report routes use the same factory-company scope and Production Targets tab access.
- Approved/rejected review snapshots are immutable. Reported POSTED requires actual voucher and Cash/Bank account; reversed payments count as VOIDED, never paid again.
- Reporting projects finalized pending rows using the same review loader and attaches frozen review and payment data, even if operational rows have changed.
- Legacy payroll approval and direct target bonus payment use matching advisory locks and collision checks.

## Mandatory pre-merge acceptance gates
1. Repository TypeScript check, client build, route-manifest snapshot validation and all target-bonus unit tests.
2. Real PostgreSQL startup schema + transaction tests (review → selected account → balanced Payroll Deposit Expense / Cash or Bank voucher → Daybook → reversal).
3. Verify payroll collision, retries, multi-company boundaries, authorized roles, approved snapshot immutability and USD-only safeguards.
4. Verify that Phase 1 calculator and Phase 3 approval match exactly for historical linked/unlinked workers, absent days, targets, odd-bale splits and production categories. **These are separate calculator implementations today; do not deploy payout until parity is proven.**
5. Verify the report's worker identity/time history; worker names are presently loaded from the current worker record, not stored as an immutable review-time name.
6. Require user approval to merge into main and deploy on Render separately from this integration branch.

## Explicitly out of scope here
Category-specific editable rates (Bags/Toys/Shoes etc.), intra-day switching and category-weighted payments are the follow-on new phases; they are NOT yet approved payout logic on this branch. No live financial posting, no production DB changes, no merge to main, and no deployment from this consolidation.
