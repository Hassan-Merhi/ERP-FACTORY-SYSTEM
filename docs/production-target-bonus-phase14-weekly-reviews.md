# Phase 14 — Immutable weekly flat-bonus reviews and approvals

Branch: `feature/production-target-bonuses-unified`, continuing Phases 1–13.

## Implemented

- Admin/Owner reviews an eligible completed Monday–Sunday worker/week in Production Targets → Production Bonuses → Weekly flat bonus eligibility.
- Explicit **Approve / Reject** actions open a confirmation dialog showing the worker, week and exact proposed USD flat amount. Notes are optional (up to 500 characters).
- `GET /api/factory/production-target-bonuses/weekly-reviews?weekOf=YYYY-MM-DD` returns frozen company-scoped decisions and historical snapshots. `POST /api/factory/production-target-bonuses/weekly-reviews/decide` requires `confirm: true`, Monday `weekStart`, worker ID, `approved|rejected`, exact `expectedAmount`, a SHA-256 `reviewToken`, and optional note.
- Server previews include review tokens **only for currently eligible workers**. SHA-256 covers company, Monday/Sunday, worker ID/name, source calculation version, effective weekly method version, USD fee/amount, weekly target/credits/excess, worked and absent days, daily attributed production, and category contributions in stable order.
- The confirmed decision runs in a database transaction holding the **same company advisory lock 84023** used by the legacy/category bonus approval and payment paths. It recalculates Phase 13 from authoritative frozen evidence **inside that transaction**, checks the submitted amount/token, worker-company ownership, and overlapping approved/paid salary payroll. Missing, unfinalized, changed, blocked, already reviewed, or ineligible source cannot be approved/rejected.
- Immutable `factory_target_bonus_weekly_reviews` has a unique company + week + worker decision, source method-version FK, frozen target/credits/extra/amount, JSONB canonical snapshot, SHA-256 fingerprint, status, reviewer, time and note. A BEFORE UPDATE/DELETE trigger prevents modifying or deleting a decision.
- Identical confirmed retries replay without duplicating records; a changed decision/note/amount/token returns HTTP 409.
- Both legacy and category **worker/day approval endpoints** now check the weekly review under company lock 84023 and reject any worker/day covered by an existing weekly review.
- Once the company-selected effective method for a week is `weekly_flat`, the legacy per-bale and category approval routes reject **new** daily decisions for that week; earlier immutable daily decision replays remain valid. Weekly decisions still reject any existing daily review from that week. Conversely, the weekly decision checks all legacy/category worker/day reviews and factory bonus payroll claims through Phase 13's authoritative calculation.
- Phase 12 method changes now use the same company review lock and reject a newly backdated method version that would affect a reviewed week. Saved historical versions and reviewed snapshots are not mutated.
- SQL created in the unconditional factory startup schema after the weekly method, category evidence and daily review tables, including when optional bulk migrations are disabled.

## Explicit non-financial boundary

This phase creates **audit-only immutable decisions**. `approved` means **approved but not paid**. It does not create any payment claim, voucher, ledger entry, Deposit Expense, cash/bank movement, payroll posting, Daybook entry or worker salary. Posting and anti-double-spend accounting reconciliation are Phase 15.

## Examples

Weekly target 56; credited 55 or 56 → no eligible approval.
Weekly target 56; credited 57 or 90 → a single configured flat fee, provided source is verified, that week is complete, no review/claim overlaps and the company selected weekly-flat for that week.
Linked/unlinked workers and category switches contribute to one worker/week calculation, never duplicate fees for one source bale.

## Verification still needed before production

- `npm run check`, targeted Vitest suites (Phase 13 weekly calculation, Phase 14 fingerprint), frontend/route tests and release gates.
- PostgreSQL tests: startup schema and trigger, unique company/week/worker, two simultaneous decisions, stale review token, changed fee/version or source, cross-company role access, weekly-vs-daily approval races in both orders, salary payroll collisions and immutable edits.
- CI and manual review; do **not** merge to main or deploy Render as part of Phase 14.
