# Properties Mode — Unification Execution Tracker (Phases 7–11)

**Working branch:** `properties-unification-phases-7-11` (created from `main` on 2026-11-09)  
**Scope:** Follow-up to `PROPERTIES_UNIFICATION_AUDIT_2026-11-09.md`. Keep all financial history and accounting boundaries unchanged.  
**Merge policy:** No merge into `main` as part of individual phases. No CI requirement added.

| Phase | Status | Notes |
| --- | --- | --- |
| 7 — Authorization and company scope | Implemented; automated execution not verified | Canonical company-context permissions for posted payment deletion, scheduled cancellation, and rental reconciliation. Focused tests added. |
| 8 — Financial presentation | Implemented; automated execution not verified | USD-only overview/export safeguards, typed reporting basis, explicit current-vs-historical reconciliation labels, company-calendar date filtering, historical policy preservation, focused tests. |
| 9 — Payment and rental UI cleanup | Implemented; automated execution not verified | Removed unreachable reconciliation selector and Factory/ERP dead JSX, shared deletion dialog, module-specific retirement explanations, timezone-neutral date labels and row editability policy; focused tests added. |
| 10 — Legacy and navigation | Implemented; automated execution not verified | Preserved operational compatibility dashboard; centralized rental bookmark redirects, deep-link matcher, route-keyed sidebar icons and navigation regression tests. |
| 11 — Regression verification | Not started | End-to-end tenant isolation, financial parity and navigation validation. |

## Phase 7 change register

1. `server/routes/rental/rentalRoutePermissions.ts`: New authorization middleware calls `getActiveCompanyPermissionContext` so permissions are derived from the current active-company assignment, not a stale session role. Administrative reconciliation remains Admin/Developer only. Deletion is allowed for Admin/Developer/Owner or eligible users with the active company's `canDeleteRecords` permission; POS, ERP Tester, View Only and Create Only cannot delete rental records.
2. `server/routes/rental/centralRentalPaymentDeletionRoute.ts`: Both company/module-scoped payment lookups and canonical deletion permission now apply before the payment service is invoked.
3. `server/routes/rental/rentalPaymentsAccrualRoutes.ts`: Scheduled payment group cancellation uses the same active-company deletion guard; existing company/module/status predicates remain.
4. `server/routes/rentalRouteFactory.ts`: Reconciliation uses the canonical selected-company role guard. Removed the separate `session.role` legacy fallback; valid authenticated sessions already require `currentRole`.
5. `tests/properties-unification-phase7-permissions.test.ts`: Matrix tests for roles and per-company delete flags, stale-session denial, unauthorized reconciliation, missing company assignment, unexpected errors and route registration checks.

## Phase 7 invariants

- No schema, migration, ledger, voucher, transfer, cashbox, receipt-allocation or historical snapshot logic changed.
- The global tenant isolation boundary still owns company membership and database scope. Both payment deletion services retain company and rental-module predicates.
- Guards affect write/read authorization only; accounting posting semantics for ERP, Factory and Properties were not unified.
- The guards follow the canonical active-company permission context and are intended to deny access after an assignment is revoked without waiting for session refresh.

## Verification record

- **Completed:** Static examination of the affected route registrations and canonical permission context; GitHub branch commits and fetch-back of updated source.
- **Not run:** Vitest, TypeScript compilation, production database checks, authenticated browser flows, CI, or runtime API calls. This workspace does not provide a checked-out executable application, so the new tests are committed for execution in the repository environment.
- **Before production use:** Run `npx vitest run tests/properties-unification-phase7-permissions.test.ts tests/phase33e-auth-role-guards.test.ts`, TypeScript check, and an authenticated two-company API permission matrix. Do not interpret the static verification as a passing test suite.

## Phase 7 implementation conclusion

Implementation and targeted regression coverage are committed on the working branch. Runtime verification remains outstanding and must be marked honestly until executed. Phase 8 can proceed on the same branch without touching production accounting data.

## Phase 8 change register (2026-11-09)

1. `client/src/properties/config/rentalReportingPresentation.ts`: Added a pure USD-basis predicate, an explicit reporting-figure model (amount, currency, calculation basis, optional as-of date), and business-calendar date helpers. The period start uses the existing `getAppDate()` company-timezone convention; recorded payment day strings are compared lexically after strict YYYY-MM-DD validation, avoiding browser-local midnight reinterpretation.
2. `client/src/properties/hooks/useRentalPaymentsFilters.ts`: Uses the shared company-calendar date helpers for This Month, This Year, and Last 30 Days. No recorded payment date or server posting date is rewritten.
3. `client/src/pages/properties/RentalPaymentsLog.tsx`: Refuses an unconverted single USD amount when selected payments include non-USD currency; clearly labels the account-balance reconciliation and posted cash basis; restricts full-history copying to USD-compatible data and preserves per-record money display.
4. `client/src/pages/properties/PropertyRentalPage.tsx`: Refuses contract-based aggregate USD displays when any included external lease contract is non-USD; historical account-balance summaries remain separated from contract-paid values. The historical rental withdrawal is through 26 Oct 2026, but deposits and cash balances are current, so the composite figure is intentionally **not** assigned a misleading single as-of date.
5. `client/src/pages/properties/property-rental/paymentsReceiptMath.ts`: Adds a final defense to the USD-labeled TSV export functions. Direct calls reject non-USD rows instead of producing incorrectly labeled numeric columns. No voucher, amount or posting math changes.
6. `tests/properties-unification-phase8-presentation.test.ts`: Covers USD-only aggregation, legacy missing-currency defaults, export protection, calculation basis, month/year/30-day business-calendar boundaries, recorded-day parsing, historical voucher/cutoff criteria, and stable company identity.

### Historical reporting policy decision

The Phase 3 stable-ID assignment (company id 13, code HP, company type properties) remains intentionally unchanged. It is a **read-only exception** representing the verified production Hassan Properties identity, not an authorization system or a reusable rule for every Properties company. Making this assignment arbitrary or automatically code-only could apply this historical exception to the wrong company. Multi-environment portability requires an explicitly reviewed deployment/company policy change rather than silently widening the historical snapshot gate.

### Phase 8 financial boundaries

- The 26 Oct 2026 snapshot cutoff and voucher-backed selection logic are unchanged.
- Historical rental withdrawal and current cash/deposit account balances are not mislabeled as unique cash receipts or as an all-historical as-of snapshot.
- No FX rate is generated or assumed; non-USD amounts remain in their recorded currencies.
- No database schema, accounting service, posting, scheduled accrual, voucher, cashbox, or transfer logic changed.

### Phase 8 verification

- **Completed:** GitHub writes and fetch-back source inspection; focused test file committed.
- **Not executed:** Vitest, TypeScript, real browser or API reconciliation, actual mixed-currency financial account verification, CI and deployment.
- **To verify in a runnable checkout:** `npx vitest run tests/properties-unification-phase8-presentation.test.ts tests/properties-payment-history-reconciliation.test.ts` and the project TypeScript checker; check a company configured in a different timezone with payments at month-end, and an isolated test company with USD and non-USD contracts.
- **Status interpretation:** Phase 8 implementation is committed, with runtime verification pending. No production posting or historical financial data was changed.

## Phase 9 change register (2026-11-09)

1. `client/src/pages/properties/property-rental/components/RentalPaymentDeleteDialog.tsx`: All rental modules now reuse one confirmation component. It retains the established test ID and confirmation workflow, including the recorded payment amount, tenant and rental period. The message describes voucher/accounting retirement and distinguishes Properties' no-auto-transfer policy from ERP/Factory's potential linked transfers. The server still determines the actual effects of deletion.
2. `client/src/properties/config/rentalPaymentPresentation.ts`: Added pure, testable presentation helpers for recorded payment calendar-date labels (no browser timezone reinterpretation), origin/read-only editability checks and module-specific deletion impact. The cross-module Properties payment rows remain read-only in the Properties UI.
3. `client/src/pages/properties/RentalPaymentsLog.tsx`: Reused the new deletion component in both rendered page layouts, removed the reconciliation-type controls and accounting displays unreachable after the Properties early return, and retained the Properties premium UI, existing search, payment query, cash/non-cash classification and account-balance reconciliation. Factory/ERP still use their standard table.
4. `client/src/pages/properties/property-rental/components/PropertiesPaymentsPremium.tsx`: Reuses the same recorded-date and origin/read-only policy. The premium table structure, input filters, copy behavior and row-action IDs are unchanged.
5. `client/src/properties/hooks/useRentalPaymentsFilters.ts` and `client/src/properties/config/rentalModulePolicy.ts`: Removed dead reconciliation-view state and unused `paymentsAllRecordsOnly` configuration. Properties continues to show all records; Factory and ERP continue to use the unfiltered-by-reconciliation payments list. Search, tenant, unit and period filtering remain.
6. `tests/properties-unification-phase9-ui.test.ts`: Adds test coverage for module-specific deletion copy, origin/read-only editability, calendar date display, preserved API bases, receipt math, shared component wiring and dead-view removal.

### Phase 9 invariants

- No rental API endpoint or server route changed.
- No ledger, receipt, guarantee, scheduled payment, historical snapshot, transfer or voucher calculations were modified.
- No visible reconciliation-type selector existed in the active Properties premium path; removing the unreachable selector does not eliminate a supported active Properties feature.
- Payment copy, search, Properties premium visual components and the existing Factory/ERP table remain separate where their presentation requirements differ.
- UI read-only flags remain informational only; server-enforced company-scoped authorization from Phase 7 is authoritative.

### Phase 9 verification

- **Completed:** GitHub branch commits, read-back of edited files, and static checks on removed unreachable view references; new targeted tests committed.
- **Not executed:** Vitest, TypeScript checker, a running browser, production queries or CI. Phase 11 must execute comprehensive parity checks in a runnable checkout before merge/deployment.
- **Recommended runnable checks:** `npx vitest run tests/properties-unification-phase9-ui.test.ts tests/properties-unification-phase8-presentation.test.ts tests/properties-payment-history-reconciliation.test.ts`, plus project typecheck, and manual smoke checks for Properties/Factory/ERP payment views and deletion confirmations.
- **Status:** Phase 9 code-level implementation complete with runtime verification pending; Phase 10 remains next on this same branch.

## Phase 10 change register (2026-11-09)

1. `client/src/properties/config/propertiesNavigation.ts`: Added `findPropertiesNavigationEntry` with exact and full-segment dynamic URL matching, including selected rental tab query links. `canNavigateProperties` now handles actual voucher and ledger URLs instead of requiring literal route-pattern strings. This changes client-side discovery/navigation checks only, never server authorization.
2. `client/src/app/PropertiesRoutes.tsx`: The three old rental aliases now register from the canonical redirect map with `<Redirect replace>`. The hidden legacy dashboard route is explicitly preserved because its cash/payable account CRUD functions still run through real APIs.
3. `client/src/components/PropertiesSidebar.tsx`: Six pinned route icons are mapped by path identity rather than manifest array index; labels, order, persisted drag sorting and capability policy remain unchanged.
4. `docs/properties-navigation-registry.md`: Updated legacy and current backend role-context notes, deep-link behavior and safe dashboard disposition.
5. `tests/properties-unification-phase10-navigation.test.ts`: Added source and policy regression checks for direct dashboard access, bookmark redirects, three hub tabs, dynamic route matching, unknown paths, selected-company permission gates, and pinned icon contract.

### Legacy dashboard decision

`/properties/dashboard` remains a hidden but operational compatibility screen. It is **not** a dead route: the component still performs dashboard cash/payable account management, including real server writes. Removing it or forcibly redirecting every bookmark to another dashboard would silently remove those operations. Phase 10 retains the page and narrows its discoverability; actual migration or deletion requires a separately approved feature mapping and usage review.

### Phase 10 invariants

- No historical payment or accounting view, rental posting path, cashbook, ledger, voucher or migration changed.
- `/properties/rental/warehouses`, `/properties/rental/shops` and `/properties/rental/payments` all continue to use replacement-history redirects to their canonical hub/tab.
- The six pinned workspace pages, existing administrative role gates and fallback `/properties/daybook` are unchanged.
- `/properties/dashboard` continues to work by direct URL and remains absent from pinned navigation.

### Phase 10 verification

- **Completed:** GitHub commits and source read-back, route-consumer and historical usage review, focused test authorship, navigation contract update.
- **Not executed:** Vitest, TypeScript check, browser bookmarks and Back/Forward, role-switch testing, dashboard account CRUD in an isolated test environment, CI or deployment.
- **Required before release:** Run `npx vitest run tests/properties-unification-phase10-navigation.test.ts tests/properties-unification-regression.test.ts` and project typecheck; manually verify legacy bookmarks, selected-company roles, account-management actions and unknown-route replacement behavior.
- **Status:** Code-level Phase 10 is complete on the existing branch; Phase 11 end-to-end regression verification remains pending.

### Branch-divergence notice after Phase 10

At the final Phase 10 comparison on 2026-11-09, GitHub reported `properties-unification-phases-7-11` **43 commits ahead and 149 commits behind `main`**. This is a snapshot, not a permanent branch state; `main` may continue moving. Do not assume the branch can be merged conflict-free. Phase 11/integration must review the full upstream diff and any conflicts, preserve the implemented financial safeguards and compatibility routes, and retest the reconciled result. No rebase, merge, cherry-pick, change to `main`, or CI action was performed as part of Phase 10.
