# ERP Phase 3 — Unified navigation, permissions and UX audit

**Date:** 2026-11-11. **Scope:** ERP (including ERP POS and supplier-partner-linked functionality). No independent Factory or Properties work. Main baseline examined: `8d6a9822c98f8a24bd948eb46fb8ae4ac3f093b1`. This Phase 3 belongs to the user's current five-phase ERP program, not the older `docs/erp-90-phases-3-6.md` numbering.

## Verified source architecture

1. **Single ERP page registry:** `client/src/app/erpPageRegistry.ts` defines pinned desktop links, sections, utilities and mobile primary destination groups. A static inspection found **30 distinct desktop/utility navigation URLs and 30 corresponding literals** in `client/src/routes/ErpRoutes.tsx`. New regression test `tests/erp-phase3-navigation-parity.test.ts` checks that the registry cannot silently drift away from the route definitions.
2. **Central role policy:** `shared/erpNavigationPolicy.ts` restricts Developer-only, Admin-only, Owner/Admin and POS role pages in menus and route guards, with granular feature keys from `shared/erpRouteAccess.ts`. `client/src/components/AppSidebar.tsx` and `ErpMobileNavSheet.tsx` reuse the policy.
3. **Company-switch access boundary:** `client/src/app/ErpAccessBoundary.tsx` gates rendering of the entire ERP shell while page grants load and while the selected company differs from the synchronized permission-company ID. `erpPageAccessQueryOptions` uses a company-specific query key. Existing tests: `tests/ui/erp-access-boundary.test.ts`, `client/src/app/erpNavigationPolicy.test.ts`, `tests/ui/route-guards-render.test.tsx`.
4. **No navigation duplication identified in reviewed routes.** Coverage of remaining optional/conditional pages, responsive and RTL layouts, access-denied recovery, print, accessibility and actual per-role browser journeys requires executable E2E validation.

## Finding ERP3-01 — ERP page grants may be assigned to non-members (code fix authored)

Previously `GET/PUT /api/erp-user-page-access/:userId` in `server/routes/admin/userManagementRoutes.ts` trusted the caller's selected company without checking whether the **target** user had a `user_company_roles` membership there. The old storage setter also deleted all old keys and then inserted new ones in separate transactions.

**Fix on the review branch**:
- GET returns 404 for a target without a matching user/company role.
- PUT requires exact recognized ERP feature keys, no duplicates, explicit selected company and membership; otherwise returns 400/404 without saving.
- Membership is locked `FOR UPDATE` and all grant deletes/inserts are performed in one transaction so an insert error rolls back.
- New reusable strict input parser and focused unit/source-contract tests. Existing Administrator-only server role requirements remain unchanged.

This is a safer permission-management contract; it is **not a claim that the endpoint allowed cross-company data access**, which has other session/company protections.

## Production permission metadata (read-only)

- `user_company_roles`: **59 rows**, **one duplicate (user, company) assignment** in HADI company 1, duplicate rows have the same role.
- `erp_user_page_access`: **20 grants** for a single active user in TEST company 20 **without a matching company-role membership**. No duplicate page grant rows, no grants to absent users, no missing company references.
- `role_feature_permissions`: **1 row**, no duplicate (company, role, feature) entries.
- A duplicate-role cleanup migration is present in source (`server/startup-schema/022-tenant-control-integrity-repairs.ts`) but the checked production data still has one duplicate pair. Do not apply repairs blindly: determine whether migration ran in the deployed service and inspect the audit trail first.
- Orphan TEST grants may be stale retired sandbox permissions rather than a viable access route, but they are invalid assignment metadata requiring an owner-reviewed lifecycle cleanup. The patch prevents new grants through this admin endpoint to unassigned targets; it does not silently delete old ones.

**No production user, company, page-grant, or role records were changed.**

## Regression and sign-off requirements

- [ ] Unit tests: `tests/erp-phase3-page-grant-input.test.ts`; `tests/erp-phase3-page-grants-contract.test.ts`; `tests/erp-phase3-navigation-parity.test.ts`.
- [ ] Existing ERP access boundary, navigation, company-context and permission matrix suites pass on the exact branch SHA.
- [ ] Integration tests in a disposable DB: admin GET/PUT membership rejection, valid granted features, invalid keys, concurrent role removal, failed insert rollback; verify no cross-company grants.
- [ ] Manual signed-in browser checks for Admin, Owner, Manager, Normal User, View Only, Create Only, ERP Tester and POS on phone/tablet/desktop in HADI plus one subsidiary; verify navigation, Arabic/RTL, search, keyboard focus, denied routes and switching companies while grants load.
- [ ] Trace and classify HADI duplicate role and TEST orphan grants, then create an approved metadata-only cleanup if required.
- [ ] Exact-commit GitHub CI, build, accessibility/mobile tests, and release smoke tests pass prior to merge/deploy.

**Current status:** Focused backend authorization remediation authored, and source-level navigation/access audit complete. Phase 3 **cannot be declared certified** without integration E2E verification, role-metadata cleanup disposition, and passing exact-head CI. No Factory/Properties modifications, no production changes.
