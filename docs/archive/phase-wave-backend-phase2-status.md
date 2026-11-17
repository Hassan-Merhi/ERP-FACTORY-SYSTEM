# Phase 2 — Backend semantic filename refactor

Status: **Implementation started, not yet certified**. Work exclusively on `refactor/phase-wave-semantic-names`.

## Committed and inspected
- Renamed chat classifier to `server/chat/dataQueryIntentClassifier.ts` and read-only query handler to `server/chat/readOnlyDataQueryHandler.ts` with imports and source-based regression references updated.
- Renamed inventory repair module to `server/inventoryValuationGuardedRepair.mjs`, preserving existing operational environment variables, repair identifiers and exported APIs. Updated its direct startup import and test reference.
- Renamed seven chat report shards according to their report families; updated the report implementation registry and known dependent source-text assertions.
- Added `scripts/refactor-backend-semantic-filenames.mjs`, dry-run by default, with reviewed explicit collision overrides and `.mjs`/`.d.mts` sibling treatment.
- Added `.github/workflows/backend-phase2-apply.yml`, restricted to this branch, for automatic apply **only after** locked installation, TypeScript check, production build, runtime dependency validation and targeted tests pass.

## Confirmed counts
- Phase 1: 147 active numbered backend runtime module filenames.
- First wave: 10 renamed and committed.
- Remaining: 137 as of branch commit `032cd930`, excluding tests.
- Recursive Git tree check on `ac3d021` confirmed no destination path collisions for those 137 under current mapping.

## Existing CI blocker and remediation
Backend validation run [43845573261](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/actions/runs/43845573261) failed during `npm ci`, before tests: package manifest and lockfile had drift, with missing lock entries for `glob@13.0.7`, `path-scurry@2.0.2` and `lru-cache@11.5.3`. Both verification and bulk-apply workflows now perform `npm install --package-lock-only --ignore-scripts --no-audit` before `npm ci --ignore-scripts`; any resulting lockfile update must be reviewed in the final diff.

## Pending completion gates
- [ ] Bulk refactor GitHub Actions workflow completes successfully and its output commit lands on the branch.
- [ ] All 137 remaining backend modules renamed; linked imports, declarations, scripts and tests resolved.
- [ ] `npm run check` passes.
- [ ] `npm run build` and `npm run verify:runtime-dependencies` pass.
- [ ] Focused backend regression tests and startup preload contract tests pass.
- [ ] Full backend filename inventory reports zero unexcepted numbered runtime paths.
- [ ] Verify source-text references and broader backend tests; ensure no unplanned persisted identifier or environment flag changes.

Bulk apply run: [43847370747](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/actions/runs/43847370747).

No production database action or `main` merge is part of Phase 2. **Do not claim Phase 2 complete until all gates pass.**
