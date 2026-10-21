# Cost Centers — Phase 8: Integration & Release Handoff

## Claude certification review (2026-10-21)

Reviewed on `feature/cost-centers-phase1-foundation` after the `main` merge.
Corrections committed on the same branch (no history rewrite):

- **Build blockers**: `shared/schema/cost-centers.ts` had a syntax error that
  broke type-check, lint and build; composite FKs referenced unique *indexes*
  that `drizzle-kit push` creates after the FKs. Uniques are now table
  constraints, and the Drizzle declaration carries every CHECK/UNIQUE/default
  the migrations create (CI/staging schemas now match production).
- **Accounting edits are never blocked**: the Phase 2 guards raised an error
  on any later change to an allocated voucher, voucher line or Factory daybook
  row — container freight/landed-cost sync, FX repair, account migration and
  voucher edits would have failed once a line was tagged. Phase 8 replaces
  them with fail-open AFTER triggers (clear stale splits, re-run rules, list
  removed manual work in automation diagnostics). Deleting a source with
  manual splits leaves a diagnostic notice.
- **Exact reversals**: `POST /api/vouchers/:id/exact-reversal` links the pair
  through `accounting_posting_requests` (`source_type='voucher-reversal'`), not
  `reversal_of_voucher_id`. Both linkages are now treated as a reversal pair in
  the database guard, automation, reports, history and allocation API.
- **Reconciliation**: the center balance/activity endpoints use the report CTE
  (eligibility, credit sign, reversal exclusion), so every view agrees.
- **Robustness**: 503 `COST_CENTERS_NOT_INSTALLED` before migrations (voucher
  pages hide the panel), Phase 7 FK made idempotent, historical splits round
  down, preview sets `expires_at`, ERP mode cannot reach Factory daybook or
  inventory-cost sources, automation skips companies without active rules.
- **i18n**: all new UI/API copy translated (en/ar/fr).
- **Tests**: `tests/cost-centers-lifecycle.test.ts` applies all six migrations
  and covers the full lifecycle, reconciliation, reversals, non-blocking source
  changes, Factory daybook eligibility, readiness and RLS (non-bypass role).

### Applying the migrations (requires owner approval)

The six files were applied in order to a production-like database (all other
tables present, no cost-center tables), re-applied to prove idempotency, and
applied on top of a Drizzle-pushed CI database. For production, apply exactly
these six files, in order, each in its own transaction, after a backup:

```sh
for f in 20261021_001_cost_centers_phase1 20261021_002_cost_centers_phase2_integrity \
         20261021_003_cost_centers_phase5_automation 20261021_004_cost_centers_phase6_budgets \
         20261021_005_cost_centers_phase7_history 20261021_006_cost_centers_phase8_hardening; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f "migrations/$f.sql" || break
done
```

Do not use `scripts/run-versioned-migrations.mjs` for this unless every other
pending journal entry has been reviewed: it applies **all** pending entries.
The files only create the eight cost-center tables, their RLS policies,
functions and triggers; they write no accounting rows. Afterwards
`GET /api/cost-centers/release-readiness` must report `structuralReady: true`.

## Release classification

**Source implementation and integration hardening: COMMITTED.**
**Functional certification, CI, production database migration, merge, and deployment: NOT PERFORMED.**

The user explicitly delegates checks/CI to Claude. Do not represent this document,
the readiness endpoint, or a GitHub branch commit as verification of a production
accounting system.

Repository: `Hassan-Merhi/ERP-FACTORY-SYSTEM`
Branch: `feature/cost-centers-phase1-foundation`

As of Phase 8 branch comparison, the feature branch is **135 commits ahead and
24 commits behind `main`**. This is a **blocking integration consideration**:
Claude must reconcile recent `main` changes and merge conflicts before
treating this as releasable. Do not force-push over recent changes. Opening a
pull request or deploying may start CI; owner requested Claude to control checks.

## Phase 8 changes actually implemented

1. **Reporting query fix**: repaired the unallocated-expense ledger-account
   placeholder (`$5` without a corresponding bound parameter). This is
   necessary for non-inventory cost-center report totals to work.
2. **Company-owned source restrictions**:
   - Voucher source attribution rejects deleted, optional, migrated/read-only,
     GC/MIG legacy, intercompany, reversal, and already-reversed sources.
   - Factory Daybook attribution requires an unreferenced, positive,
     **standalone** expense entry: `reference_table` blank,
     `reference_id IS NULL`, and positive source amount.
   - Eligible factory inventory tagging remains distinct from recognized P&L
     expense treatment and uses allowed factory stock debit accounts only.
3. **Phase 8 append-only migration**:
   `migrations/20261021_006_cost_centers_phase8_hardening.sql`.
   Replaces database eligibility/auto-tag/source-lifecycle guard functions to
   apply these protections **in PostgreSQL** as well as in API handlers.
   An already allocated Factory Daybook source cannot silently gain a
   voucher reference or change its `effective_date` without reconciliation.
4. **Preflight (read-only)**:
   `GET /api/cost-centers/release-readiness`
   `GET /api/factory/cost-centers/release-readiness`.
   Requires the current company's Admin/Owner/Developer accounting role.
   Reports presence of all eight cost-center tables, mandatory FORCE RLS,
   sixteen expected enabled triggers, and essential stored procedures.
   **structuralReady=true is NOT a passing test result.**
5. **ERP and Factory UI**:
   `CostCenterReleaseReadiness` is displayed to authorized administrators in
   the shared Cost Centers page with missing prerequisite details and a warning.
6. **Versioned migration journal**:
   Phase 8 migration added after the existing cost center migrations. No
   production SQL executed.

No vouchers or corrective GL postings were created, and no production database
was modified by these commits.

## Database rollout order

Apply in a **controlled clone/staging database first**, in journal order:

| Step | Registered migration |
| --- | --- |
| 1 | `20261021_001_cost_centers_phase1` |
| 2 | `20261021_002_cost_centers_phase2_integrity` |
| 3 | `20261021_003_cost_centers_phase5_automation` |
| 4 | `20261021_004_cost_centers_phase6_budgets` |
| 5 | `20261021_005_cost_centers_phase7_history` |
| 6 | `20261021_006_cost_centers_phase8_hardening` |

**Before production, Claude must**:
- Sync branch with current `main` and reconcile versioned journal conflicts,
  source lifecycle changes and file imports. Re-evaluate this migration list
  against changes merged into `main` after the branch fork.
- Confirm `0016_company_scope_rls_readiness.sql` and associated company-scope
  helper are installed, then confirm all new tenant tables enforce company
  RLS with FORCE RLS.
- Backup the database and capture accounting/source controls.
- Validate the migration registry and apply to an isolated disposable/staging
  database first.
- **Only after approval**, apply via the repository's guarded migration runner,
  which requires `--apply` plus
  `MIGRATION_CONFIRMATION=APPLY_VERSIONED_MIGRATIONS`.
  The runner executes **all pending registered migrations**, not just the
  six Cost Center scripts. Do not apply without reviewing the entire pending
  journal and DB environment.
- Check the privileged release-readiness endpoint **after** migrations.
- Release application and DB compatibility together: clients depending on
  `cost_center_auto_rules`, `cost_center_monthly_budgets`, or
  `cost_center_historical_batches` must not be enabled before their tables
  exist. A structural readiness result is only a prerequisite, not approval.
- Create no default automated rules. Administrators explicitly configure
  future expense account mappings per company.

## Claude-owned certification checklist — NOT RUN BY THIS IMPLEMENTATION

**A. CI, build, migrations and type safety**
- `npm run verify:migrations`, `npm run verify:startup-migrations`,
  TypeScript/React compile, backend and frontend tests, security/fuzz tests,
  and correct import/route order.
- Review migration compatibility and whether earlier source tables/columns,
  voucher deletion/reversal behavior and startup migrations changed on `main`.
- Confirm analytics export dependencies ExcelJS/PDFKit and source schema
  imports are valid.
- Review the entire 135-commit feature diff for accidental unrelated changes.

**B. RLS and authorization**
- Current-company Manager reads but cannot write. Admin/Owner/Developer may
  edit only permitted companies. POS/unsupported roles have no financial
  cost-center access.
- Factory page owners/permissions and account-backed permissions: catalog
  pickers must work without granting unauthorized mutations.
- Verify RLS context across pooled connections; no company data leakage.
- Verify consolidated reports show only fully authorized company scopes;
  never treat an active-company privileged role as cross-company authority.

**C. Invariant/accounting regression**
- Historical voucher and Factory Daybook source principal, currency, exchange
  rate, quantity and posting date are untouched by allocation.
- Expense debits vs credits, reversal pair cancellation, finalized-vs-optional
  vouchers, intercompany exclusions, source deletion/retirement, and archived
  centers display consistently across directory, voucher, Daybook, budgets and
  exports.
- Native-currency totals grouped by original currency; USD historical book
  values never revalue with present-day rates.
- Capitalized/raw-material inventory, WIP and finished-goods cost tags are
  separate from operating expense and never create inventory movements.
- `GL trial balance`, `daybook`, customer/supplier balances, payment cash/bank,
  Net Position, stock inventory valuation, container costs and production/bale
  quantities must match staging baseline before/after cost-center tagging.
- Both manual splits and automatic rules must reject overallocations and
  cross-company cost-center/source pairings. Manual clear-all remains a
  durable override.
- Bulk historical preview digest, expiry, cross-user rejection, stale-source
  detection, concurrency, all-or-nothing batch application and audit replay.

**D. Analytics verification**
- Unallocated amount + allocated amount = eligible source expense controls
  (for each source and month, with signs/credit definitions explicit).
- Budget variance, partial-month labels, archived centers, hierarchy rollups,
  source activity/exports, FX precision and consolidated company totals agree.
- CSV formula injection defenses, Excel numeric precision limitations,
  PDF page wrapping and 5,000-row export cap work as specified.

**E. Release / rollback**
- After staging certification, reconcile merge conflicts with `main`, then
  merge/release through Claude's approved process.
- In case of application issue, revert application deployment **without
  dropping analytical tables or source accounting records**. Disabling/retiring
  automatic rules requires accounting approval; a migration rollback that
  deletes cost centers/allocations is not safe.
- Document any migration/application discrepancy, provide a backup strategy,
  and keep the accounting audit trail.

## Source files for Phase 8

- `migrations/20261021_006_cost_centers_phase8_hardening.sql`
- `migrations/meta/_journal.json`
- `server/routes/costCenterRoutes.ts`
- `server/routes/costCenterReportingRoutes.ts`
- `server/routes/costCenterReleaseReadinessRoutes.ts`
- `server/routes/applicationRoutes.ts`
- `client/src/components/financial/CostCenterReleaseReadiness.tsx`
- `client/src/pages/CostCenters.tsx`

## Completion boundary

Phases 1–8 are committed as code on the same feature branch.
**No claim is made that production is green, that all migrations succeed,
that CI passed, or that the system was merged/deployed.**
Claude's certification and integration with the 24 newer `main` commits are
still required before the cost-center feature can be marked **production done**.
