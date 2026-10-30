# Phase 8 — Final Source Review & Claude Acceptance Handoff

**Prepared:** 2026-10-26  
**Repository:** `Hassan-Merhi/ERP-FACTORY-SYSTEM`  
**Working branch:** `feature/navigation-usage-cleanup`  
**Status:** SOURCE HANDOFF COMPLETE; **NOT production-verified, merged or deployed**.

## 1. Scope and evidence

The project began as a real source navigation audit, followed by a read-only study of Render production route-change activity. The study in `docs/navigation-usage-study-2026-10-26.md` found 3,445 navigation records across 24 users and 11 companies at the initial snapshot, with a 30-day and latest-200-events-per-user cap. Absence from those logs does **not** prove that a page is unused. Core Factory Stock Entry, POS, Loading, Production and accounting routes have been preserved.

**Final branch comparison during Phase 8:** the feature branch was **73 commits ahead of `main`, 2 behind**, with 32 changed files relative to `main` *before this report was added*. Merge base: `1530e75ff35bdf74be5a88fdb00ed9f2b9f22c5d`. Do **not** rebase/merge without reviewing the two newer `main` commits and coordinating Claude's acceptance. This branch has **not** been deployed or merged by ChatGPT.

## 2. Phase source completion

| Phase | Result | Detailed report |
|---|---|---|
| 1 | Factory Daybook duplicate link removed; preliminary sidebar/command search alignment | Master plan |
| 2 | Read-only Render service, request/activity-log study with retention caveats | `docs/navigation-usage-study-2026-10-26.md` |
| 3 | ERP inventory, supplier, voucher, POS replacement and report tools moved into context, preserving deep links and fallback access | `docs/navigation-cleanup-phase3-erp.md` |
| 4 | Factory Production, Inventory, Sales & Loading and Finance navigation; contextual Contacts, Allocation, Sheets, Cost Centers | `docs/navigation-cleanup-phase4-factory.md` |
| 5 | Properties Rentals hub and POS/Retail-mode appropriate menus | `docs/navigation-cleanup-phase5-properties-pos.md` |
| 6 | Developer-only Accounting Toolbox in ERP/Factory/Properties; original reconciliation/maintenance routes retained | `docs/navigation-cleanup-phase6-accounting.md` |
| 7 | Align grouped/pinned/recent, mobile, command palette, role and hidden-tab visibility | `docs/navigation-cleanup-phase7-permission-parity.md` |
| 8 | Cross-phase static integration review, route/policy hardening, Claude handoff | This report |

## 3. Phase 8 source-level fixes

1. **Factory Cost Centers grant parity:** Phase 7's general privileged-role bypass was applied to the Cost Centers sidebar even though `FactoryRoutes` explicitly requires `myAccess.fullAccess`, `factory/cost-centers`, or `factory/accounts`, even for Developer/Admin/Owner. `client/src/components/FactorySidebar.tsx` now checks these stricter grant conditions before any privileged bypass. The destination's actual route policy has **not** changed.
2. **Factory contextual link role parity:** `client/src/components/FactoryRelatedLinks.tsx` uses `user.role`, matching `FactoryRoutes`, rather than independently preferring `currentRole`. Per-company grants and restricted Cost Centers checks remain.
3. **Properties Cash Transfer role parity:** `client/src/pages/properties/PropertiesRentalsHub.tsx` now checks `user.role === "Developer"`, matching `PropertiesRoutes` for `/properties/transfer`.
4. **Cross-mode keyboard command role parity:** `client/src/components/CommandPalette.tsx` uses the route-authoritative `user.role` for Factory and Properties entries and retains ERP's effective-role logic. This affects display only, not backend authorization.
5. **Branch divergence confirmed:** compared `main` and `feature/navigation-usage-cleanup` read-only; documented the branch being behind `main` by two commits. No synchronization operation was performed.

## 4. Verified by reading source (not executing it)

- Reviewed the committed navigation surfaces in `AppSidebar`, `FactorySidebar`, `PropertiesSidebar`, `ErpMobileNavSheet`, `PosShell`, `CommandPalette`, and `FactoryRelatedLinks`.
- Inspected hub link targets in `InventoryHub`, `StockHub`, `PartiesHub`, `SalesToolsHub`, `SalesReport`, `Vouchers`, `FactoryAccounts`, `FactoryContainersHub`, `FactoryLocationInventory`, `FactoryPartiesHub`, and `PropertiesRentalsHub`.
- Inspected `ErpRoutes`, `FactoryRoutes`, `PropertiesRoutes`, `PosRoutes`, `authenticatedAppRouteGuard`, `factoryAccessGuard`, the canonical Factory page registry, and role/feature mapping.
- Confirmed `PageHeader` supports the optional-vouchers action slot; `StockHub` has actual `items` and `query` tabs; Properties Rentals supports `warehouses`, `shops`, and `payments`; Factory Bale Explorer uses `history`, `barcode`, `products`, and `customer-loading`.
- Confirmed the original factory loading, reconciliation, POS, accounting, inventory and Properties business routes remain in the route files. New `/factory/balance-repair` is Developer-gated and registered in Factory access registry.
- Checked `main` divergence via GitHub comparison rather than assuming the feature branch is synchronized.

This is **manual/source-only review**. It does not establish successful TypeScript compilation, an error-free browser session, authorization effectiveness at the API layer, transaction correctness, or compatibility with newer `main` changes.

## 5. Risks Claude must examine before approval

**Priority 0 — access / authorization**

- Cross-company switch: re-fetch `/api/factory/my-access`, `/api/my-erp-pages`, and Factory feature flags. Verify that old-company links do not flash or remain after switching.
- Cost Centers for Factory Developer/Admin/Owner/Manager: route guard, sidebar, contextual Accounts link and command search must all agree; explicitly check a privileged role **without** the relevant grant.
- Restricted Factory users with empty `pageKeys`: grouped, pinned, recent and search should default deny. Source-level UI hiding is **not** backend API authorization.
- ERP supplier-only/customer-only, POS item replacement and optional voucher access: confirm hub tabs, direct bookmarked URLs, read and write endpoints all honor the intended independent permission keys.
- Properties Cash Transfer and every Developer-only Accounting Toolbox deep link: normal roles must not reach them through direct routes, search, recent links or maintenance APIs.
- Look for role mismatch between `role` and `currentRole` in session/user contracts. ERP route guards and Factory/Properties route guards presently use different fields; Phase 8 only aligned newly introduced Factory/Properties UI with their present guards.

**Priority 1 — workflow regression**

- Real POS, Retail POS, POS daybook, refunds, returns, credit accounting and stock transfers.
- Factory Stock Entry, bale tracking and loadings, invoice proformas and finalization, Factory Production report, inventory balances and Cost Centers.
- Supplier Profit Check, Optional Vouchers, Stock/Inventory hub, sales reports and the legacy SalesReport component. `SalesReport` currently supplies a compatibility `globalThis.selectedCompany` binding for `SalesReportLegacy`; independently check that it neither breaks rendering nor leaks data across companies.
- Factory hidden tab flags: Bale Explorer, Invoicing, Loadings, Parties and Payroll; check command search, active tab state, deep-link guards and settings disabled flags in combination.
- Properties Rentals tabs, developer Cash Transfer, accounting and historic payment URLs.
- Test links, keyboard navigation, screen readers, sticky header, mobile layout, Back, current-page highlighting and recent/pinned navigation across all roles.

**Priority 2 — integration and cleanup**

- Compare with the **two newer `main` commits** (and any subsequent main work) before integrating. Preserve newer fixes and avoid reverting parallel accounting/Retail/Factory changes.
- Confirm all imports and module exports in the added Accounting Toolbox and permission-aware navigation components.
- Confirm no false navigation entries (especially admin-only destinations) and that every search result opens its intended page.
- Review remaining pre-existing feature-grant or direct-route differences rather than broadening permissions to silence failures.
- Confirm no unused imports / diagnostics / hidden links regressions. Remove UI-only dead references only after their actual route and business purpose are reviewed.

## 6. Claude handoff prompt

> Audit **all eight phases** on branch `feature/navigation-usage-cleanup` in repository `Hassan-Merhi/ERP-FACTORY-SYSTEM` using `docs/navigation-usage-cleanup-plan.md`, the dated live usage report, and the Phase 3–8 handoff reports. Independently run the repository's relevant **TypeScript, lint, frontend build, navigation/access tests, and CI checks**. Inspect actual route guards, backend authorization, company-mode and role-specific navigation behavior. Fix any code and integration failures on the **same feature branch** and preserve accounting/stock/production/retail behaviour, all old URLs, existing permissions and production data. Specifically verify Cost Centers' special grant, Supplier vs Customer tabs, Factory hidden tabs, Properties developer tools, and POS/Retail route trees. Compare with `main` (the branch was two commits behind during review); coordinate and resolve conflicts **without merging or deploying automatically**. Provide file/commit evidence, full test results, a list of remaining blockers, and recommend whether it is safe for a human to merge. Do not modify production accounting entries or run destructive maintenance actions.

## Post-handoff integration watch — 2026-10-26

GitHub source comparison found **a newly introduced ERP View Only Dashboard restriction on `main`** that was absent from this navigation cleanup branch. The latest main version of `client/src/components/AppSidebar.tsx` hides `/financial-overview` for the effective role `View Only`, and `client/src/routes/ErpRoutes.tsx` explicitly redirects that role away from the Dashboard even if its page grant includes `dashboard`. Because the cleanup branch changed both files, retaining its old behavior during integration would resurrect Dashboard access for View Only.

**Safe, narrowly scoped compatibility fixes committed on this same branch:**
- `4cb2fcad1bc736528a882a7df668b3ee17955778`: hide `/financial-overview` in the shared ERP sidebar visibility predicate for `View Only`, covering desktop, mobile, recent and command-search navigation that reuse this predicate.
- `5a39035589b8edf62c4fdc62803eddb142a18120`: match `main`'s explicit `/financial-overview` route guard, redirecting `View Only` to the existing `/tracking` fallback.

The comparison **before these two fixes** reported the cleanup branch 75 commits ahead and 83 behind `main`; the prior watch had reported 73 behind. New `main` changes include ERP View Only Dashboard restrictions, posted-offload cost-integrity protections, and Raw Materials cost export/accounting-model work. The source fixes above preserve the **specific new View Only Dashboard rule only**; they do not incorporate or certify the other `main` changes.

**Remaining blockers:** Claude must still review the full divergent `main` changes and reconcile integration, independently run CI/build/typechecks/tests, and verify role/API authorization, accounting and stock workflows. This watch did **not** run automated checks, rebase, merge, deploy, or write production data. No cleanup-branch PR or independent Claude acceptance evidence was found during this check.

### Post-handoff check — 2026-10-26, 15:21 Asia/Beirut

- Compared the unchanged cleanup branch at `4bb766ff` with current `main` before writing; the cleanup branch had **zero new commits** since that prior handoff. GitHub comparison now showed **79 ahead / 92 behind `main`** (previous check: 83 behind), reflecting ongoing unrelated production work.
- **New verified UI parity gap:** `main` had changed `client/src/app/ErpShell.tsx` to **suppress the Company Daily Rate modal** for `View Only` and display a **View Only read-only status banner**. Both protections were missing from the cleanup branch despite its previous Dashboard restriction backport.
- Ported only those two `main` shell changes to the existing feature branch, commit `1b4c1c671e188306ccee9f7927e2331952b52b81`. The resulting `ErpShell.tsx` blob matches the current `main` file exactly (`762adf53de9d2f61a4e31a56add3042ef84cb600`). No unrelated shell behavior was changed.
- **Critical unported security gap:** `main` contains new `server/services/security/erpViewerPagePolicy.ts` and `server/services/security/viewOnlyWritePolicy.ts` and associated backend authorization changes **absent** from the cleanup branch. These are not equivalent to UI restrictions and must be preserved during Claude's reconciliation. This watch intentionally did not attempt to transplant the broader server middleware and authentication changes in isolation.
- After the shell fix, the branch comparison was **80 ahead / 92 behind `main`** before documentation commits. No independent Claude validation or new branch review findings were observed. No CI, tests, typechecks, builds, merges, rebases, deployments or production data changes were performed.

## 7. Completion criteria and current limitations

The user requested that ChatGPT make source changes on one branch and **not** run CI/tests/builds/merges/deployment because Claude will handle them. The source phase can be marked completed when all changes and the handoff are committed. **The overall ERP cleanup must remain unverified until Claude has independently run acceptance checks, reconciled newer `main` commits and approved each role/workflow regression.**

**Current result:** Phase 8 source handoff ready. CI, tests, typechecks, builds, rebase, merge, deploy and production data writes were not performed by ChatGPT.

### Post-handoff check — 2026-10-27, 11:13 Asia/Beirut

- GitHub comparison **before this fix**: cleanup branch `ec5c669acc589ff131a009117f8db2b7c405315e` was **82 commits ahead / 170 behind `main`** (`a27f16c6321821600b628c7153b756ac4ff907a6`), versus 98 behind at the prior watch. No cleanup-branch pull request or new Claude acceptance/commit workflow results were found.
- **New confirmed Factory Settings navigation parity gap:** `main` commit `f35c0a24e247c7c16ce1f11197eb28914c367c1a` added a Factory Settings → **Label Banner Images** link for Admin/Owner/Developer, targeting the existing `/factory/label-banners` route. The route existed on both branches, but the cleanup branch lacked the Settings entry and navigation handler. Without reconciliation, the cleanup branch could drop the new Settings shortcut.
- **Safe source-only backport:** commit `d8094c115154fffb3e8306d92a8ae43ed0d32813` updated only `client/src/pages/Settings.tsx`: added the admin-filtered Label Banner Images link and a common section-click handler for desktop/mobile navigation. The resulting Settings file blob (`06f4cb1cff61f03929e367e0bad07efb5aabf362`) matches `main` exactly. Existing route and role/server authorization were not changed; no business workflows were removed.
- **Still blocked:** newer `main` accounting/FX and security changes require Claude integration review. No CI, lint, typechecks, builds, automated tests, merge, rebase, deployment or production data mutation was performed. This is not independent runtime validation.

### Post-handoff check — 2026-10-27, 12:17 Asia/Beirut

- **New review/integration activity:** after the prior watch, a separate actor created PR [#2527](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/pull/2527) and added merge commit `29400acc12bdbe0e9c2f247e271813ffcc01dde7` (`merge(main): resolve ERP Factory navigation PR #2527 conflicts`) to this feature branch. This watch did **not** initiate that merge. At the time of inspection, the feature branch was **86 ahead / 2 behind** `main` (`ca95a00e2a0e107fc524b356793e0d252db56129`), a major reduction in the prior integration gap. The PR is open and marked ready for review, despite its body still saying to keep it draft. This is not acceptance or deployment.
- **New concrete Codex P2 finding:** the sidebar hid `/factory/contacts` whenever `/factory/parties` was route-accessible. When both `hide_tab_parties_customers` and `hide_tab_parties_suppliers` are set, `FactoryPartiesHub` returns its no-tabs message before rendering the contextual Contacts link. A restricted user with both page grants therefore loses sidebar access to an otherwise allowed Contacts workflow.
- **Narrow source fix:** commit `41a843ea163876d87e2f85339e88a3c222a8a630` changes only `client/src/components/FactorySidebar.tsx`: suppress the standalone Contacts item **only when at least one Parties tab is visible** and the Parties route is accessible. Both tabs hidden now preserves the direct Contacts link. Existing route grants, Contacts page, backend authorization and Parties hidden-tab rules are untouched. This is source review only; the fix has not been independently exercised.
- **Existing GitHub checks on pre-fix merge commit `29400acc`:** Type-check and Build passed, along with CodeQL and several security workflows, but **CI and UI Quality failed**. Frontend tests reported **20 failures in 9 files** (including navigation test-mock errors for `CommandPalette`, `ErpMobileNavSheet` and missing `CompanyProvider`); lint/format and documentation-index gates failed; the i18n actionable-literal ratchet increased; RTL/accessibility formatting failed. Backend tests also failed. These are explicit outstanding blockers; do not infer that the new Contacts fix resolves them. No independent Claude approval or complete role/API regression evidence was found.
- **Restrictions preserved:** no CI, lint, build, typecheck, automated test, rebase, merge, deployment or production data operation was initiated by this watch. Further integration and all failing checks remain for Claude/reviewers.

- **Second source-level access-parity issue confirmed by the existing CI log:** `tests/ui/factory-permission-wave5-certification.test.ts` reported `/factory/accounting/toolbox` as the one mounted Factory route not resolved by the canonical registry. The route was mounted Developer-only in `FactoryRoutes`, but `shared/factoryAccessRegistry.ts` lacked an entry; this also made direct-route guard classification inconsistent with the intended Developer restriction. Commit `2be1094ca5a1587c24aad9980170fc3824c05bb6` registers the existing Toolbox URL with `accessLevel: "developer"` and `settingsVisible: false`, without creating a new sidebar entry or changing the route, accounting features, or backend. No test rerun has been performed.
- **Specific remaining CI evidence:** the pre-fix `29400acc` lint job reports an unused `CalendarDays` import in `AppSidebar.tsx`, plus a zero-warning ratchet and 10 changed files needing formatting. The documentation audit reports unindexed cleanup documents. Frontend tests also include `erpVis.isItemVisible is not a function` in command-palette tests, missing `CompanyProvider` in Factory-related-link tests, and `visibleSections.flatMap` on undefined in mobile-nav tests. These are still unresolved; source-only fixes above are not proof of green checks.

### Post-handoff check — 2026-10-27, 13:15 Asia/Beirut

- **New verified Developer-only diagnostic access parity:** At the start of the watch, the feature branch remained at `6cc16877` and was 93 commits ahead / 5 behind current `main` (up from 2 behind). `main` commit `942ba3bd86a08d9d46d04c6f3725e38506cb341b` changed `client/src/pages/ContainerVerification.tsx` to show barcode alias-conflict diagnostics only when `/api/auth/me` reports role `Developer`. The feature branch still rendered `AliasConflictAlert` to all users viewing a verification result. This is a source-level role-display mismatch; no evidence of a server authorization change was inferred.
- **Safe parity fix on the same branch:** `bfeea3be66dd5931a3d7e1b4c7b36e2c9dbbbe80` adds the same typed `AuthMe` lookup and Developer-only rendering condition to `ContainerVerification.tsx`. The updated file blob is `c2a1162bbfb5ea52f3f339a0338cc3fea2858407`, identical to current `main`. No navigation URL, route, workflow, accounting, or API behavior was changed.
- **Remaining main divergence:** the other three-commit comparison changes affect Factory payroll (`dc94449a`, `667d53b`); these were not copied into the cleanup branch and must be preserved during final integration. The existing PR #2527 Codex finding is based on the older `29400acc` and its Contacts fix remains unverified; no new Claude review or independent full-green CI evidence was found. Existing CI/UI Quality failures and security/role regression acceptance remain blockers.
- **Restrictions:** this review did not run CI, lint, typechecks, builds, automated tests, merge, rebase, deploy, or touch production data. The new UI fix is not independently runtime-verified.


### Post-handoff source-only parity watch — 2026-10-29, 12:11 Asia/Beirut

- **New main role-visibility change:** commit `2f6f80da111af50a459d485c2eb271b64aef9672` (PR #2586) restricts inline voucher and Factory Daybook cost-center allocation panels to Developer users. Before this watch, `feature/navigation-usage-cleanup` still allowed Admin/Owner to edit and Manager to view those inline panels. This is a concrete newly introduced role/source-access parity gap; it is separate from the special Factory Cost Centers *route grant* reviewed in Phase 8.
- **Narrow same-branch corrections:** `d025cf286818d4857e2baac91f747f1b41ce0ce9` updates `client/src/components/financial/VoucherCostCenters.tsx` and `95f68a4d81d00436dfb0f25ba9ff3d8e4030c7d9` updates `client/src/pages/factory/daybook/FactoryDaybookCostCenters.tsx`. Both resulting file blobs exactly match `main` at this review (`9da115c8` and `c7b3c1a4`). The change only narrows inline UI read/edit visibility to Developer; it does not modify cost-center records, APIs, routes, backend authorization, accounting postings, or historical entries.
- **Review state:** PR #2527 still had no new Claude review or acceptance submission; its old Codex Contacts thread remains unresolved in the GitHub interface despite the earlier source correction. Before the fixes, the branch was 97 ahead / 110 behind `main` (previous watch: 109 behind). Existing CI and UI Quality workflow failures remain, while previously recorded security workflows passed. New tests were added on `main` for the restriction but were **not** executed or copied here; Claude must independently verify the policy, backend authorization and complete role/workflow regression.
- **Restrictions observed:** source inspection only; no CI, lint, build, typecheck, automated tests, merge, rebase, deployment or production data modifications by this watch.


### Post-handoff source-only parity watch — 2026-10-29, 14:15 Asia/Beirut

- **New Factory voucher navigation policy on `main`:** commit `08dc06276835eefd825e6bc7368b3c361d991bea` unconditionally hides the Factory voucher editor tabs `transfer`, `transferorder`, `adjustment` and `creditnote`, regardless of per-user `hiddenCostFields`. Before this watch, this cleanup branch only honored `hiddenCostFields`, so users without those hide flags could still see the four Factory tabs. The main change is limited to Factory voucher navigation/forms; payment, receipt and journal tabs remain independently permission-filtered, and ERP/Retail modes are unchanged.
- **Narrow same-branch parity correction:** `a1e1b5dd13c6accc9652384cfe1a96ab23a27fa9` adds the exact `main` helper `client/src/pages/vouchers/factoryVoucherPolicy.ts`; `fef3350a28a4ec006b684df84ca57eac378a0eb8` uses it for Factory voucher tab filtering in `client/src/pages/Vouchers.tsx`. The existing navigation/tab-state guards use the resulting visible tabs, including query-selected tabs. Existing ERP Optional Vouchers access logic, Retail restrictions, all URLs, voucher backend operations, accounting and historical data were left intact. **Source-only:** no test execution or runtime/API authorization certification.
- **Second new `main` commit requiring coordinated integration:** `bdf066238a9cf410cb6721c0c01e9d1dda3025ca` adds `/factory/invoicing/proformas/:id/edit`, Invoicing return-state navigation, and supporting editor links. The cleanup branch lacks that route/helper/UI integration. This was **not** backported independently; the full proforma workflow must be reconciled by Claude to avoid breaking customer context, save/cancel behavior or permissions.
- **Review and validation status at inspection:** before these parity commits, the branch was 100 ahead / 115 behind `main` (113 behind at the previous watch). PR #2527 remained open. No new Claude review/acceptance appeared; the older Codex Contacts thread remained outdated but unresolved in the GitHub UI. Latest existing checks on `b2558cb3` included failed CI and UI Quality, with passing security-related workflows. The two new source commits were not independently validated. Claude must still integrate newer `main` and independently run CI/build/typechecks/tests and full role/API/workflow regression review.
- **Restrictions observed:** no CI, lint, build, typecheck, automated tests, merge, rebase, deploy or production-data changes initiated by this watch.


### Post-handoff source-only parity watch — 2026-10-29, 15:09 Asia/Beirut

- **New ERP View Only access-parity change:** `main` commit `5d0aeb4dcb7814ecd053c8e72a50fa869c6954af` (PR #2592) changes `effectiveErpPageKeys` so View Only always inherits standard ERP read pages regardless of stale saved per-user allow-lists. Dashboard, Settings and write-only Create Voucher remain excluded; the existing View Only write-block policy remains in place. The cleanup branch still restricted View Only to any nonempty stale list, making its page access diverge from `main`. This was verified by reading both versions of the server policy and the six changed files; every feature-branch file matched the `main` predecessor before the new commit.
- **Narrow same-branch parity correction:** copied the exact six files from current `main` to the existing feature branch, with each resulting blob verified identical to `main`: `server/services/security/erpViewerPagePolicy.ts` (`c25f18fd`), `server/middleware/costCenterErpPageAccess.ts` (`9f71722d`), `client/src/pages/settings/users/AdvancedRestrictions.tsx` (`75af47a9`), `client/src/pages/settings/users/InlineRoleEditor.tsx` (`7a67a3cc`), `client/src/pages/settings/users/UserManagementForm.tsx` (`a989c88b`), and `tests/erp-view-only-page-policy.test.ts` (`3a3ff1bb`). The test source was updated but **not run**. No other files, routes, financial operations, Factory page grants or historical data were modified.
- **Review state and remaining blockers:** prior to the correction, the branch was 103 ahead / 116 behind `main`; PR #2527 remained open, unmerged and not mergeable, with no new Claude acceptance submission. Its previous Codex Contacts thread remained unresolved in the review interface, although the earlier source fix is present. Previous CI/UI Quality failures and incomplete role/API/security acceptance remain outstanding. New Factory Invoicing/Stock Allocation proforma routes and other newer `main` changes still require coordinated integration.
- **Restrictions observed:** no CI, lint, builds, typechecks, automated tests, merge, rebase, deployment or production-data changes were initiated. Source parity is **not** independent validation or production approval.


### Post-handoff source-only parity watch — 2026-10-30, 14:15 Asia/Beirut

- **New View Only pressing-access mismatch:** `main` commit `303915f572f88e1f5bda40f4f09844f469df239d` prevents View Only and ERP Tester from activating pressing scans while allowing read-only pressing results. The cleanup branch still mounted `ContinuousPressingScanner` and its offline sync queue whenever `/api/factory/pressing-machines/me` returned an operator, even for read-only roles with a pre-existing assignment. This is a concrete source/UI access-parity gap. The old pressing subsystem on this branch differs substantially from current `main`, so copying the entire newer pressing implementation would overwrite unrelated production workflows.
- **Narrow same-branch protection:** `e962f0d17d307795358b7050bb738152125775c2` adds server-derived `canScan` to the existing pressing `/me` response, false for View Only, ERP Tester and `posViewOnly` accounts. `c55141701e861e6ae36e35b7a6b2528146e5fca8` gates the scanner and offline-queue UI by that permission and current company, retains the existing read-only reports, and labels the restricted view. `4fe265d71b9dbb298bedf16c782bf0706e6388fb` also requires `canScan === true` when the offline queue revalidates the session before attempting delivery, preventing queued writes from being replayed by a downgraded read-only role. No inventory, pressing confirmations, history, accounting, role grants or route URLs were changed.
- **Scope limitation:** The branch still has the older assigned-machine/shift-based pressing implementation. The newer `main` pressing redesign, View Only company-wide reporting policy, and other `main` commits must be integrated together and independently validated; this focused UI/queue fix is **not** equivalent to that full integration. Existing server write boundaries remain authoritative. The new main bonus-payroll, individual target and scanning changes likewise require preservation during coordinated integration.
- **Review status:** PR #2527 remains open and not mergeable. No new Claude acceptance review or current-head workflow/status results were returned. The prior Codex Contacts thread remains unresolved in the GitHub interface although its source fix was committed. Existing CI/UI Quality failures and independent security/role regression approval remain outstanding. This watch did not run CI, lint, builds, typechecks, automated tests, merge, rebase, deploy or touch production data.
