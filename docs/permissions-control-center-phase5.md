# Permissions Control Center — Phase 5 User Access

**Branch:** `feature/permissions-control-center`
**Status:** Source implementation delivered for shadow exceptions. Not production activated.

## Implemented

- Company-scoped user directory from canonical `user_company_roles`, restricted to Admin/Developer via active-company permission context.
- User Access editor under Settings > Users & Permissions. Existing user Company Roles editor continues to manage real role assignments and location/cash limits.
- Per-user Allow/Deny/Inherit decisions for all shared business resources and actions; explicit protection of system administration and Create Only immutable operations.
- Reset visible decisions to inherited role rules, discard local drafts, and review exact before/after changes before saving.
- Save via the Phase 2 atomic and audited `PUT /api/permissions-v2/user-overrides`, with required reason, at most 100 unique changes, and optimistic revision conflict detection.
- Server-side hypothetical "View as user" diagnostic using canonical company membership. An explicit mismatching role in the preview request is rejected.
- Member list, override reads and preview calls are company-scoped; API remains no-store and server guards remain authoritative.
- Added backend unit tests for company membership and self-override restrictions.
- Exact new `GET /api/permissions-v2/users` route recorded in CI ratchet allowances.

## Explicit exclusions and blockers

- **Create Only role assignment remains disabled.** It is intentionally NOT inserted into the legacy role picker, since Phase 3 handler verification and Phase 7 certification are not complete; permitting assignment prematurely could bypass ordinary workflows.
- Existing company-role assignment and POS location/cash restrictions stay in the hardened legacy editor, unchanged. The V2 panel gives a role summary rather than silently replacing those business workflows.
- Shadow user exceptions DO NOT affect current ERP/Factory/POS/Rentals authorization; user preview is a hypothetical comparison, not active authority.
- The user directory currently identifies members by user ID and role, not human-readable user names.
- The Phase 2 database migration remains opt-in and unapplied until approved. Missing tables fail with HTTP 503.
- No production role, ledger, stock, payroll or container data is changed.
- CI, browser accessibility, localization, light/dark and responsive tests still need verification; do not treat Phase 5 as release certified.

## Follow-up verification

Run type checking, linting, formatting, the phase2/phase3/phase4/phase5 security suites, route-manifest audits, and cross-company API tests. Test simultaneous edits from separate browser sessions and stale revisions, protected Admin/Developer users, and rollback to role defaults. Complete Phase 3 handler verification and Phase 7 security certification before activating V2 authorization.
