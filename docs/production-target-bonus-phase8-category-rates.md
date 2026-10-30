# Phase 8 — Production Targets category-rate configuration

Branch: `feature/production-target-bonuses-unified`
PR: #2612

## Why this exists
A worker can work on Bags or Toys and later switch to Shoes, including during
the same day. Their compensation cannot multiply *all* the worker's excess
bales by whatever category is displayed at day's end.

## Implemented in Phase 8
- `factory_production_target_bonus_category_rates` is an independent,
  append-only versioned settings table created in the unconditional factory
  startup schema. Records are scoped by company, category key, effective date,
  enabled state and exact USD amount per excess bale (4 decimal places).
- Case/spacing-normalized categories preserve the visible label. Category
  options come from company worker categories, saved Production Targets rows
  and previously configured rates, with a free-text option for a new category.
  Bags, Toys, Shoes and other categories are not mapped to one fixed rate.
- New admin/owner-only Production Targets GET/POST settings routes:
  `/api/factory/production-target-bonuses/category-rates`. A read needs
  `asOf=YYYY-MM-DD`; the write needs `category`, `effectiveFrom`,
  `ratePerExtraBale`, `enabled`, optional `note`, and `requestKey`.
- Strict date, amount, category and idempotency validation, company-scoped
  queries, advisory lock, immutable historical versions and audit fields.
- A compact Category Rates editor inside the existing admin Production
  Bonuses panel. Lists configured and unconfigured categories, allows changes
  for a selected effective date, and exposes read-only version history.
- Shared pure category normalization/rate selection helpers and regression tests.

## Invariants
- **Zero automatic payouts caused by Phase 8.** Phase 8 saves rate *settings*,
  but does not feed them into the Phase 1–7 approved worker/day payout math.
- Phase 1–7 existing approved/paid/reversed reviews, accounting vouchers,
  Daybook entries, and snapshot values are untouched.
- No category payout without production counts **and target allocations**
  attributable to that worker/category/time period and a finalized source.
- Future multi-category calculation must not apply one worker's full-day
  production or target to each category and must not create duplicate claims.
- All money remains USD until the accounting path has verified dated FX.

## Follow-on phases
Phase 9+: authoritative worker/day/category production evidence and target
allocation (including actual same-day switches), category-aware excess-bale
calculation, historical snapshots, review/payment reconciliation and export.
A day with ambiguous category attribution must fail closed.

## Verification still required before production
Typecheck, backend and UI test suites, route manifest test, real Postgres
startup/tenant/idempotency tests and phase 1–7 payment-ledger safety gates.
The feature is intentionally not merged to `main` or deployed to Render.
