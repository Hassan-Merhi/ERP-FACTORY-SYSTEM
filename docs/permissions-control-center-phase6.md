# Permissions Control Center — Phase 6 frontend authorization bridge

**Status:** Phase 6 foundational UI implementation in progress. V2 shadow permissions are NOT live access.

## Source shipped on feature branch

- `client/src/hooks/useCan.ts` exports `useCan(resource,action,{legacyAllowed,featureKey?})` and a pure `decideLegacyCan` evaluator. Existing server permissions and page-specific conditions remain required; the hook cannot authorize bypassing a protected backend action.
- The helper uses the selected company's active role and company-scoped `/api/my-permissions` data. Normal User remains explicit-allow, Owner/Manager/POS inherit their legacy allow-by-default semantics, while Admin/Developer retain their privileged legacy interpretation. View Only mutations and Create Only unverified writes are blocked.
- Legacy permissions loading, errors or missing company fail closed for feature-key checks, and the data refreshes on focus and periodically to avoid indefinitely stale UI restrictions.
- `client/src/components/Can.tsx` provides reusable hide-or-explain UI gating.
- Supplier page delete and Excel export are integrated, including guarded click handlers, disabled controls and user-readable reasons.
- `tests/access-control-v2-phase6-use-can.test.ts` tests parity, default-deny, loading and special roles.

## Blocking work before Phase 6 sign-off

1. Migrate all remaining role-sensitive page controls across ERP, Factory, POS, Properties and reporting. One Supplier page is NOT whole-system coverage.
2. Validate every frontend gate against its actual backend handler and special restrictions (locations, accounting periods, resource status, cash scope, factory page/field access, etc.). UI cannot become authoritative.
3. Implement backend effective permission decisions and per-user policy-version invalidation only after safe V2 activation; *do not* use Phase 2 hypothetical preview as permission to operate.
4. Validate language support, mobile accessibility, dark/light themes, role changes across tabs, denied 403 handling, and render gating in browser.
5. Run typechecking, targeted tests, complete CI and security regression before describing Phase 6 as complete.

No new role has been activated, no SQL migration run, and no merge or deployment is authorized by this phase.
