# Cost Centers — Phase 2: Backend APIs, permissions and integrity

Phase 2 extends the shared Phase 1 accounting dimension. No UI, budgets,
automatic allocations, production postings or P&L changes are introduced here.

## Changes
- `server/routes/costCenterRoutes.ts`: one controller mounted at
  `/api/cost-centers` for ERP and `/api/factory/cost-centers` for Factory Mode.
- `server/routes/applicationRoutes.ts`: registers both prefixes.
- `server/middleware/factoryBackendAccessBoundary.ts`: declares Factory
  Accounts as the owner of the Factory endpoint family.
- `migrations/20261021_002_cost_centers_phase2_integrity.sql`:
  - prevents archived centers from receiving new allocations
  - enforces the financial source's expense vs asset treatment
  - forbids duplicated Factory daybook journal/payment/sale mirrors
  - originally rejected amount/currency/date/company/source changes on
    allocated entries; **superseded by Phase 8** (see below), because a cost
    center tag must never block an accounting edit
  - keeps parents with active children from being archived
- Migration registered in `migrations/meta/_journal.json`.
- Both migrations are additive and do **not** backfill or modify posted rows.

## Endpoint contract (same relative paths under both prefixes)

| Method | Route | Purpose |
| --- | --- | --- |
| GET | / | Active center catalog (`?includeArchived=true` for history) |
| POST | / | Create cost center, optionally with a company-owned parent |
| GET | /:id | Single cost center |
| PATCH | /:id | Edit, re-parent, rename, or enable/disable |
| POST | /:id/archive | Archive without deleting historical allocations |
| GET | /:id/activity | Paginated original-source allocation activity |
| GET | /:id/balance | Grouped historical USD analytical amounts by cost treatment |
| GET | /:id/history | Audited cost center edits |
| GET | /allocations/:sourceType/:sourceId | Source amounts, split rows, unallocated remainder |
| PUT | /allocations/:sourceType/:sourceId | Atomically replace split rows (empty array clears) |
| GET | /allocations/:sourceType/:sourceId/history | Audited split edits |

`sourceType`: `voucher_entry` or `factory_daybook`.
`PUT` payload example:
```json
{
  "reason": "Allocate October workshop electricity",
  "splits": [
    {"costCenterId": 12, "amountNative": "75.000000", "amountBase": "75.000000", "costTreatment": "EXPENSE"},
    {"costCenterId": 13, "amountNative": "25.000000", "amountBase": "25.000000", "costTreatment": "EXPENSE"}
  ]
}
```
The source must be eligible and have at least the combined amounts. Both
currency amounts are validated against the original source valuation and
6-decimal rounding tolerance. Source currency and historical rate come **from
the server**, not the request. A split never posts a financial journal.

## Permissions and accounting boundaries
- All routes require active login, canonical current-company identity and
  company-specific role. Read: Developer/Admin/Owner/Manager; write:
  Developer/Admin/Owner. Browser-supplied company IDs are never accepted.
- Factory routes also require access to the Factory Accounts page.
- PostgreSQL FORCE RLS and composite company foreign keys remain authoritative.
- Protected (GC-, MIG- and SP read-only), optional and deleted voucher sources
  cannot be newly allocated or edited by the API.
- Source lines are eligible only as expense or asset ledger lines. Asset lines
  are classified `INVENTORY_COST`; they are **not** P&L expenses.
- Factory daybook allocations are permitted only for explicitly standalone
  expense tx types. Journal, payment and POS-expense mirrored daybook rows must
  use their underlying voucher expense line instead.
- Allocation writes replace the complete split set inside one transaction,
  use advisory locks to serialize cost-center allocation writers, and record
  before/after snapshots in `audit_log`.
- Accounting always wins over analytics (Phase 8 lifecycle): when an allocated
  source's amount, currency, company or voucher changes, the stale splits are
  cleared after the change, automatic rules re-tag the source, and removed
  manual work is listed under automation diagnostics. Rate-only changes and
  account moves that keep every split eligible keep the splits. Source soft
  deletion is excluded from analytical activity; physical source deletion
  cascades the analytical rows and lists removed manual splits.
- The `/:id/balance` endpoint is an **analytical allocation total**, not a
  general-ledger, supplier, cash/bank, P&L or net-position balance.

## For Claude's validation/release
As requested, implementation was committed without running CI, checks, tests
or applying a production migration. Claude should validate the SQL migrations
in a controlled database, typing and route security, evaluate integration with
existing Factory Daybook and voucher workflows and any source lifecycle edge
cases, and certify before merging/deploying. In particular, verify any
pre-existing company RLS policies and the ordering of the two new versioned
migrations. Phase 3/4 UI wiring is **not** included in Phase 2.
