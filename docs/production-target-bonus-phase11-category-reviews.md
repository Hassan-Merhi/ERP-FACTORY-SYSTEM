# Phase 11 — Immutable category bonus review and approval

Branch: `feature/production-target-bonuses-unified` (continuing Phases 1–10).

## Implemented

1. Owner/Admin sees Phase 10 frozen category proposal and may **approve or
   reject** one eligible worker/date with an explicit confirmation modal.
   The amount is the sum of category-specific excess-bale bonuses, rounded
   once per worker/day, as calculated by the server.
2. An opaque SHA-256 `reviewToken` signs a deterministic JSON payload with
   date, worker ID/display name, calculation version, overall target/credits,
   extra bales, exact USD amount, category-level credited/target/extra bales,
   dated rate version IDs and rates, and six-decimal intermediate amounts.
   Category lines are sorted before hashing. A stale amount, source or rate
   returns 409 and requires a fresh preview.
3. `POST /api/factory/production-target-bonuses/category-reviews/decide`
   requires `confirm: true`, worker ID, date, `approved|rejected`,
   exact 2-decimal expected USD string, matching 64-char `reviewToken`,
   and optional review note. The backend checks company/tab/role/session.
4. The approval transaction takes company advisory lock `84023` (same as
   Phase 3/4 daily review and Phase 5/6 money posting), rejects any existing
   legacy worker/day review and eligible payroll bonus/payroll claim,
   loads current Phase 10 evidence/rates through the same transaction,
   confirms the exact token, amount and locked target-allocation set, then
   inserts exactly one immutable review. Rejection is also an immutable
   audit decision; it does **not** create cash movement.
5. `factory_target_bonus_category_reviews` has UNIQUE company/date/worker,
   source allocation-set FK, per-category frozen JSONB detail and fingerprint,
   reviewer, date, note, original USD amount, status and calculation version.
   A PostgreSQL BEFORE UPDATE/DELETE trigger prevents accidental rewriting
   or deletion of approvals. Identical confirmed retries replay 200; any
   conflicting second decision returns 409.
6. The existing legacy worker/day approval route now checks the category
   review table **under the same lock** and rejects a conflicting legacy
   review, preventing the reverse direction of double approval.
7. `GET /api/factory/production-target-bonuses/category-reviews?date=...`
   displays frozen category snapshots, statuses and review history only for
   the current authorized company. The UI labels an approved decision as
   **"Approved · not paid"**, not as an expense or completed payment.
8. Regression tests cover snapshot fields, deterministic category order,
   changed source/rate/version/amount/worker/date tokens and exclusion of
   any payment-account or voucher fields.

## Not part of Phase 11

- The old payment service intentionally reads **only**
  `factory_target_bonus_reviews`. Category reviews are stored separately
  and are not accidentally payable through the legacy posting endpoint.
- No Payroll Deposit Expense, Cash/Bank, vouchers, Daybook, salary payroll
  or other financial movement. Phase 12+ must integrate category approvals
  with **one** claim/posting workflow and reconciliation against legacy
  production bonuses and existing payroll.
- Reviewed category snapshots are not recalculated by later category-rate
  edits, production changes or historical report refreshes.
- Category excess vs the aggregate daily excess still needs the intended
  financial policy confirmed during the payment integration.

## Release/verification gates

TypeScript, route-manifest snapshot, frontend/backend tests, i18n ratchet,
DB migration/trigger tests and real PostgreSQL transactional collisions
(legacy approval vs category, simultaneous same/different decisions,
unfinalized days, cross-company access, salary-payroll conflict) must pass.
The earlier Phases 1–10 release blockers also apply.

This branch stays draft; do not merge into main or deploy Render before
production financial certification.
