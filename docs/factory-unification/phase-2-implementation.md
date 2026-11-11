# Factory Unification — Phase 2 Implementation Record

**Date:** 2026-11-09  
**Branch:** `factory/unification-8-phases-2026-11-09`  
**Validation performed:** Connected GitHub source reads and post-write re-reads only. No CI, local test execution, database connection, browser, or runtime API checks.

## Implemented
1. Added `shared/factoryActionCapabilities.ts` as a typed, pure capability map for dispatch close, discrepancy approval, dispatch reopen, and bonus management. This preserves the preexisting role matrix, including Developer access to dispatch supervision but not bonus management.
2. Applied the same typed policy to client dispatch lifecycle buttons and to server dispatch close/reopen checks. Existing server-side company resolution, Factory tab authorization, transaction and audit logic are retained; this helper does not replace route authorization.
3. Applied the bonus capability map to the Production Targets management UI without changing payroll or bonus calculations.
4. Scoped Factory Containers and OTW Tracking query keys to the selected company while preserving URL-first base prefixes and the OTW suffix, allowing existing prefix invalidation and grouped cache updates.
5. Scoped inventory access, settings, inventory location, available-bales, product, category and customer read keys to company. Cost display is hidden until matching selected-company access is present, including the `hideAllCosts` flag.
6. Added `tests/factory-unification-phase2.test.ts` with role matrix and cache-key characterization cases (authored, not executed).

## Known constraints and remaining verification
- `CompanyContext.tsx` already cancels and removes company-session cache entries during switches. This was retained.
- This is **not yet an exhaustive pass over all Factory read keys**. Additional screens, including staff tracking and domain-specific financial pages, still use some unscoped URL keys and must be audited before the cache workstream is called complete.
- Selected-company `/api/factory/my-access` is reused instead of introducing a separate permission endpoint. No new backend permission payload has been added.
- The selected-company access object is only an input to client controls; server authorization remains authoritative and may reject requests regardless of UI visibility.
- No running repository checkout was available (the connected GitHub API was used; direct Git transport was unavailable). No unit tests, TypeScript checks, UI snapshots or server 403 tests have been run. Do not claim full regression parity.
- Do not merge into main automatically. No CI runs requested.

## Outstanding completion gates
- Audit remaining Factory reads and invalidations, ensuring selected-company correctness without breaking URL-first query functions.
- Confirm the action matrix against real scoped View Only, Create Only, Admin, Owner and Developer sessions.
- Execute the authored unit tests in a suitable checkout and verify cross-company A→B→A and cache cancellation under delayed HTTP responses (manual execution, not CI).
- Verify server 403/200 matrix and signed dispatch closure immutability with a safe nonproduction dataset.

**State: IN PROGRESS — Phase 2 source changes landed; full policy/cache regression remains unverified.**


## 2026-11-09 continuation — additional source fixes committed
The following targeted source changes were applied on the **same** unification branch, without modifying business mutations, SQL or permission enforcement:
- `FactoryProductionTargets.tsx`: production/staff tracking results have a selected-company URL-first key and only fetch for an active company. Bonus management UI requires current matching-company `hasFactoryAccess` as well as the existing Admin/Owner role capability.
- `FactoryAttendance.tsx`: attendance date rows and attendance WhatsApp settings have selected-company cache keys; the save invalidation targets the same company/date. Prior-day server Admin approval is unchanged.
- `FactoryLocationInventoryModel.tsx`: locations, selected-location inventory, available stock and catalogs require a selected-company scope; the existing availability and catalog calculations remain unchanged.
- `FactoryWorkersHub.tsx`, `FactoryInvoicing.tsx`, `FactoryLoadingsHub.tsx`, `FactoryDaybook.tsx`, `FactoryAdvancesTab.tsx`: nested hub tab visibility now fails closed when the access payload is pending, lacks Factory access or reports a company other than the selected one. Both access and settings reads are company scoped.
- `factoryworkers/useFactoryWorkersModel.tsx`: full worker list, cash accounts, document counts, nationalities, amount-due and worker categories reads have company-scoped cache keys. Workers and categories tabs are hidden until matching-company access is available.
- `FactoryWorkerBonusesTab.tsx`: worker picker, cash accounts and bonus record list read keys are company-scoped. Pending/paid totals still use the original backend response and are not recalculated differently.
- `tests/factory-unification-phase2-continuation.test.ts` records selected-company key invariants, bonus capability fail-closed policy, nested-hub access visibility and worker/bonus sensitive query paths. **Tests authored, not executed.**

## Source-only review observations and remaining risks
- Source post-write re-reads confirmed the scoped imports/keys and matching-company access predicates in the modified files.
- `CompanyContext` continues to cancel/remove old company-session queries. URL-first query keys preserve existing query invalidation conventions. The implementation **does not** claim that every Factory query key throughout the repository is now company scoped: the repository also has other production/worker dialogs, inventory/settings screens, Factory intelligence and domain-specific reads. Some still use unscoped URL keys; they require a repo-wide inventory before saying the exhaustive audit is complete.
- Even among modified screens, in-flight React local state, outstanding write requests and UI remount behavior were not exercised with A→B→A transitions. A scoped query key by itself does not prove every consumer cannot display local stale data.
- Client tab suppression is presentation policy, not access authorization. Existing route/backend checks remain authoritative. Owner/Admin/Developer/create-only/view-only 200/403 parity and dispatch-closure side effects remain **unverified**.
- No runnable checkout, TypeScript build, browser, tests, API runtime, live role accounts or database fixtures were available in this interaction. Do not infer test success.

**Continuation status:** Targeted high-risk source hardening complete. **Exhaustive repo-wide cache audit and runtime verification remain open**. Phase 2 should not be labelled fully DONE until those checks have evidence.

## 2026-11-09 expanded full Phase 2 source pass

A further set of targeted high-impact fixes is committed in the same branch:

**Access, navigation and authorization presentation**
- Made access/settings company-scoped and hidden tabs fail closed in Factory Bales Hub, Payroll Hub, Employees Hub, Supplier Hub, Parties Hub, Production Intelligence Hub, Import and KPI views.
- Made invoice list, pending invoices, dispatch batches, customer statement, Sheets & Sacks, stock entry and bale relabeling use selected-company access payloads rather than unscoped access keys.
- **Sheets & Sacks previously treated missing access data as permission to edit**. It now requires matching-company Factory access and a page grant/full-access claim before rendering edit controls; the server must still authorize writes.
- Corrected the empty-company comparison edge case: `undefined === undefined` followed by reading `myAccess.hasFactoryAccess` could throw. New checks explicitly require `myAccess?.hasFactoryAccess === true`; the same rule was applied to production bonus capability context and earlier hub screens.
- The stock-entry production-session query retains its original backend gate but also requires a selected company; sensitive tabs are hidden until matching-company access is resolved.

**Selected-company data and cache keys**
- Scoped invoice/customer order lists; pending-verification lists; dispatch batch and report views; customer statement and price list; KPI data; Sheets & Sacks stock; Factory dashboard and containers; bale relabel sessions; employee payroll list and preview; and stock-entry production-session.
- Scoped detail read models for invoice/order, proforma selection, dispatch batch, ledger account list, worker documents, advances, payroll and worker cash accounts.
- Read keys keep the real URL first so shared fetching remains compatible. For detail pages, changed mutation invalidations to URL-prefix invalidation to refresh new `[URL, companyId, ...]` keys and older URL-only consumers without altering mutation endpoints or their accounting effects.
- The worker payroll preview is now keyed by company; its local editable form resets on selected-company change.

**Source audit and tests**
- New `scripts/audit-factory-phase2.mjs` walks the full `client/src` tree, inventories literal unscoped Factory keys, selected-company keys, potential fail-open access expressions and unscoped location reads. Optional `--strict` returns nonzero if suspect patterns remain. **This scanner has not been run**, and it is heuristic: dynamic query keys, cross-company local state and backend endpoints require additional review.
- New `tests/factory-unification-phase2-final-audit.test.ts` pins hub/financial/stock read keys, no-company fail-closed checks and URL-prefix invalidations. Tests exist on GitHub; **not executed**.
- Source re-reads verified updated code presence in selected files; this does not establish TypeScript or runtime correctness.

### Unresolved gates — prevent an unqualified DONE claim
1. A repo-wide execution of the audit script, triage of every finding, and review of dynamic query keys and `useQueries` consumers have **not** occurred. Other Factory-related code under shared pages, hooks and dialogs may still have unscoped reads.
2. No runnable checkout was available for TypeScript, targeted Vitest, browser or API tests. Even source characterization tests have not been run.
3. View Only, Create Only, Admin, Owner, Developer 200/403/permission parity has not been tested against live nonproduction accounts. UI hidden tabs do not replace server authorization.
4. Company A→B→A transitions, delayed responses, offline state, ongoing edits, and cross-company pricing/cost checks are not runtime certified.
5. Financial, dispatch, stock and payroll mutations were deliberately not modified; behavior and data-parity claims require independent nonproduction tests.

**Honest current state:** Extensive additional Phase 2 source hardening committed; **Phase 2 is NOT fully verified or complete**. This is a stop/go release gate for the user-controlled future merge. No CI, production DB action or main merge.


## 2026-11-09 employee attendance / finance isolation continuation

Additional source-level changes landed on the same branch:

- `FactoryEmployeeAttendanceTab.tsx`: company-scoped daily attendance, per-employee history, employee picker and their mutation invalidations. No-company reads are disabled. The per-employee view remounts for selected-company transitions, and the daily view clears editable maps and approval state on company change. Server approval/attendance rules are untouched.
- `FactoryEmployeeAdvancesTab.tsx`, `FactoryEmployeeBonusesTab.tsx`, `FactoryEmployeeWithdrawalsTab.tsx`: company-scoped employee, cash account, advance/repayment and bonus cache keys, with company-aware query enabling and invalidations. Financial mutation functions and amounts were not changed.
- `FactoryEmployees.tsx` and `FactoryEmployeeDetail.tsx`: list, detail, statement and ledger-picker caches isolated by selected-company key; no-company reads disabled. Endpoint authorization remains server-owned.
- `tests/factory-unification-phase2-employee-scoping.test.ts` added as a **source characterization test only; not executed**.

**Validation actually performed:** GitHub post-write source fetches verified scoped query expressions and imports. Git transport and a runnable checkout were unavailable; TypeScript, Vitest, the repo-wide audit tool, browser, API and real-role checks **were not executed**. This is not an exhaustive audit. Other Factory and shared-domain modules still require review, and the A→B→A delayed-query/active-edit acceptance test remains open. **Phase 2 remains IN PROGRESS / NOT FULLY VERIFIED**. No CI or merge.


## 2026-11-10 — merged-main cache hardening continuation

After Factory Unification PR #3078 merged, additional targeted Phase 2 source repairs were committed **directly to `main`**:

- Company-aware reads and disabled no-company queries in Factory Alerts, Waste, Price List, Customer Logos, Contacts, Customers, Production Summary, and shared Bale Products.
- Stock Entry History now scopes access response to the selected company before permission decisions; its paginated history, worker picker, staff targets, group details, and imperative group cache lookup use selected-company keys.
- Bale-products financial display now fails closed when permission access is missing/mismatched, including explicit `hideAllCosts`; this is UI defense-in-depth and not server security.
- The V2 and V3 fallback stock-allocation screens now use selected-company cache keys and disabled no-company reads; they remain available for compatibility.
- Factory Settings uses company-scoped location/attendance/weekly-report/WhatsApp chat reads; existing setting mutation endpoints unchanged.
- Factory Invoice Create and Factory POS read caches for customer orders, customers, stock/location, proformas, ledger accounts and sales are company-scoped; POS clears unsaved local cart/account/location/edit state when company changes.
- Shared label-design palette reads use company-scoped keys. Waste and Customer Logos cache invalidations were adjusted to match the new keys, preserving URL-first semantics for legacy prefix invalidators.
- Source characterization test `tests/factory-unification-phase2-main-hardening.test.ts` was authored and expanded; **not run**.

**Validation performed:** GitHub source-file reads and successful authenticated write commits only. **Not performed:** local checkout, static analyzer execution, TypeScript, Vitest, browser, actual A→B→A transitions, delayed response race, live 200/403 matrix, or backend security test. Additional URL-only Factory keys still appear in GitHub source searches (e.g. Mix Batches, raw-stock dialogs, legacy/location modules). A runtime environment with company-role fixtures is necessary for certification. Prior work should not be represented as formally tested. The requirement to keep CI disabled was respected in this execution; no CI workflow was manually started.

**Phase 2 status: NOT FULLY DONE — repository-wide audit and runtime/security gates remain open.**
