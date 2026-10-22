# Unified Accounting — Phase 15: Integration, Permissions & Controlled Rollout

**Repository:** `Hassan-Merhi/ERP-FACTORY-SYSTEM`  
**Branch:** `feature/unified-accounting-erp-factory-rentals`  
**Coverage:** ERP + Factory + Properties/Rentals, all fifteen unified-accounting phases.

**Status:** The Phase 15 implementation, routes, audit metadata and handoff were committed as source code. **NO CI, tests, TypeScript compilation, Git merge/rebase, production deployment, production SQL execution, voucher mutation, historical backfill, perpetual-inventory cutover, GL posting or accounting certification was performed by this stage.** Claude is responsible for the independent technical/security/finance certification after source handoff.

## Purpose

Final integration is a **release-control boundary**, not another general ledger.
Phases 1–14 previously implemented the accounting foundation, posting,
reconciliation, FX, stock/COGS, Factory production, Rentals, intercompany,
historical accounting, financial statements, budgets, fiscal close, and
unified Net Position. They remain on **one feature branch**, not automatically
activated in production by Phase 15.

**A safe source commit does not imply production accounting readiness.** This
phase makes that distinction visible to Owners and reviewers and prevents new
accounting metadata mutations being silently exposed immediately at deploy.

## Deliverables

### 1. Release-only, company-scoped schema

`server/services/accounting/ensureUnifiedAccountingRolloutSchema.ts`
is run by the normal always-on `ensureRuntimeSchema` bootstrap and creates
metadata only:

- `accounting_unified_release_reviews`: source commit SHA; `TECHNICAL`,
  `SECURITY`, `FINANCE`; real external evidence reference; reviewer
  identity, note and timestamp. Active (company, source SHA, reviewer capacity)
  is unique. PostgreSQL protects approved records against edits/deletion;
  an Owner can revoke a review **once**, with an immutable actor, timestamp
  and reason.
- `accounting_unified_rollout_policy`: one row per company, default
  **`READ_ONLY`** when no row exists; optional `METADATA_PILOT` with
  approved full source revision, Owner actor, timestamp and reason. Each
  promotion or rollback is audit-logged. It cannot become a financial
  posting mode.

Both tables have company-isolated PostgreSQL `ENABLE RLS` and
`FORCE RLS` policies, with transaction-local company scope. Neither table
creates or alters financial GL, historical FX, customer balances, stock
assets, production, cost accounting or existing fiscal closing journals.

**No automatic policy row or approval is inserted at startup.**

### 2. Source and accounting readiness report

`server/services/accounting/unifiedRolloutService.ts` combines a live
**read-only** company-specific readiness summary:

- Full deployed source SHA, prioritizing the hosting provider's
  `RENDER_GIT_COMMIT` / `GIT_COMMIT` and using
  `UNIFIED_ACCOUNTING_RELEASE_SHA` only for supported non-provider
  environments. A short SHA, missing SHA or changed SHA **cannot**
  authorize the existing pilot.
- Company's canonical **posted trial balance** and its exact unexplained
  difference using `buildTrialBalance`. It **never** plugs a discrepancy.
- Presence of new accounting metadata tables for open-item matching,
  bank/cash reconciliation, FX realization, rental expense links, cost
  centers/budgets, fiscal signoffs and final rollout records.
- Tenant security: `ENABLE` and `FORCE` RLS plus the **presence of at least one RLS policy** on required metadata tables. A missing/unprotected/policy-less table blocks readiness; the policy-presence check is a necessary structural signal, **not** proof that its expressions actually isolate tenants. Claude must inspect policy semantics and perform cross-company tests. Required rows now explicitly include the **existing Phase 12** `cost_centers`, `cost_center_allocations` and `cost_center_monthly_budgets` tables.
- Historical currency readiness via the existing FX reader, with explicit
  **pure-legacy compatibility-is-not-certification** caveat. Known missing
  historical USD entries block a pilot. Uncertain legacy historical
  bases still require independent source review.
- Accounting subsystem route catalog for **all 15 phases**, company/date,
  current review status, current release policy, and **what remains
  unverified**.
- `PERPETUAL_INVENTORY_POSTING_READY` is reported as information. Its
  existing value **remains `false`**. Phase 15 has **no mechanism** to
  activate an inventory posting cutover or write an inventory opening entry.

The result always says `certified:false` and
`PROVISIONAL_NOT_CERTIFIED`. External CI/test links entered manually are
**evidence references**, not proof that CI passed.

### 3. New-API-only write controls

`server/middleware/unifiedAccountingRolloutBoundary.ts` is installed
in `server/routes/applicationRoutes.ts`, **after the existing shared
Factory Accounts permission middleware** and before accounting endpoints.
It checks authenticated current-company role, per-company pilot policy,
full **deployed** source SHA and currently unrevoked approvals.

- **Default `READ_ONLY`:** new accounting report GET endpoints remain
  readable to their authorized roles. New metadata writes are denied
  with HTTP 423 `ACCOUNTING_READ_ONLY_ROLLOUT`.
- **`METADATA_PILOT` remains structurally blocked in the current source**: `METADATA_ENTRY_REFERENCES_COMPATIBLE=false`. New reconciliation metadata references voucher entries with `ON DELETE RESTRICT`, while existing voucher-edit flows replace those entries. Allowing the new metadata writers before that lifecycle is made compatible risks breaking established accounting edits. This hard blocker is now enforced by **both** the Owner promotion readiness check **and** `currentPilotEligibilityTx` on every new metadata write, including when a `METADATA_PILOT` row already exists from an older revision. The UI shows **pilot configured — writers locked**, not an active pilot, whenever source guards fail.
- **Future `METADATA_PILOT` activation (not yet possible):** after Claude confirms safe source-entry lifecycle and transaction-level authorization, an Owner may enable one company only when all blockers clear and the source SHA carries independent TECHNICAL, SECURITY and FINANCE reviews. The Owner must differ from the technical reviewer and provide an audited reason. Merely setting a database row, adding external reference links or changing an environment variable **cannot** remove the source blocker.
- **Revision / evidence invalidation:** if the deployed full source SHA differs from the approved one, a reviewer withdraws evidence, a required review is missing, or rollout data cannot be read, the writer **fails closed** on its authorization check. A missing rollout schema or database failure responds 503, not a permissive fallback. Future activation must also place authorization and metadata mutation in a **single transaction or equivalent lock/guard**: today the middleware's authorization transaction finishes before the downstream writer, so a review revocation between those operations could race. This is another independent Claude security prerequisite. The current hard-coded source blocker keeps the writers disabled until it is addressed.
- **Return to read-only:** Owner may explicitly return a company to
  `READ_ONLY` with an audited reason. This prevents further new
  metadata writes; it does **not** delete previously recorded legitimate
  reconciliation metadata.
- **Unauthenticated / nonprivileged calls:** denied before returning policy information; both the rollout controllers and metadata gate require the **selected company's `currentRole`**, never a fallback account-global role. Existing role and company authorization continues to apply inside the original accounting route.
- **Legacy accounting activities:** the gate does **not** intercept
  normal ERP voucher creation, POS sales, Factory production, supplier
  payments, rentals charge/payment posting or existing legacy bank
  posting endpoints; they keep their original business permissions and
  database posting guards.

The gate covers only new unified-accounting metadata API mutations:
- Phase 3 party open-item matches and cancellation.
- Phase 4 bank/cash statement import, manual review and match/cancellation.
  Multipart **preview** is allowed because it doesn't save the file.
- Phase 8 rental expense source attribution and cancellation.
- Phase 13 finance signoff/policy metadata changes.

**Financial posting is NOT enabled in any Phase 15 mode.** The following
*new* journal-writing endpoints explicitly return
`ACCOUNTING_POSTING_NOT_CERTIFIED` until the separate original
posting/certification controls are independently approved:
- Phase 5 new realized-FX recognition
  `POST /api/accounting/monetary-fx/realized/:id/recognize`.
- Phase 13 reviewed fiscal closing
  `POST /api/accounting/fiscal-review/close`.

The existing original fiscal-close/reopen route is **not** rerouted or
removed. Its Phase 13 independently configured Owner enforcement policy
still governs legacy closing. **The perpetual stock cutover remains
globally disabled**, regardless of rollout mode. No historical repairs are
invoked in this phase.

The existing `client/src/pages/MonetaryFxAccounting.tsx` and
`client/src/pages/FiscalCloseReview.tsx` financial posting controls are
also explicitly disabled in the source with
`UNIFIED_FINANCIAL_POSTING_CERTIFIED=false` and show a certification
explanation. Future promotion to genuine financial voucher posting
requires a **separate, independently reviewed code/security/accounting
change**, not an Owner metadata pilot setting; both UI and backend
controls must be reviewed together.

### 4. Owner and reviewer API

`server/routes/unifiedAccountingRolloutRoutes.ts`:

| Method | Endpoint | Permission |
| --- | --- | --- |
| GET | `/api/accounting/rollout/readiness` | Authenticated Admin, Owner, Developer + company |
| GET | `/api/accounting/rollout/policy` | Same |
| POST | `/api/accounting/rollout/reviews` | Technical/security: Admin or Developer; Finance: Admin or Owner |
| POST | `/api/accounting/rollout/reviews/:id/revoke` | Explicit Owner, reason |
| POST | `/api/accounting/rollout/mode` | Explicit Owner, source-pinned reviews and reason |

All operations derive company ID from the authenticated active session,
with transaction-local SQL tenant scope. No user-supplied company override is
trusted. A Developer's general `requireRole` override **does not**
satisfy the route's explicit Owner promotion requirement.

### 5. Cross-module review screen

`client/src/pages/UnifiedAccountingRollout.tsx`:

- Source SHA, selected company and stage (`READ_ONLY` /
  `METADATA_PILOT`).
- Current canonical trial balance, missing/unprotected/**policy-less** SQL metadata tables, explicit voucher-entry foreign-key incompatibility and incomplete historical FX base blockers.
- External review references, reviewer identities and auditable revocation.
- Owner confirmation to approve metadata pilot or revert to read-only,
  with separate human-readable reason and exact typed confirmation.
- Fifteen-phase implementation catalog. Links respect the current ERP/Factory/Properties shell: module-specific routes only, with module-unavailable sections visibly marked. In particular Phase 12 Cost Centers appears in ERP/Factory, **not** as a non-existent `/properties/cost-centers` route. Readiness/policy views are refused on the client if their returned company ID does not match the selected company.
- The page says **source-level implementation ≠ verified CI ≠ accounting
  certification ≠ deployed**.

| Shell | Page |
| --- | --- |
| ERP | `/accounting/rollout` |
| Factory | `/factory/accounting/rollout` |
| Properties | `/properties/accounting/rollout` |

All three shells reuse the existing Accounts/navigation, lazy page import,
Owner/Admin/Developer role checks, current-company React Query key, and the
Factory page/tab View Accounts authorization boundary.

### 6. Static integration contract for Claude

Added `scripts/verify-unified-accounting-phase15.mjs`. Claude can run it
**during independent verification**, not as part of this stage, to check
wiring of all module routes, permission middleware, new schema, relevant
source files, protected report endpoints, phase docs and the
`PERPETUAL_INVENTORY_POSTING_READY = false` constant.

`node scripts/verify-unified-accounting-phase15.mjs`

This is **only a static string/manifest consistency check**. Passing it
does not prove TypeScript compilation, SQL validity, security isolation,
financial balances, journal idempotency, bank reconciliation or accurate
Factory inventory cost. Claude must perform all those independently.

## Rollout runbook (not executed)

1. Freeze the final feature branch source revision. Have Claude perform
   independent source review, TypeScript compilation, complete CI,
   SQL migration/trigger validation, security/permitted-company testing
   and a nonproduction financial reconciliation.
2. Fix any discovered failures **on the same feature branch**; do not
   merge before Claude verifies the final commit. A new commit invalidates
   any older deployed source SHA approval.
3. Confirm opening balances, bank/cash, Party balances, supplier/tenant
   settlements, FX history, Factory container finalization and payroll
   source amounts by company, document and effective date. Trial-balance
   equality alone is **not** statutory proof.
4. Verify Phase 9 group consolidation eliminations independently. The
   default accounting dashboard is **single-company**, and management
   Factory Net Position's selling-valued inventory is not booked equity.
5. Verify permissions as normal user/POS/Admin/Owner/Developer in ERP,
   Factory and Properties; Factory View Accounts restrictions; intentional
   company switching; cross-company ID/proforma misuse; attempted
   unauthorized review or release policy changes.
6. Verify all new accounting API writes are HTTP 423/503 in the default
   read-only state and none of the known POST writers bypass that gate.
   The existing ERP/Factory voucher/stock lifecycle must remain unchanged.
7. Only after an approved staging deployment, identify the **full deployed
   commit SHA** from Render's immutable environment identity (or supported
   exact-revision override in staging) and attach actual CI, accounting and
   permission-review evidence to the company-specific review screen.
8. **Not yet authorized or technically available:** Claude must first fix and verify the `ON DELETE RESTRICT` voucher-line lifecycle collision, certify that policy/review authorization cannot race the subsequent metadata mutation, and update `METADATA_ENTRY_REFERENCES_COMPATIBLE` only with independent technical/security/accounting evidence. Then the Owner may separately opt into a **metadata-only pilot** for **one company** after current source-pinned signoffs. Monitor audit, missing/non-comparable financial sources, latency and tenant access. **Do not activate new journal-posting features or perpetual inventory** through this pilot.
9. If a pilot causes a problem, Owner immediately changes it back to
   `READ_ONLY`. The gate must stop new metadata writes; already posted
   legitimate accounting vouchers and existing metadata must **not** be
   deleted or rewound in an unsafe rollback.
10. Only after Claude and the accountant certify the full final source
    revision should the user independently authorize a PR merge and
    subsequent Render deployment. This phase has not obtained that
    authorization and has not performed either action.

## Final verification matrix for Claude

- All 15 phases source files/routes/service exports included in the same
  branch; user has access to UI in ERP, Factory and Properties.
- Company switching and Factory shared page/role enforcement on **every**
  GET/POST, not merely React route visibility.
- All newly added SQL tables/keys/FORCE RLS policies/actor and immutable
  triggers are created idempotently and reject cross-company values.
- Posted trial balance equals Phase 11/14 booked Assets−Liabilities and
  reported Equity discrepancy to the cent; **never fabricate a balance plug**.
- Phase 3 matching and bank/cash reconciliation idempotency, split matches
  and cancellation for same party/entry; no new voucher.
- Realized FX posting remains blocked; no current FX used for old revenue/
  expense/cost; verified historical rate provenance.
- Inventory COGS and perpetual cutover remain disabled; Factory loading,
  verified and finalized order boundaries cannot post unearned freight.
- Rentals receipt/payment/advance/deposit/maintenance and accrual controls
  do not count as fresh income merely because operational screens show it.
- Group consolidation excludes intercompany balances/transactions once
  elimination source evidence is certified — don't report single-company
  net position as consolidated group cash.
- Phase 12 (cost centers and monthly budgets) reuses the existing Cost
  Centers module (`/cost-centers`, `/factory/cost-centers`), **without a
  second budget table or allocation writer**. The unified dashboard's
  read-only `Cost centers & budgets` tab reads the existing company-scoped
  expense/budget summary with matching company, historical USD and accounting
  dates. Unallocated expense and capitalized inventory remain separate,
  budget months are not prorated, and budget variance is **not** certified
  as an exact match to booked P&L. Properties/Rentals has no native
  cost-center workspace and must not reuse another shell's company data.
  See `docs/unified-accounting-phase12.md`. Claude must verify this
  integration and review Cost Centers' independently versioned migration
  readiness before any rollout.
- Fiscal close, period locks and immutable audit history preserved;
  `POST /api/accounting/fiscal-review/close` remains locked in Phase 15.
- Default no rollout row is `READ_ONLY`; tests for 401/403/423/503, company mismatch, reviewer separation, review revocation, source SHA mismatch, Owner-only promotion and rollback.
- **Current Phase 15 blocking prerequisite:** attempt a new metadata mutation with a manually present `METADATA_PILOT` row and all three reviews; assert HTTP 423 while `METADATA_ENTRY_REFERENCES_COMPATIBLE=false`. Confirm `pilotOperational=false` even if a pilot row is stored. Owner promotion remains blocked; the existing accounting voucher line-update/delete workflow must never be broken by new metadata.
- When the compatibility flag is ever considered for a later change, require a **transactional authorization/write test** racing review revocation and source version change. A read-only middleware guard that commits its transaction before a metadata handler runs is not sufficient for atomic authorization.
- Require RLS **policy presence** and FORCE RLS across Phase 3–15 metadata, including the reused Cost Centers directory, allocations and monthly budget table. Verify actual policy predicates, non-bypass test roles, selected-company role isolation and forbidden cross-company reads/writes.
- SHA source must favor deployed provider identity over any stale manual
  fallback. A new deployed release must require new review.
- Read-only reports and CSV exports never mutate vouchers, stock,
  historical transaction rates or audit business entries.
- Check the static Phase 15 contract **and** actual TS/SQL/security/runtime
  separately; the contract is insufficient for certification.

**Final state of this Phase 15 continuation: source-level rollout controls strengthened and committed, still pending independent Claude verification. No TypeScript compilation, CI, database test, migration, merge or deployment was executed as part of this continuation. The new metadata write gates remain source-locked (even if an older pilot policy row exists); journal posting, reviewed fiscal closing and perpetual inventory cutover remain explicitly disabled.**
