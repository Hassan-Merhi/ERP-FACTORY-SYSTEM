# Phase 1 — Dead code inventory (static review)

**Status:** Phase 1 static inventory documented; no deletion authorized by this report.  
**Repository:** `Hassan-Merhi/ERP-FACTORY-SYSTEM`  
**Base:** `main` @ `3a210f315ddba5aaf0bbe6dee21b5d5e3417b97f` (2026-10-12 snapshot)  
**Working branch:** `refactor/erp-dead-code-cleanup`  
**Machine-readable inventory:** [phase-1-inventory.json](./phase-1-inventory.json)  
**Execution policy:** GitHub file/tree/manifest inspection only. **No CI, tests, build, runtime checks, typechecking or deployment.**

## 1. Repository-wide file inventory

| Inventory facet | Count | Meaning |
|---|---:|---|
| Tracked files | 5,765 | Complete, non-truncated recursive Git tree |
| Frontend `client/src` JS/TS source | 1,849 | `.ts/.tsx/.js/.jsx` |
| Backend `server` JS/TS source | 1,888 | Includes `.mjs` |
| `shared` JS/TS source | 91 | Types, schemas, shared helpers |
| `scripts` JS/TS source | 177 | Maintenance, verification, migration scripts |
| Empty tracked files | 0 | Based on Git tree blob sizes |
| Identical JS/TS source blob SHA groups | 0 | This does not detect logically duplicated functions |

The full repository includes extensive test coverage, migrations, docs, `build/`, `.github/`, mobile/desktop sources and tooling. A filename scan is **not** proof of dead-code reachability. The inventory deliberately distinguishes **evidenced**, **likely**, and **unresolved** candidates.

## 2. Ranked candidates

| Priority | Candidate | Classification | Evidence | Subsequent phase |
|---|---|---|---|---|
| P0 | `server/routes/containers/offload/create.ts` | High-confidence **shadowed handler** | `registerContainerRoutes` invokes lifecycle guard and then `registerCentralContainerOffloadRoute` before `registerContainerOffloadRoutes`. The central POST `/api/containers/:id/offload` responds without calling `next()`, so the legacy POST is ordinarily unreachable. Only remove the old *create* registrar; keep `offload/recalc` and `offload/charges`. | 3 |
| P1 | `scripts/audit-legacy-route-boundaries.d.mts` | High-confidence **orphan declaration** | The matching audit script was retired per `docs/archive/engineering/phase9-legacy-compatibility-removal.md`; code search for `auditLegacyRouteBoundaries` found only this declaration. | 2 |
| P1 | `client/src/pages/SoldContainers.tsx` | High-confidence **unrouted standalone page** | `/sold-containers` redirects to `/containers` in `ErpRoutes`; import string appears in `lazyPages.ts` and a direct UI test; live `Containers` uses `SoldContainersTable` instead. Check secondary imports before deletion. | 2 |
| P1 | `client/src/pages/factory/FactoryProduction.tsx` | High-confidence **unrouted old production hub** | No consumer in reviewed primary ERP/POS/factory route sources. Imported via `lazyPages` and direct UI test; underlying production pages have other routes/hubs. Check offline prep and secondary imports first. | 2 |
| P2 | `scripts/pr1559-self-fix.mjs` | Medium **historical one-shot source patch** | Performs hard-coded replacements for PR #1559. Branch-protection docs describe the associated workflow as a one-shot manual repair. Check non-repo/manual consumers. | 9 |
| P2 | `scripts/phase3-preflight-patch.mjs` | Medium **historical one-shot source patch** | Changes other source-writing scripts and a test fixture based on historical `origin/main`. No filename references found in code search. | 9 |
| P2 | `scripts/phase3-wire-capacity-locks.mjs` | Medium **historical source-mutator** | Name reference found in `phase3-preflight-patch.mjs`. Check whether initial rollout is complete and whether any workflow uses it. | 9 |
| P2 | `scripts/phase3-finalize-creation-locks.mjs` | Medium **historical source-mutator** | Filename code search yielded no references; investigate manual usage. | 9 |
| P2 | `scripts/phase4-remaining-type-safety.mjs` | Medium **historical source-mutator** | Filename code search yielded no references; investigate manual usage. | 9 |
| P2 | `scripts/apply-phase3-heavy-read-indexes.mjs` | Medium **historical rollout script** | Only own script matched filename code search; investigate database/ops retention. | 9 |
| P2 | `scripts/apply-phase9-batch-a-streaming.mjs` | Medium **historical rollout script** | Filename code search yielded no references; investigate manual usage. | 9 |

**Not yet approved for deletion:** all candidates above. High-confidence evidence is a cleanup *starting point*, not permission to remove unreviewed dynamic consumers.

## 3. Server route registration inventory

Source: `config/route-manifest.json` at the same base commit.

- **2,132 registered HTTP route entries**, plus **130 middleware mounts**.
- **1,991 unique method + literal path signatures**.
- **123 signatures registered more than once**, giving **141 extra registrations**.
- Full **123-entry**, ordered, guard-chain-aware inventory is in `phase-1-inventory.json > routes.overlaps`; each entry records manifest registration ordinal and original guard chain.
- **Do not delete overlaps automatically.** Some represent deliberate preflight security, compatibility fall-through, response decorators, or a central replacement before an unreachable handler.

Examples requiring special caution:

| Signature | Registrations | Initial classification |
|---|---:|---|
| `DELETE /api/vouchers/:id` | 6 | Ownership and guard-chain review needed |
| `POST /api/sp/offload` | 4 | **Intentional chain**: retain preflight/concurrency guards |
| `POST /api/factory/raw-stock/recalc/historical-replay/apply` | 4 | Ownership review; inventory mutation risk |
| `POST /api/stock-transfers/:transferId/revisions` | 4 | Ownership review; approval/revision risk |
| `POST /api/containers/:id/offload` | 3 | Guard → central handler → shadowed old create handler |
| `GET /api/factory/categories` | 2 | **Intentional** French-language condition + fallback |
| `GET /api/factory/net-position` | 2 | **Intentional** historical-date response wrapper + live handler |

A route-manifest name collision by itself has **zero deletion authority**; the handler body must be read for every duplicate before modifying code.

## 4. Frontend route and lazy-page inventory

- `client/src/lazyPages.ts` declares **212 lazy page exports**.
- **48 of those exported names do not occur in the five reviewed primary route/composition files** (`ErpRoutes`, `PosRoutes`, `AppRoutes`, `FactoryRoutes`, `AuthenticatedApp`).
- All 48 symbols and module import targets are recorded under `frontend.nonPrimaryRouterExports` in the JSON inventory.
- **Those 48 are NOT 48 dead pages.** Internal tab hubs, embedded views, secondary imports, offline preloading, feature-gated navigation and test harnesses can use them.
- `SoldContainers` and `FactoryProduction` have stronger evidence because their explicit module import strings also appear only in `lazyPages` and direct UI-test imports, and their routes are not active.

Phase 2 should remove only proven unreachable pages/exports and adjust references conservatively. A page's underlying components must **not** be removed merely because an obsolete hub imports them.

## 5. Scripts and dependencies

- Existing `config/script-inventory.json` has an orphan ceiling of zero but only covers `scripts/audit-*.mjs` and `scripts/verify-*.mjs`, **not all 177 JS/TS scripts**.
- Additional historical source-writing scripts are flagged in the candidate table; one-off scripts may still be valuable as documented recovery tools. Keep historical migrations and DB repair utilities until their ownership/retention requirements are established.
- Root `package.json` currently has **112 production dependencies and 40 development dependencies**. **No package has been classified as unused** from this read-only review; dependency usage requires source/build-tool/desktop/mobile analysis (Phase 8).
- Do not delete historical database migrations, accounting repair procedures, or recovery scripts just because code search does not mention them.

## 6. Known live code — guard against false positives

Explicitly preserve these as active or required until a later independently supported migration:

- `client/src/pages/AccountsLegacy.tsx`, `AnalyticsLegacy.tsx` and `SalesReportLegacy.tsx`: imported by active wrapper pages (and `SalesReportLegacy` participates in a Vite build plugin).
- `client/src/pages/containers/SoldContainersTable.tsx`: used by live `Containers`, unlike standalone `SoldContainers.tsx`.
- `client/src/pages/factory/FactoryLocationInventoryMockup.tsx`: has an active factory route despite its name.
- `server/routes/factory/factoryFrenchCatalogReadRoutes.ts` and `server/routes/factory/employee-pos/netPositionHistoricalCorrection.ts`: intentional `next()`/fallthrough behavior.
- `server/services/factory/postOffloadPhase6Safety.ts`, `server/lib/databaseSsl.d.mts`, shared re-export modules: imported despite small file sizes.
- `POST /api/sp/offload` multi-registration guards: intentional, not duplicate business operations.

## 7. Review boundaries and remaining uncertainty

This phase is a **static evidence and triage inventory**, not an exhaustive execution-reachability proof. We inspected the entire tracked path tree, route manifest, main route compositions, relevant script registry, package metadata, selected file bodies and targeted symbol references. We **did not** read and trace every import, variable and exported symbol inside all 5,765 file bodies; therefore we cannot assert that all dead code has been found.

Unresolved categories intentionally carried forward: project-wide unused exports, unused internal functions, secondary embedded imports, dynamic module references, CSS/assets, unused dependencies, shared schema consumers, scripted external callers, middleware fallthrough, and historical DB tool retention. These are explicit review tasks for the subsequent specialized phases rather than an implicit claim they have no dead code.

## 8. Phase 1 handoff and exit criteria

- [x] Baseline immutable source commit and dedicated work branch established.
- [x] Complete recursive tracked-file inventory and file-size/SHA-level findings captured.
- [x] All route-manifest signature overlaps enumerated with ordinal/guard-chain evidence.
- [x] All non-primary-router lazy-page exports enumerated and **not mislabeled as dead**.
- [x] Prioritized confirmed/high-confidence and medium-confidence candidates with supporting evidence and phase ownership.
- [x] Known-live legacy code and explicit don't-delete guardrails documented.
- [x] Candidate ledger and route overlap details saved as structured JSON for follow-on phases.
- [x] No CI, tests, builds or deployments run.
- [ ] Complete all-code dependency graph, package/asset reachability and runtime verification — **reserved for later phases**, not falsely certified here.

**Phase 1 document/inventory handoff is complete.** Proceed to Phase 2 only with the evidence-led deletion policy above.
