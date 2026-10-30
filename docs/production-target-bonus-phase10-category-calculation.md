# Phase 10 — Category-weighted Production Targets bonus calculation (proposal only)

Branch: `feature/production-target-bonuses-unified`
Source phases: Phase 8 dated category rate settings; Phase 9 immutable
per-bale category evidence and audited one-target-per-worker/day allocations.

## Calculation

For each finalized worker/day:

1. Load immutable category credits from Phase 9's frozen bale capture, **not**
   the editable day-end worker category or live mutable catalog/stock records.
   Linked-team physical bales must already be credited exactly once.
2. Use the single saved daily worker target split explicitly across observed
   categories by the Phase 9 locked allocation set. A missing/partial split
   blocks that worker rather than using the entire daily target for each
   category.
3. For each category `c`:
   - `extra_c = max(0, credited_bales_c - allocated_target_bales_c)`.
   - Resolve the latest enabled/disabled category rate effective on or
     before the production date, breaking same-day versions by latest ID.
   - `unrounded_usd_c = extra_c * rate_c` using Decimal, with 6-digit
     intermediate precision (integer bales / up to 2dp targets × 4dp rates).
   - A disabled or zero configured rate earns zero for that category.
     A **missing** or invalid rate for a category with positive extra bales
     blocks that worker's entire proposed bonus.
4. Sum all unrounded category amounts for that worker/day, then round **once**
   to 2 USD cents using ROUND_HALF_UP. This follows the existing core
   convention and avoids per-category cent rounding drift.
5. Sum the already-rounded daily worker amounts for the displayed total.
   No week-long loss offsets a previous day's bonus.

**Important policy distinction:** Category excess is measured relative to
the saved category targets, not re-counted as daily whole-category output.
Category-specific excess totals can differ from the aggregate extra bales
relative to the one daily target when an allocated category falls short;
this remains a business-rule decision for the later approval/payment phase.
This preview does **not** authorize payment.

## Routes and UI

`GET /api/factory/production-target-bonuses/category-preview?date=YYYY-MM-DD`
is Admin/Owner-only, requires Production Targets tab access, derives the
company from the session, sends `Cache-Control: private, no-store`, and
never changes a database row.

Response carries `calculationVersion: "production-target-category-v1"`,
`currency: "USD"`, `proposalOnly: true`, `canApprove: false`,
`canPost: false`, per-worker/category credits, targets, extra bales,
rate version/effective date, six-decimal intermediate amount, daily worker
USD cent amount, block reasons, and aggregate proposed USD total.

The Production Bonuses admin panel displays this detailed category preview
in a separate expandable section; existing Phase 3/4 review and Phase 5/6
accounting/payment flows are **not changed**.

## Fail-closed protections

The new category preview produces **zero proposed USD for a worker** if:

- The production day is not finalized, or the capture is absent/ambiguous.
- A linked team, absence, bale category, or finalized credit fails reconciliation.
- The daily target or immutable category allocation is missing, invalid or
  does not sum to one worker/day target.
- Stored category credits differ from frozen, attributed bale counts.
- A category with positive extra bales has no valid effective rate.
- **Any existing approved/rejected legacy worker/day bonus review exists.**
  This explicitly prevents a second category proposal for a paid/approved
  daily bonus source and leaves locked legacy amounts untouched.

No change to `factory_target_bonus_reviews`, any payment/claim table,
Payroll Deposit Expense vouchers, Cash/Bank/Daybook, or payroll allocations.

## Regression tests and release gates

Pure tests cover worker switching between Bags/Toys/Shoes, effective-dated
rates, explicit disable, missing rates, Decimal rounding, legacy-review
blocking, unfinalized/missing evidence, invalid targets, and mismatch
fail-closed behavior.

**Still required before any paid category bonus:** Phase 11+ immutable
category review and per-line rate snapshot model, compatibility with
existing one-worker/day payment claim and accounting locks, explicit
policy for category shortfall vs day-level excess, real PostgreSQL tenant/
concurrency tests, TypeScript/build/route manifest and CI i18n gate.

Do not merge to main, deploy to Render or initiate payments from this change.
