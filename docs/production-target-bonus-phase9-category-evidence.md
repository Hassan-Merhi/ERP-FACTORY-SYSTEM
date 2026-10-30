# Phase 9 — Frozen category attribution and daily target allocation

Integration branch: `feature/production-target-bonuses-unified`
Parent: Phase 8 category rate configuration.

## Implemented

- Finalizing a **daily Production Targets** session atomically freezes one
  company/date/category/worker evidence row **per physical bale** from
  `factory_bales`. The snapshot includes bale ID, actual finalizing worker,
  the bale's recorded category (including Bags, Toys and Shoes), source stock
  date and finalization timestamp. Counts and status selection use the same
  source as existing daily Production Targets and include the previous day's
  late finalizations by the existing carry-forward rule.
- Capture marker + bale snapshots use unique keys, transactional insertion,
  and a company-scoped advisory close lock. The transaction aborts if the
  fresh snapshot count differs from the daily production count. Closing the
  day saves the daily targets, snapshots, and closure together or not at all.
- A historical finalized day with no Phase 9 capture is marked `NO_CAPTURE`.
  We **never pretend** that mutable present-day bale category or worker
  assignments provide a reliable snapshot of a past day.
- `GET /api/factory/production-target-bonuses/category-evidence?date=YYYY-MM-DD`
  returns worker-level category credits, evidence issues, frozen physical-bale
  count and explicit target-allocation readiness.
- Worker linked teams: each physical bale is used only once. For each category,
  the team total is split across present members in stable worker-ID order.
  Remainders rotate between categories to avoid assigning all odd bales to
  the same worker. The source must match the finalized linked-team totals.
- Missing category, missing linked worker, overlapping teams, absent source
  finalizer, duplicate bales or mismatched saved totals are **blocking**.
- `POST /api/factory/production-target-bonuses/category-targets` writes an
  explicit, audited, **immutable** per-worker/day category target split.
  The sum MUST equal the single saved daily target, without duplicating the
  daily target for Bags, Toys and Shoes individually. Only categories with
  frozen credited bales are accepted. Atomic idempotent retries work when
  the submission is identical; conflicting rewrites return 409.
- No allocations may be created for unfinalized days, incomplete evidence,
  absent workers, or dates with an existing target bonus approval/rejection.
- Admin/Owner controls inside Production Bonuses show frozen category credits
  and allow reviewing and locking the per-category portions of the day's
  target. Ordinary workers cannot access money or category-target changes.
- Pure regression tests cover category switches, linked allocation remainders,
  exact totals, missing capture, ambiguity, and duplicate/dropped categories.

## Hard boundaries

Phase 9 creates **no extra bonus**, no voucher, no cash posting, no payroll
claim, and does not alter Phase 1–7 daily approvals or historical payments.
Phase 10+ must resolve the effective-dated Phase 8 rate for each approved
worker/category target slice and then reconcile the new category-ledger claim
with the existing one-claim-per-worker/day payout model. Do not pay both
calculation paths for the same worker/day.

## Validation required before release

CI, TypeScript, route manifest, pure tests, and real PostgreSQL tests for
day-close atomicity, link splits, late carry-forward, immutable allocations,
company boundaries, and duplicate requests. Prior outstanding Phase 8 i18n
ratchet and Phases 1–7 accounting parity remain release blockers.

Do not merge to main or deploy without these checks.
