# Cost Centers — page permissions and report exports

Follow-up to PR #2416 (Phases 1–8). Cost Centers stay analytical only: none of
the rules below post, delete or revalue a voucher, balance, FX rate, container
cost, inventory valuation or Factory production cost. No migration is involved.

## ERP: the Accounts page owns Cost Centers

`server/middleware/costCenterErpPageAccess.ts` is mounted in
`server/routes/applicationRoutes.ts` on `/api/cost-centers` ahead of every ERP
Cost Center router (management, allocations, automation, reports, exports,
budgets, historical batches, release readiness).

- The rule is the one `/api/my-erp-pages` applies, evaluated for the active
  company from canonical `user_company_roles` (not the cached session role):
  Admin and Developer have full ERP access; every other role needs an
  `accounts` row in `erp_user_page_access` for that company.
- Missing grant → HTTP 403. Missing company context → 401/403 from the active
  company resolver. Lookup failure → 500 (fails closed).
- A grant in another company does not count; switching company re-evaluates
  against the newly selected company.
- Consolidated ERP reports include only companies where the user holds an
  Admin/Owner/Developer role **and** (Admin/Developer there, or an `accounts`
  grant there).
- `GET /api/vouchers?costCenterId=…` (Daybook cost-center filter) reveals
  allocation membership, so it requires the same grant. The Daybook itself,
  without that filter, is unaffected. The filter is hidden in the UI unless
  `/api/my-erp-pages` grants `accounts`.
- Route handlers keep their own role gates (read: Admin/Owner/Developer/
  Manager; write: Admin/Owner/Developer).

`/api/factory/cost-centers` is not covered by this middleware: Factory Mode
uses its own boundary below.

## Factory: source-owned allocation access

`server/middleware/factoryBackendAccessBoundary.ts`:

| Path under `/api/factory/cost-centers` | Factory page required (any one) |
| --- | --- |
| `/voucher/:id/entries`, `/allocations/voucher_entry/…` | Cost Centers, Accounts, Vouchers |
| `/allocations/factory_daybook/…` | Cost Centers, Accounts, Daybook |
| `GET /` (catalog for pickers) | Cost Centers, Accounts, Vouchers, Daybook |
| everything else (management, reports, exports, budgets, automation, historical) | Cost Centers, Accounts |

Vouchers-only users cannot read standalone Daybook allocations and Daybook-only
users cannot read voucher allocations. Existing Factory role restrictions per
page and the API role gates still apply.

In the UI, `VoucherCostCenters` and `FactoryDaybookCostCenters` render nothing
when the server answers 403, so a Daybook-only viewer opening a voucher-backed
Daybook row sees no allocation panel and no error.

## Report exports

`GET …/reports/export` and `GET …/reports/consolidated/export` accept the same
views — `summary`, `activity`, `departments`, `accounts`, `months` — in `csv`,
`xlsx` and `pdf`. Anything else is HTTP 400. Amounts are historical USD;
`fromDate`/`toDate` filter every view; the existing `exp_excel` operational
permission still applies to both endpoints.

| View | Columns |
| --- | --- |
| summary | companyName, code, name, expense, budget, variance, inventoryCost, entries (+ UNALLOCATED row) |
| activity | sourceDate, companyId, costCenterCode, accountName, sourceModule, voucherNumber, treatment, allocationOrigin, currency, amountNative, amountUsd |
| departments | companyName, code, name, expense, budget, variance, inventoryCost, members |
| accounts | companyId, accountName, expense, inventoryCost, entries |
| months | month, expense, unallocated, budget, variance, inventoryCost |

## Tests

- `tests/cost-center-erp-page-access.test.ts` — middleware decisions.
- `tests/cost-centers-lifecycle.test.ts` — real PostgreSQL: every ERP route
  family denied for Owner/Manager without `accounts`, allowed with it, grants
  are per company, consolidated scope, voucher filter, and every export view ×
  format × scope with column and value checks.
- `tests/factory-backend-access-boundary.test.ts` — Factory source ownership.
- `tests/ui/cost-center-permission-denied.test.tsx` — panels hide on 403.
