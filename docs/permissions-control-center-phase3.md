# Permissions Control Center — Phase 3 work in progress

**Branch:** `feature/permissions-control-center`
**Status:** NOT COMPLETE; not release-ready. No role activation, SQL execution, production permission changes, merge or deployment.

## Initial Phase 3 implementation

- Added `server/services/security/accessControlV2Enforcement.ts`, an opt-in business-action middleware.
- A route owner must document and verify the actual handler and its ledger/stock effects before using it; existing authorization guards still run first.
- The middleware resolves the company role from canonical storage, not a browser-supplied role.
- Create Only cannot edit existing records, finalize, approve, reverse, delete, import, or repair, even if a role rule attempts to allow it.
- Failed company context checks are denied; internal errors do not fall through to business writes.
- Added contract tests; execution and live integration validation are pending.

## Continued Phase 3 integration

- Installed the global `blockUnverifiedCreateOnlyWrites` guard before business route registration, leaving existing roles unchanged.
- Added an exact-method/path deny-by-default policy. All unknown Create Only writes fail with 403; explicit authentication and presence transport exceptions are preserved.
- Reviewed `POST /api/suppliers`: it creates a company-scoped supplier and transactional audit record. It is the first exact route allowed through the outer guard and protected by a handler-specific canonical-company action guard. Create Only is denied if its payload requests a non-zero opening balance.
- Added direct API and bulk-route boundary contract tests. CI execution and security validation are still pending.
- This is a narrow verified handler, NOT verification of the entire Phase 1 candidate inventory.

## Open blocking work

1. Audit the remaining potentially mutating route registrations against the current `main` route manifest. The Phase 1 baseline counted 1,092 unreviewed write registrations.
2. Verify each handler and its downstream ledger, stock, payroll, approval, and state side effects. Never authorize a candidate purely because its URL appears to say `create`.
3. Mount the verified middleware route by route, preserving all existing role, company, period, location and financial guards.
4. Add direct API, malicious POST/bulk, create-vs-existing-record, cross-company and concurrent-change integration tests.
5. Keep new role selection and active authorization disabled until Phases 4–7 pass, followed by explicit rollout approval.

**No Phase 3 completion claim is made by this file.**
