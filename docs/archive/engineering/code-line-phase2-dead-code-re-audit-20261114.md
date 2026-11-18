# Phase 2 — ERP + Factory dead-code cleanup and file-size re-audit

Date: 14 November 2026
Scope: `Hassan-Merhi/ERP-FACTORY-SYSTEM`, branch `audit/loc-300-500-20261113`
Release status: **branch-only, not merged to main or deployed**.

## Source and safety boundary

This phase incorporates the source-only, behavior-preserving cleanup from dead-code
PR #3203 (`refactor/erp-factory-dead-code-phase1-20261113`).
The integration is a separate merge on the file-size refactoring branch,
not a merge of PR #3203 into main.

The retired `client/src/pages/factory/FactoryLocationInventoryMockup.tsx`
was a 661-line sample-data-only mockup. Its historical developer-only URL
(`/factory/location-inventory-mockup`) now renders the live
`FactoryLocationInventory` component under the existing developer-only access
registry. The production inventory screen and its URL remain unchanged.

Remove 28 unused direct lazy-page declarations (including the mockup export).
Delete the three test mount/interaction fixtures that referenced the retired
sample page. Keep underlying usable pages, functional hubs and route consumers.

`scripts/audit-ux-module-consistency.mjs` now validates the four route consumer
registries against lazy exports and allows exactly one documented test-pinned
compatibility export (`FactoryWorkersHub`). After cleanup the audited
inventory contains 192 lazy exports and no unreferenced route-registry exports,
with 190 unique direct lazy modules.

No backend route, accounting service, posting behavior, inventory calculation,
schema, migration, voucher, intercompany logic, or permission role has been removed.
The attempted two-line commentary expansion in
`shared/factoryAccessRegistry.ts` was reverted to comply with the Phase 1
frozen-size ratchet. The route-registry access entry itself is unchanged.

## Measured file-size outcome

The initial Phase 1 enforcement reference (`main` at
`b5d5fea32ab435861ea77a38905eefdd42e64846`) had:

| Category | Before Phase 2 | After Phase 2 | Delta |
| --- | ---: | ---: | ---: |
| Application source files | 4,223 | 4,222 | -1 |
| Application files >500 physical lines | 531 | 530 | -1 |
| Application files 301–500 lines | 660 | 660 | 0 |
| Application files <=300 lines | 3,032 | 3,032 | 0 |
| Size-rule violations | 0 | 0 | 0 |

The 300 warning and 500 hard cap retain their Phase 1 definitions.
Pre-existing oversized files remain frozen at the Phase 1 reference count.
Read-only line-count results come from the
`Code file line limits (300 warning, 500 cap)` GitHub Actions workflow.
The deleted mockup accounts for 661 physical lines; lazy exports and tests
also shrink, but file-count changes shown above count application files only.

## Continued protection and verification

- Keep route registry/permission/Factory route fixtures unchanged in meaning.
- TypeScript, app build, frontend and backend suites, lint/format, source-size
  audit, route-manifest and full source audits must remain green before merge.
- Repeat `npm run audit:ux-consistency` whenever editing lazy exports.
- The dead-code report `npm run report:dead-code` emits *leads*; it is not
  permission to delete test-pinned financial modules or layered Express routes.
- Never remove stock/FX/rent accounting, shared Drizzle schemas, hidden features,
  retained compatibility handlers, or routes based on a reachability guess.

## Remaining work

The current hard-cap split backlog is 530 **application files**.
Those belong to Phases 3–8. The 660 warning files will be reviewed in Phase 9.
Phase 2 intentionally does not attempt large rewrites of still-live business
logic or bypass failing CI checks.
