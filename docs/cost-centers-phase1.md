# Cost Centers — Phase 1 (database foundation)

## Scope
This phase only introduces a shared analytical foundation for **ERP Accounting** and **Factory Mode**. It does not introduce UI, API routes, default allocations, reports, budgets, or automatic journal postings. Those belong to subsequent phases.

## Schema
- `cost_centers` — company-scoped cost center code/name, optional parent, active/archive flag, creator/updater and timestamps. Company/code is unique, parent must belong to the same company, and a database trigger rejects hierarchy cycles or moving a center to another company.
- `cost_center_allocations` — analytical assignment of a source **voucher entry** or a **factory daybook entry** to a center; supports multiple rows (splits) per source, with original-currency amount and historical USD value. Source links are mutually exclusive.
- Every assignment is company-scoped. Composite foreign keys ensure allocations and parent centers cannot point across companies.
- Source ownership/currency and both total allocation magnitudes are enforced by a trigger with per-company transaction advisory locking. A single source cannot be allocated beyond its native or historical USD book value. Source deletions cascade only to analytical assignments, never to ledgers.
- Both new tables enforce the existing `erp_company_scope_matches(company_id)` policy under PostgreSQL **FORCE RLS**.

## Accounting safeguards
1. **These tables do not post vouchers, alter balances, or revalue inventory.** Cost centers are not accounts.
2. A factory event already represented by a `voucher_entries` posting must be attributed through that entry only. Use `factory_daybook_entries` for standalone events only; reporting and Phase 5 automation must never include two financial representations of the same event.
3. Allocation amounts are *positive magnitudes*. Sign, journal date, and accounting nature come from the original source record. `cost_treatment = INVENTORY_COST` is informational and must not be included in operating-expense totals merely because it is tagged.
4. `amount_native`, `currency`, `amount_base` and optional `historical_rate`/`rate_convention` are source-time snapshots. Reports must use the historical USD value rather than a current FX rate. The DB checks native and base totals independently.
5. Splits need not equal 100%; residual = source amount minus assigned amounts, shown as **Unallocated** by later reporting.
6. Protect existing deleted, immutable, and reversed vouchers through application lifecycle logic in Phase 2. This phase does not backfill, revise, or create any financial record.

## Lifecycle requirements for Phase 2
- Write all allocations under an authorized company-scoped session; never trust a company ID from request bodies.
- When source amounts, currency, dates, source accounting status, or reporting classification change, revalidate/update linked allocations in the same database transaction or reject the source change. Phase 1 has no triggers on the hot `vouchers`, `voucher_entries`, or `factory_daybook_entries` tables to avoid altering established posting behavior.
- Do not allow new assignments to archived centers; existing historical allocations must continue to appear in reports.
- Build secure edit/audit endpoints and permission checks before exposing writes.
- Source duplication handling for voucher-backed factory operations is a Phase 2/5 responsibility, not yet enforced automatically across the two source tables.

## Migration / release
- SQL migration: `migrations/20261021_001_cost_centers_phase1.sql`
- Drizzle definitions: `shared/schema/cost-centers.ts` (re-exported from `shared/schema/index.ts`)
- Registered in `migrations/meta/_journal.json` for the explicit versioned migration runner.
- Migration is **additive**: no UPDATE/DELETE on historical records and no changes to posted vouchers.
- The versioned migration requires the existing company-scope policy functions from migration `0016_company_scope_rls_readiness.sql`.
- This code commit **does not apply any migration to a production database**. Database application remains a separately authorized operation.
- As requested by the owner, **no CI checks, verification suites, or deployment are run here; Claude handles validation and release**.

## Acceptance boundary
Phase 1 code is present when all schema and migration files are committed. The schema is not live in any database until the migration has been applied there. End-to-end allocation functionality requires later phases.
