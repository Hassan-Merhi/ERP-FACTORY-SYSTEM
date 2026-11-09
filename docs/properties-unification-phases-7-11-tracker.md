# Properties Mode — Unification Execution Tracker (Phases 7–11)

**Working branch:** `properties-unification-phases-7-11` (created from `main` on 2026-11-09)  
**Scope:** Follow-up to `PROPERTIES_UNIFICATION_AUDIT_2026-11-09.md`. Keep all financial history and accounting boundaries unchanged.  
**Merge policy:** No merge into `main` as part of individual phases. No CI requirement added.

| Phase | Status | Notes |
| --- | --- | --- |
| 7 — Authorization and company scope | Implemented; automated execution not verified | Canonical company-context permissions for posted payment deletion, scheduled cancellation, and rental reconciliation. Focused tests added. |
| 8 — Financial presentation | Not started | Currencies, reconciliation definitions, historical snapshot policy, business dates. |
| 9 — Payment and rental UI cleanup | Not started | Shared renderers, dead filters and module-specific language. |
| 10 — Legacy and navigation | Not started | Dashboard compatibility, route coverage, bookmarks. |
| 11 — Regression verification | Not started | End-to-end tenant isolation, financial parity and navigation validation. |

## Phase 7 change register

1. `server/routes/rental/rentalRoutePermissions.ts`: New authorization middleware calls `getActiveCompanyPermissionContext` so permissions are derived from the current active-company assignment, not a stale session role. Administrative reconciliation remains Admin/Developer only. Deletion is allowed for Admin/Developer/Owner or eligible users with the active company's `canDeleteRecords` permission; POS, ERP Tester, View Only and Create Only cannot delete rental records.
2. `server/routes/rental/centralRentalPaymentDeletionRoute.ts`: Both company/module-scoped payment lookups and canonical deletion permission now apply before the payment service is invoked.
3. `server/routes/rental/rentalPaymentsAccrualRoutes.ts`: Scheduled payment group cancellation uses the same active-company deletion guard; existing company/module/status predicates remain.
4. `server/routes/rentalRouteFactory.ts`: Reconciliation uses the canonical selected-company role guard. Removed the separate `session.role` legacy fallback; valid authenticated sessions already require `currentRole`.
5. `tests/properties-unification-phase7-permissions.test.ts`: Matrix tests for roles and per-company delete flags, stale-session denial, unauthorized reconciliation, missing company assignment, unexpected errors and route registration checks.

## Phase 7 invariants

- No schema, migration, ledger, voucher, transfer, cashbox, receipt-allocation or historical snapshot logic changed.
- The global tenant isolation boundary still owns company membership and database scope. Both payment deletion services retain company and rental-module predicates.
- Guards affect write/read authorization only; accounting posting semantics for ERP, Factory and Properties were not unified.
- The guards follow the canonical active-company permission context and are intended to deny access after an assignment is revoked without waiting for session refresh.

## Verification record

- **Completed:** Static examination of the affected route registrations and canonical permission context; GitHub branch commits and fetch-back of updated source.
- **Not run:** Vitest, TypeScript compilation, production database checks, authenticated browser flows, CI, or runtime API calls. This workspace does not provide a checked-out executable application, so the new tests are committed for execution in the repository environment.
- **Before production use:** Run `npx vitest run tests/properties-unification-phase7-permissions.test.ts tests/phase33e-auth-role-guards.test.ts`, TypeScript check, and an authenticated two-company API permission matrix. Do not interpret the static verification as a passing test suite.

## Phase 7 implementation conclusion

Implementation and targeted regression coverage are committed on the working branch. Runtime verification remains outstanding and must be marked honestly until executed. Phase 8 can proceed on the same branch without touching production accounting data.
