# Factory blue-theme unification — Phase 5 release and production certification

**Date:** 2026-11-10  
**Status:** Release verification in progress; production target confirmation required.

## Phase 5 definition

The Phase 3 implementation record explicitly defines Phase 5 as **final program verification, CI/deployment checks and production confirmation**. This is not another UI redesign phase.

## Source verification evidence

| Gate | Evidence | Result |
| --- | --- | --- |
| Shared Factory blue-theme contracts | Focused Vitest suite, both files | 8/8 passed (Phase 4 sandbox) |
| Production frontend/server build | `npm run build` | Passed (Phase 4 sandbox) |
| Full Factory responsive React UI | `tests/e2e/factory-theme-responsive-phase4.mjs` | 36/36 passed using synthetic data, 390/768/1440 light/dark |
| Live Factory dark-mode navigation | Authenticated browser smoke visits | Six representative Factory areas inspected at desktop viewport |
| GitHub CI enforcement | `.github/workflows/factory-blue-theme-phase5.yml` | Workflow added on `main` at commit `66f45257fffe00c848792d1e64e87aaadf71826f`; **first GitHub Actions result not yet retrieved** |
| GitHub commit Vercel status | Commit `66f4525` | `success` from Vercel status context; **not a Render release** |
| Render deployment of newest `main` | Pending exact workspace/service confirmation | **Not deployed by this Phase 5 pass** |
| Exact-width authenticated production visual test | TinyFish mobile emulation unsupported | **Separate open gate** |

## Planned production release procedure (after target confirmation)

1. Confirm the specific Render workspace and service URL. The project has been associated with both a `system` service at `https://erp-pos-system-copy.onrender.com` and an older `ERP-FACTORY-SYSTEM` service at `https://erp-factory-system.onrender.com`. Do **not** assume both should be deployed.
2. Read the current service deploy state, source branch, automatic deployment setting and deployed commit. Record current live commit as rollback target.
3. Verify a passing CI test result or reproduce the focused checks against the release commit before production rollout.
4. For manual-deploy services, trigger **only the confirmed** service's deployment of its configured branch. Do not clear cache unless there is evidence that doing so is needed.
5. Monitor Render deploy status and startup logs to completion, and verify the actual deployed commit and health endpoint.
6. Read-only authenticated Factory smoke checks on the newly deployed build: theme isolation, dark toggle, Location Inventory, Invoicing, Suppliers, Production Overview, Containers Hub and Payroll.
7. If new errors arise, stop rollout and use the recorded previous deployment as rollback candidate. Do not claim production release acceptance unless a running deployment and smoke checks are confirmed.

**Safeguards:** Do not deploy on both Render services by default. The authenticated browser uses a separately saved user-controlled profile. Never copy its cookies, credentials or confidential data into sandbox fixtures. Synthetic-data viewport tests do not certify live mobile/tablet data-heavy screens.

## Remaining closure requirements

- [x] Phase 4 source build and focused test evidence captured
- [x] Reproducible 36-case browser test included in `main`
- [x] Read-only Phase 5 GitHub Actions workflow committed
- [ ] Captured GitHub CI run passing for Phase 5 workflow
- [ ] User-confirmed Render workspace and production service target
- [ ] Target service deployed to approved release SHA and verified healthy
- [ ] Postdeploy read-only Factory smoke test
- [ ] Exact-width authenticated mobile/tablet production visuals (or explicitly accepted limitation)

**Current verdict:** Phase 5 is not yet fully complete, and no Render production deployment was triggered in this step.
