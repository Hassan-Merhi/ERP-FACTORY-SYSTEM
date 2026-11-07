# Permissions Control Center — Phase 4 Role Templates UI

**Branch:** `feature/permissions-control-center`
**Scope:** Stage-only UI. It does not authorize new users, enable Create Only, apply database migration, or alter existing live permissions.

## Implemented

- Admin/Developer-only role template matrix inside Settings > Users & Permissions.
- Company-scoped catalog and role rules read from the canonical Phase 2 API.
- ERP/Factory/Retail/Properties/System filtering, resource search and action columns.
- Allow / Deny / Inherit cells; disabled unsafe Allow entries for protected system actions and Create Only immutable operations.
- Bulk decision changes over the visible resources (with protected cells skipped).
- Pending delta calculation; Reset discards unsaved changes; save requires a reason (10–500 characters) and a review dialog, with 100 changes maximum per transaction.
- Save to PUT /api/permissions-v2/role-rules using `expectedRevision`; backend performs atomic write and audit or rejects stale revisions.
- Explicit warnings that all changes remain in shadow mode. A company-context mismatch disables editing.

## Release and safety limitations

- The Phase 2 migration is deliberately not applied automatically: a missing permissions schema returns HTTP 503.
- Saved rules remain shadow-only and do **not** affect current ERP/Factory authorization.
- The matrix is available only to Admin and Developer; API permission checks are authoritative.
- It does not implement Phase 5 user-level overrides, role assignment, or the Phase 6 live UI gate.
- Impacted-user counts come from company-scoped role assignments. This count is informational; full legacy/effective-policy parity previews are not yet available. The review dialog shows an exact proposed before/after delta, not a claim of effective access.
- Current branch Phase 3 remains incomplete: do not release Create Only until the handler audit and security checks are finished.
- All unit tests and browser verification require CI validation; source commits alone are not a completion certificate.

## Verification checklist

1. Verify all phase4 matrix model tests in CI.
2. Test access by Admin, Developer, Owner, Manager, POS and ERP Tester and cross-company session changes.
3. Verify protected decision cells remain disabled and server rejects forged payloads.
4. Verify stale revision conflicts and resync behavior on another tab.
5. Test mobile horizontal-scroll matrix, keyboard access, both themes, English/Arabic/French and review dialog.
6. Run TypeScript, lint, formatting, documentation audit, security checks and full regression suite.
