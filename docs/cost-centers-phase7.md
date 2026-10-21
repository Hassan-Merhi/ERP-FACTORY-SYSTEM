# Cost Centers — Phase 7: Historical Data & Reconciliation

## Delivery and safety boundary

Phase 7 implementation is committed on the existing
`feature/cost-centers-phase1-foundation` branch. The code is **not yet
validated, migrated to production, merged, or deployed**. By owner request,
Claude handles CI/tests, technical certification and release.

**No existing accounting voucher, GL posting, customer/supplier balance,
stock quantity/value, Factory production record, FX rate, or Net Position
record is updated by Phase 7.**

Historical source expenses remain **Unallocated** by default. There is NO
automatic retroactive assignment, mass correction voucher or legacy ledger
rewrite.

## User workflow

The same panel is available beneath Reports in:
- ERP Accounting → Cost Centers → **Historical Assignment & Reconciliation**
- Factory Finance → Cost Centers → **Historical Assignment & Reconciliation**

**Read/reconcile (no mutation):**
1. Select inclusive historical from/to dates and a source kind.
2. Optionally choose the exact posted expense ledger account.
3. Inspect reconciliation totals: eligible original posted USD; existing
   allocated USD; remaining unallocated USD; source counts; and separate
   original-currency control totals.
4. Report basis is **eligible posted expense DEBIT source entries only**.
   Reconciliation is *not* a full-company GL or P&L audit; expense-credit
   entries, income, asset movement and liabilities are not historical
   bulk-assignment candidates.

**Preview (no source/allocation mutation):**
1. Admin, Owner or Developer selects a maximum 1–100 sources and one or more
   active company-owned cost centers, each with a positive percentage.
2. Combined allocation percentages must be <= 100%. Unassigned remainder
   stays Unallocated. A partial 20%/30% split leaves 50% unallocated.
3. Enter a meaningful required audit reason and click **Preview Historical
   Allocation (Dry Run)**.
4. Backend discovers original eligible sources in deterministic date/id order,
   rejects windows exceeding the chosen limit rather than silently processing
   a partial date range, computes native and historical USD allocations at
   six-decimal precision, and returns the exact per-source proposal.
5. The dry run writes **only preview metadata and a preview audit entry** to
   `cost_center_historical_batches` and `audit_log`; no cost-center
   allocation, original voucher or daybook event is changed.
6. A preview has a fixed **20-minute expiry**. Each snapshot records exact
   source values and a canonical SHA-256 digest of source ID, posting date,
   original currency, historical book value, FX evidence, account and
   source-module classification.

**Apply (explicit user approval):**
1. Review every source/center split and enter **APPLY** exactly.
2. Apply is permitted only for the original preview author while the preview
   remains current and unexpired.
3. Backend obtains the active company's allocation advisory lock, locks
   original source rows/parent vouchers and center rows, and re-queries
   eligible source rows. Source additions, edits, deletions, new allocations,
   protected status or FX/account/date changes cause a **409 failure before
   any allocation insert**.
4. Inserts of all proposed allocations, permanent manual precedence overrides,
   per-source evidence, batch completion, and audit entries occur inside
   **one PostgreSQL transaction**. A failure rolls everything back.
5. Each historical assignment is marked `MANUAL`, never `AUTO`. Phase 5
   automatic rules cannot overwrite it, and manual clear-all status is
   honored.
6. Successful application immediately refreshes the reconciliation, reporting,
   and existing cost-center UI queries. Applied batches are retained for
   review; they cannot be applied twice or modified.

## Source eligibility, preserved accounting treatment

- Voucher candidates: existing company-owned **posted and active** voucher
  expense debit entries (Expense/Direct Expense/Indirect Expense ledger
  account) with a positive source debit; neither reversal nor an already
  reversed original; no deleted, optional/unfinalized, `GC-*`, `MIG-*`,
  `SP_MIGRATION_READONLY`, or intercompany source.
- Factory candidates: real standalone positive Factory Daybook expense
  entries of an eligible expense type, with **neither reference table nor
  reference ID**, preventing second attribution of voucher/POS-backed
  daybook projections.
- Already allocated entries and entries with explicit manual overrides
  (including deliberate clear-all) are never chosen for new historical
  batches. Cross-company source IDs are never accepted.
- Capitalized Factory inventory movement, pending/loading container state,
  mix consumption, freight estimates, supplier payments, cash/bank transfers,
  payroll payment movements, stock transfers and non-expense entries are
  excluded from historical expense assignment.
- Source date for vouchers is `effective_date` falling back to
  `voucher_date`, matching the Cost Center Phase 6 reports; standalone
  Factory Daybook uses `effective_date` falling back to `tx_date`.
- Historical multi-currency values remain in the source's original currency.
  The captured historical USD book values are apportioned by exactly the same
  percentages; no current FX rate is used and currencies are never combined
  in a native-value reconciliation total.

## SQL / app files

- `migrations/20261021_005_cost_centers_phase7_history.sql`:
  company-scoped, RLS-protected immutable preview batches and batch item
  evidence, status immutability, source-total constraints and audit columns.
- `migrations/meta/_journal.json`: registered immediately after Phase 6.
- `shared/schema/cost-centers.ts`: Drizzle Phase 7 batch and evidence types.
- `server/routes/costCenterHistoricalRoutes.ts`: historical filters,
  dry run, immutable batch recheck, atomic manual application, audit,
  read-only USD/native reconciliation, batch details and list.
- `server/routes/applicationRoutes.ts`: registers Phase 7 endpoints before
  generic dynamic `/cost-centers/:id` routes.
- `server/middleware/factoryBackendAccessBoundary.ts`: applies Factory
  finance-page ownership for historical endpoints.
- `client/src/components/financial/CostCenterHistorical.tsx`: same
  responsive workflow for ERP and Factory, including typed APPLY
  confirmation, preview details and batch history.
- `client/src/pages/CostCenters.tsx`: mounts the new shared UI.

## API contract

Each ERP/Factory cost-center prefix includes:
- `GET /historical/reconciliation?sourceKind=VOUCHER_ENTRY|FACTORY_DAYBOOK&fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&ledgerAccountId=...`
- `POST /historical/preview`: sourceKind, date range, optional account,
  `limit` (1–100), `splits` (1–10), reason (required).
- `POST /historical/:batchId/apply`: `{ "confirmation": "APPLY" }`.
- `GET /historical/batches`: 50 newest batches scoped to current company.
- `GET /historical/:batchId`: immutable preview snapshot + per-source
  applied evidence when available.

Only Factory Mode may use `FACTORY_DAYBOOK` historical source types. Company
scope comes from the canonical logged-in permission context and database
FORCE RLS, never request-supplied companyId values.

## Claude validation / release checklist — not executed

Perform SQL migration ordering and `audit_log` compatibility checks, pg
FORCE RLS authorization, and restricted-role negative tests. Specifically
validate:
- FX/native/USD 6-decimal precision, low-value split rounding, credits
  excluded from historical debit candidate list, reversals, missing FX.
- Empty, archived, stale, manually cleared, previously allocated,
  protected/migrated, optionally posted and intercompany sources.
- Preview of >100 candidate entries refuses truncation; applying the same
  batch twice fails; expiry, cross-user and cross-company apply fail.
- Concurrent assignment and source date/amount/account changes between
  preview and apply cause a complete rollback.
- `audit_log` and batch-item evidence reconcile to exactly one set of
  analytical allocations and explain native and historical USD totals.
- Before/after eligible-posted-expense control total remains identical,
  allocated total increases and unallocated falls by exactly that amount.
- No changes anywhere in GL journal, Net Position, payroll, inventory value,
  supplier/customer balances, container costing or Factory production.
- Verify actual ERP/Factory account/page permissions, migration compatibility,
  and responsive UI. Run CI/test suite only as instructed by owner/Claude.

## What remains

Phase 8: Claude-controlled full integration, regression, migration validation,
security checks, merge and release. **Phase 7 is committed source code, not
production-certified behavior.**
