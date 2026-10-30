# Phase 12 — Configurable weekly flat bonus method (settings only)

Branch: `feature/production-target-bonuses-unified` (continuation of Phases 1–11).

## Scope implemented

- Added an **Admin/Owner-only** "Weekly bonus method — per bale or flat fee" panel to the existing **Production Targets → Production Bonuses** admin surface.
- The company can save one of two **configuration modes** for each effective production week:
  - `per_extra_bale`: keep the existing extra-bale/category rate model; stored flat amount must be USD 0.00.
  - `weekly_flat`: a single configurable USD amount for an eligible worker for a Monday–Sunday production week.
- The example future eligibility rule is **strictly above the weekly target**, not equal: target 56, output 55 or 56 -> $0; output 57 or 90 -> the same saved flat fee (e.g. $15).
- A new saved version takes effect from its selected **Monday** onward until replaced. A later version saved for the same Monday takes precedence by version ID.
- The panel has an effective-date viewer, future method editor, exact two-decimal USD input, optional change note, and read-only history.
- Company-scoped `GET/POST /api/factory/production-target-bonuses/weekly-method` routes require authentication, Production Targets tab permission, and Admin/Owner role. POST accepts `method`, Monday `effectiveWeek`, `flatBonusUsd`, optional `note`, and a unique `requestKey`.
- Append-only `factory_production_target_bonus_weekly_methods` SQL table is ensured on the unconditional factory startup path. It has database constraints (mode/amount/Monday), company + request-key uniqueness, indexed effective-week lookups, creator/time audit columns, and a trigger prohibiting update/delete.
- Concurrent changes use a company advisory lock. Identical request-key retries replay safely; conflicting reuse returns 409. Effective lookup is independent of the capped audit-history list.

## Explicit exclusions and safety boundaries

**This phase stores settings only.** The `configuredForPayments: false` API marker and "Configuration only" UI text are deliberate. No weekly award, approval, payment claim, expense, cash movement, voucher, Daybook, or salary/payroll change is created. The existing Phase 1–11 calculation, saved category rates, immutable reviews, and payment paths are left unchanged. Picking `weekly_flat` in settings **does not** turn off the existing per-extra-bale system today.

**Next phases:** Phase 13 aggregates one credited bale count and one target per worker per Monday–Sunday week, across finalized days, historical linked/unlinked shares, worker category changes and absences; all incomplete/ambiguous evidence must fail closed. Phase 14 introduces an immutable one-worker/week eligibility and review/approval snapshot with a mode/version ID and protection against same-source day or category payouts. Phase 15 integrates one idempotent payroll/Deposit Expense payment path and weekly exports. Phase 16 certifies end-to-end accounting, concurrency, permissions and historical compatibility.

## Verification checklist

- Shared regression test: `shared/productionTargetBonusWeeklyMethod.test.ts` checks Monday/Sunday boundaries, real dates, USD precision and limits, same-week precedence, effective-date selection and separation from per-bale awards.
- Confirm with `npm run check` and the focused Vitest test, route manifest test, frontend/backend tests and migration tests.
- PostgreSQL integration test: startup with `RUN_STARTUP_MIGRATIONS=false`; insert/GET/retry/conflicting request-key; immutable trigger; cross-company access and Admin/Owner/tab permissions.
- Inspect representative weeks for category change and historically linked vs unlinked workers when Phase 13 is connected.
- Do **not** merge to `main` or deploy Render until the production financial gates for the full workflow pass.
