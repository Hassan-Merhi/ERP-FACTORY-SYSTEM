# Cost Centers follow-up — ERP page grants, Factory source access, report exports

Branch: `fix/cost-centers-permissions-exports-20261022` (based on current `main`).
Findings: three unresolved automated review comments made after PR #2416 was merged.

## Source changes (committed; CI/testing deliberately NOT executed)

1. **ERP permission bypass** — `server/middleware/costCenterErpPageAccess.ts`,
   registered from `server/routes/applicationRoutes.ts` before **all** ERP
   Cost Center API routes. The middleware uses the canonical active-company
   context and the same ERP Accounts page grant as `/api/my-erp-pages`.
   Admin/Developer retain their existing full-access exception; Owner/Manager
   must have explicit `accounts` for that active company. The middleware
   fails closed on errors and returns HTTP 403 on missing permission.
   Factory prefixed routes are intentionally not covered.

2. **Factory Voucher/Daybook source separation** —
   `server/middleware/factoryBackendAccessBoundary.ts`:
   - Voucher-backed allocations and voucher entries: Cost Centers, Accounts,
     or Vouchers page access; Daybook alone is NOT sufficient.
   - Standalone Factory Daybook allocation: Cost Centers, Accounts, or Daybook
     page access; Vouchers alone is NOT sufficient.
   - Basic cost-center catalog GET remains readable from authorized Vouchers
     or Daybook page pickers, since it exposes no source amounts.
   - Center management, reports, automation, and historical bulk operations
     continue to require the authorized Cost Centers or Accounts finance page.
   - Existing API role gates still determine which of those roles may write.

3. **Current-company exports** —
   `server/routes/costCenterReportingRoutes.ts`: both normal and consolidated
   report export endpoints use the same explicit list of supported report
   views: `summary`, `activity`, `departments`, `accounts`, `months`.
   The format whitelist remains `csv`, `xlsx`, `pdf`; existing operational
   export-permission requirements remain in force.

## New test coverage (written, not executed)

- `tests/cost-center-erp-page-access.test.ts`: Owner/Manager denied when no
  per-company Accounts grant (multiple endpoints), allowed with grant,
  Admin/Developer bypass, and fail-closed on lookup errors.
- `tests/factory-backend-access-boundary.test.ts`: Voucher and standalone
  Daybook source-specific policy, catalog allowance, finance-only APIs.
- `tests/cost-centers-lifecycle.test.ts`: CSV exports from every current
  company tab, XLSX/PDF for monthly tab, unknown view returns 400.

## Claude validation / integration instructions

- Run TypeScript, lint, security and backend/frontend tests, including the
  tests above. No CI checks were invoked when these commits were prepared.
- Confirm ERP Owner/Manager with `accounts` revoked cannot call ANY ERP Cost
  Center endpoint directly, including historical apply, report exports,
  management writes, or release readiness; then test after granting access.
- Confirm a Factory Manager assigned *only* Daybook cannot read voucher source
  allocations, and a Voucher-only Manager cannot read standalone Daybook
  allocations. Confirm legitimate full-finance roles still function.
- Verify the Factory Daybook UI degrades gracefully when its viewer cannot
  open Voucher Cost Center allocations, without exposing the restricted data.
- Verify all three export formats, all five supported views, and existing
  `exp_excel` authorization / invalid-view behavior.
- These fixes must not change source transactions, GL balances, FX snapshots,
  inventory valuation, Factory production, or customer/supplier balances.
- Do not merge/deploy until owner authorizes; no production database migration
  is introduced by this follow-up.

Status: **Source implemented and committed. Not tested or merged.**
