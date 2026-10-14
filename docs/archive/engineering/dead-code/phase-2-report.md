# Phase 2 — Remove confirmed dead files

**Status: COMPLETE (scope: Phase 1 high-confidence file-removal candidates)**  
**Repository:** `Hassan-Merhi/ERP-FACTORY-SYSTEM`  
**Branch:** `refactor/erp-dead-code-cleanup`  
**Baseline:** `main` @ `3a210f315ddba5aaf0bbe6dee21b5d5e3417b97f` (Phase 1 audit snapshot)  
**Inventory:** [Phase 1 report](./phase-1-report.md) · [Phase 1 raw inventory](./phase-1-inventory.json)  
**Policy:** No CI, tests, typecheck, builds, deployment, or runtime checks executed. GitHub source/tree inspection is evidence collection, not a test run.

## Files deleted

| Path | Approx. bytes removed | Why it was removable |
|---|---:|---|
| `scripts/audit-legacy-route-boundaries.d.mts` | 873 | Orphan declaration for a retired `audit-legacy-route-boundaries.mjs` audit. Historical Phase 9 cleanup documented the script's retirement; the declaration's exported audit symbol had no other indexed consumer. |
| `client/src/pages/SoldContainers.tsx` | 5,976 | Standalone sold-containers page was not reachable from ERP/POS/factory route sources. ERP `/sold-containers` redirects to `/containers`. The live containers UI uses `client/src/pages/containers/SoldContainersTable.tsx`, which was retained. |
| `client/src/pages/factory/FactoryProduction.tsx` | 5,876 | Old factory production hub was not reachable from the active router composition or `offlinePrep.ts`; targeted source queries found only its lazy export and explicit test import. Underlying factory production modules remain live through their own routes/hubs and were retained. |

Total removed file bytes from these three tracked contents: **12,725** (GitHub returned UTF-8 contents; file sizes were independently recorded from the Phase 1 tree).

## Reference cleanup

- `client/src/lazyPages.ts`: removed the `SoldContainers` and `FactoryProduction` lazy exports pointing at the deleted modules. No other lazy exports changed.
- `tests/ui/wave4-remaining-pages.test.tsx`: removed exactly two page cases targeting the deleted standalone pages; kept every other page case and the shared test harness.
- Removed the now-unused `seededRecord` import, `PageCase.seedRoutes` optional field, and the two unnecessary per-case seed-route arguments. `stubSeededFetch()` still has the same default payload behavior, as declared by the existing `tests/ui/pageMocks.tsx` implementation.

**No tests were run.** Updating test source to remove imports of intentionally deleted modules avoids leaving static dangling imports; it does not certify any test result.

## Reference evidence considered

1. Explicit module-path repository code search for `pages/SoldContainers` and `pages/factory/FactoryProduction`.
2. Main routing composition `ErpRoutes.tsx`, `PosRoutes.tsx`, `AppRoutes.tsx`, `FactoryRoutes.tsx`, and `AuthenticatedApp.tsx`.
3. `client/src/lib/offlinePrep.ts` lazy preload references (does not preload either removed module).
4. `client/src/pages/Containers.tsx` and `client/src/pages/containers/SoldContainersTable.tsx` for the live replacement.
5. `docs/archive/engineering/phase9-legacy-compatibility-removal.md` and `tests/duplicate-route-ownership.test.ts` documenting retirement of the old audit script.

GitHub search results reference the `main` index, so changes on this branch were applied against GitHub-reported branch file SHAs rather than relying on search's indexing of new commits.

## Intentionally preserved / deferred

- `server/routes/containers/offload/create.ts`: strongly suspected shadowed old POST handler, but **Phase 3** must preserve guards and Express registration ordering; not a Phase 2 file-only deletion.
- The other 48 Phase 1 lazy-export *names absent from primary routers* are **not** presumed dead pages; many have use in nested hubs and offline prewarming. Review under **Phase 4** with consumer tracing.
- One-shot patch/migration scripts `scripts/pr1559-self-fix.mjs`, `scripts/phase3-preflight-patch.mjs`, `scripts/phase3-wire-capacity-locks.mjs`, `scripts/phase3-finalize-creation-locks.mjs`, `scripts/phase4-remaining-type-safety.mjs`, `scripts/apply-phase3-heavy-read-indexes.mjs`, `scripts/apply-phase9-batch-a-streaming.mjs`: **Phase 9** manual/runtime/recovery ownership assessment; untouched.
- Historical migrations, database recovery scripts, auditing tools, current `*Legacy.tsx` pages reachable through live wrappers, and compatibility modules with live importers remain intact.

## Completion criteria

- [x] High-confidence Phase 1 *file-removal* candidates dispositioned (3 removed).
- [x] Corresponding lazy module references deleted (2).
- [x] Corresponding obsolete test cases removed (2), leaving all other page coverage declarations intact.
- [x] No resulting orphaned seed-route fixture configuration left in the edited test file.
- [x] Offload route safety work explicitly deferred to Phase 3.
- [x] Medium-confidence scripts and ambiguous nested pages explicitly preserved.
- [x] No CI/testing/build/deployment commands invoked.

**Next phase:** Phase 3 — examine the **123** repeated method/path route signatures for actual handler reachability, keeping intentional guard middleware and response wrappers. See `phase-1-inventory.json > routes.overlaps` for the ordered list.

### Limitations

This is a *static* dead-file cleanup. Unindexed or external dynamic imports and runtime effects were not executed. The claim of completion applies to **the three verified high-confidence Phase 2 removal candidates**, not to comprehensive repo-wide dead-file proof. Subsequent phases address other categories.
