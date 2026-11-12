# ERP Core UI — Phases 1–7

Use `@/erp-core` for new ERP-mode page presentation. This folder is a **composition/adoption layer**, not a new visual framework.

## Existing authoritative primitives

- `ErpPage` composes the existing `PageShell` and `PageHeader`. Keep `layout="padded"` for old stock/report pages, `layout="workspace"` for new workspace screens, and `layout="core-erp"` where the ERP phone layout needs it.
- `ErpSection`, `ErpToolbar`, `ErpPageActions`, `ErpDataTableToolbar` and `ErpSearchField` all reuse the existing shared components. Do not copy their markup into a new ERP implementation.
- `ErpLoadingState`, `ErpEmptyState`, `ErpErrorState` and `ErpSuccessState` reuse `page-state.tsx`. Existing specialized stock/report empty states are retained until their dedicated migration.
- `ErpStatCard`, `ErpCard` and `ErpBadge` are aliases, not new KPI/status implementations.

## Theme and boundaries

The ERP-only blue theme stays in `client/src/styles/erp-unified-theme.css`, imported by `ErpShell` and scoped to `html[data-app-shell="erp"]`. Use semantic Tailwind classes (`bg-background`, `bg-card`, `text-foreground`, `text-primary`, `border-border`) in new ERP markup, not inline hex colors. Do **not** import ERP theme tokens into Factory/Properties or remap success, warning, debit/credit, or chart colors.

## Adoption example

```tsx
import { ErpPage, ErpPageActions, ErpDataTableToolbar, ErpEmptyState } from "@/erp-core";

<ErpPage
  title="Inventory"
  subtitle="Current company inventory"
  headerActions={<ErpPageActions>{/* Existing actions */}</ErpPageActions>}
>
  <ErpDataTableToolbar search={search} onSearchChange={setSearch} />
  {!rows.length ? <ErpEmptyState title="No inventory" /> : <ExistingInventoryRows rows={rows} />}
</ErpPage>;
```


## Phase 2: canonical tables, filters and pagination

- `ErpListTable` wraps the existing responsive `Table` implementation, including sticky headings, horizontal overflow, and optional mobile card presentation. It defaults to **compact** density, persisting user choices through the existing `useTablePrefs` hook. Use a unique `pageKey`, and pass `companyId` whenever available. For nested previews, set `showDensityControl={false}` to avoid duplicate selectors.
- `ErpListFilters` reuses the existing `DataTableToolbar` and `ErpMobileFilters` so there is one controlled search/filter experience across desktops and phones. Pages still own their own filter values, query semantics, business sorting and available actions.
- `ErpListPagination` is a presentation-only bounded pager. Stock Query now requests server pages of 100 instead of silently truncating the first 200 items. Search changes and company changes reset its page, and shrinking results recover a valid page.
- Standardized list surfaces: Stock Query, Stock Items, Optional Vouchers, Customers, Suppliers, Stock Transfers, Accounts, condensed and detailed Daybook, Stock & Sales Report, Market Price Analysis, PO Import preview, Supplier Profit Check, Ledger Vouchers and Stock Item History. Existing responsive cards and interactive row actions were retained.
- Specialized **Location Inventory**, stock entry history and voucher forms use bespoke scanning, editable and/or synchronized layouts; preserve their dedicated table/mobile logic until a dedicated regression-tested migration. Do not force these through generic list tables.

**Verification**: unit tests cover ERP page composition, table density persistence, filter delegation, and pagination bounds. Run the frontend Vitest suite and TypeScript checks before merging; the migration itself does not change ledger/voucher arithmetic or stock posting.


## Phase 3: common fields, validation, and actions

- `ErpField` provides consistent labels, required indicators, description text, inline errors, and accessible `id` / `aria-describedby` / `aria-invalid` wiring for forms with caller-owned state. Use its render function for an existing `Input`, `Textarea`, `SelectTrigger`, or `ErpNativeSelect`; never duplicate model validation in this component.
- React Hook Form screens **keep their form resolver and field state**. Import `Form`, `FormField`, `FormControl`, `FormLabel`, `FormMessage` and `FormDescription` directly from `@/components/ui/form`. Phase 7 removed their eager barrel re-exports to avoid loading React Hook Form on unrelated ERP pages and breaking isolated hook mocks. Use `ErpFormActions` and `ErpPendingButton` for the shared footer and save behavior.
- `ErpFormActions` has `inline`, `dialog`, and `sticky` variants; `dialog` delegates to the existing responsive `DialogFooter`, retaining phone-sheet behavior, and `sticky` delegates to `FormActionBar`.
- `ErpPendingButton` delegates to `Button.isLoading` for consistent pending text, spinner, disabled state and `aria-busy`. It defaults to `type="button"`; set `type="submit"` inside a real form.
- `ErpRecordAction` is a non-submitting row action with optional caller-provided `permitted` and `deniedReason`. It never replaces backend authorization. Do not infer permission from role strings inside the UI component.
- `ErpConfirmDialog` is the existing robust `ConfirmDialog`, which handles pending operations, failure feedback and destructive confirmations. When possible, supply a promise-returning mutation (e.g. `mutateAsync`) to avoid closing before failure can be surfaced.
- The first migrations cover Customers' React Hook Form actions, Account Groups (display and legacy editors), Stock Transfers notes, Supplier Profit Review filters, Suppliers delete/edit, Stock Items edit, and Optional Vouchers view/edit/finalize/delete buttons. No endpoints, voucher posting logic, stock allocation arithmetic, financial formulas or permissions sources were changed.

**Safety rule:** staged display-only account grouping is still saved through its original mutation; deleting a display group must not delete any ledger account or voucher. Preserve existing test IDs and domain callbacks.


## Phase 4: unified ERP navigation and access decisions

- `shared/erpNavigationPolicy.ts` is the authoritative **frontend role-visibility policy** for ERP navigation and route restrictions. It combines the existing role constraints with `shared/erpRouteAccess.ts` feature mapping. The server remains the final authorization boundary.
- `client/src/app/erpPageRegistry.ts` owns the ERP pinned/section/utility navigation metadata, plus phone bottom-nav destination membership. The sidebar re-exports its public constants for older consumers; the command palette and phone More sheet already consume the sidebar's filtered list.
- `client/src/app/erpAccessQuery.ts` supplies the company-scoped `/api/my-erp-pages` query options for **ErpAccessBoundary**, **ErpRoutes**, and **AppSidebar**, so selecting another company does not mix page grants. Phase 9 removes the legacy unscoped cache mirror after migrating ERP and shared Factory readers to these company-scoped options. Never reintroduce URL-only keys for ERP grants.
- `ErpRoutes` uses the shared role policy for restricted `R(...)` route entries and preserves explicit feature-key guards for `G(...)` routes and composite hubs. Role restrictions are checked even if the ERP page API says `fullAccess`.
- `useErpCan`, `useErpRecordChangeAccess`, and `erpCanDenialMessage` in the ERP barrel are aliases of the existing permission hooks. For mutation buttons, use those existing permission decisions with `ErpRecordAction`; no new authorization algorithm or role inferred from hard-coded UI strings.
- Roles and special cases covered in tests: Developer-only accounting/tools, Admin-only maintenance, Owner-eligible review pages, POS menu limitations, View Only/Create Only dashboard suppression, ERP Tester settings/daybook exceptions, retail-hidden entries, composite inventory feature grants, company switching, and desktop/phone registry consistency.

**Scope:** This phase changes frontend navigation and guards. It does not widen backend permissions, add permissions migrations, or change Factory/Properties routing. Run the full TypeScript, UI and route-permissions regression suites before merging, and reconcile the branch with the current `main` first.


## Phase 5: company-scoped data and presentation formatting

**Do not introduce new request or money business logic.** The ERP barrel exports thin adapters over the existing, shared foundations:

- `erpRequestUrl` reuses `canonicalApiUrl`, with stable sorted filter keys and no empty query parameters. `erpCompanyDataKey` and `erpDataKeys` reuse the system's URL-first, company-second cache factories. A query's first key must be the **actual GET URL** when it uses the default queryFn.
- `invalidateErpDataFamilies` uses the existing `invalidateApiFamily` matcher, so writes invalidate both older URL-only query keys and newer `?filters` + company-scoped keys. This invalidates read models; it **does not** change records or copy other-company cache entries.
- `useErpServerPagination` owns the requested page and resets on company or filter changes. It never slices a server response; pages send `page` and `pageSize` to the backend. `ErpListPagination` delegates to the existing shared `PaginationBar` when total and page-size metadata are available.
- `useErpDateFormat` aliases the existing `DateFormatContext`: dates obey the user's saved DD/MM/YYYY versus MM/DD/YYYY preference. API date filters remain ISO strings; never format those for display before sending.
- `formatErpNumber`, `ErpMoneyAmount`, `formatErpMoneyDisplay` and `formatErpMoneyNumber` reuse established formatting. Explicit-currency money presentation does not perform FX conversion. `formatErpFixedQuantity` preserves the **exact two-decimal** display already used in opening/closing stock reports.
- The first migrations cover Stock Query, Optional Vouchers, Stock Transfers, Customers (including their per-customer statement cache), Suppliers (including their unified ledger and purchase orders), Opening/Closing Stock Summary, Market Price Analysis, and Stock & Sales Report.

**Migration rules:** Company identities are part of every company-owned query key; use `enabled` when the selected company is unavailable. Never cache a customer statement under a fake URL key such as `["/api/customers", customerId, "transactions"]`. Keep financial calculations, historical base amounts, account-side colors, currency precision and mutations untouched. Company switches must not show another company's cached statement.

**Tests:** `erpData.test.ts` covers URL normalization, company isolation, legacy/filter invalidation and display precision; `useErpServerPagination.test.tsx` covers company/filter reset and page bounds. CI type-check, build and frontend test suites still need to pass before merging the combined branch.


## Phase 6: unified report and export presentation

The report controls share one contract without centralizing any financial calculations.

- `ErpReportExportMenu` renders consistent responsive Excel, CSV and Print / Save PDF actions. Each page still owns its filters, permissions, report queries, error handling, and export callbacks. Existing action test IDs can be forwarded through option `testId`.
- `exportErpReportRowsExcel` writes the same JSON-to-sheet representation as the existing `excelHelper` functions, with **lazy-loaded ExcelJS** so opening an ERP page does not load workbook code. It is for simple flat statements, not custom multi-sheet reports.
- `buildErpReportCsv` and `exportErpReportCsv` centralize CSV encoding, UTF-8 BOM, quoting and spreadsheet-formula protection. A headerless mode preserves the Financial Statements report's metadata/title rows; signed numeric text stays numeric.
- `erpReportFileName` sanitizes OS-invalid filename characters while preserving existing report name and date separators.
- `ErpReportPrintFooter` identifies the report, active company, selected date period and generated time using the user's date-format preference. Browsers' **Print / Save PDF** flow is kept; this component does not claim to generate a PDF directly.
- Initial migrations: **Daybook** summary/detailed Excel, **Suppliers** ledger Excel, **Stock & Sales** Excel/CSV/print, **Stock Flow Detail** Excel/print, **Sales Report** Excel/print, **Professional Financial Statements** CSV/print, and **Item Market Analysis** pending-state export button.
- **Intentionally not rewritten:** complex Item Market workbook, Stock Flow Detail multi-sheet workbook, legacy Sales Report workbook styling, or the Net Profit server-produced Excel. Their accounting logic, calculations and output columns remain the same. Specialized Factory/Properties reports stay separate.

**Export correctness:** Export the page's full authorized filtered dataset, never the visible 100/250-row UI slice unless that is the intended report scope. Do not round underlying balances, revalue historical FX amounts, create vouchers, or alter any supplier/customer account entries. Users can still select print-to-PDF in the browser, and the provisional financial statements disclaimer must remain prominent.

Tests cover filename compatibility, multiline/quoted CSV, formula-safe labels, preserved negative numeric amounts, headerless financial CSV, export menu disabled/busy behavior and print footer identity.


## Phase 7: deduplication and regression stabilization

- Consolidated repeated `@/erp-core` imports in Customers, Suppliers, Stock & Sales and Market Analysis; preserved all other existing imports and page-specific behavior.
- Removed the redundant eager React Hook Form export surface from `@/erp-core`. The canonical `@/components/ui/form` remains the single implementation; callers choose it directly. This prevents Daybook's isolated Vitest hook mocks from failing just by importing the generic ERP barrel.
- Removed eager `erpData` exports from the generic UI barrel as well: report/menu pages must not load all company data/cache helpers or require their mocked APIs during isolated tests. Pages importing query helpers now use `@/erp-core/erpData` directly; their actual URL-first/company-second keys and invalidation behavior are unchanged.
- Kept **company-scoped** access grants and supplier ledger query identities. Updated test fixtures to use the actual selected-company key rather than weakening production isolation. Isolated route tests supply a company context.
- Hardened `ErpReportPrintFooter` for older embedded report tests that mock date-only preferences; the real date-format context retains full date/time formatting.
- Removed the CSV filename sanitizer's ESLint control-regex warning while still replacing unsafe characters.
- Added `erpUnificationContract.test.ts` to guard against reintroducing the eager form export, duplicated ERP imports, unscoped route grants, Stock Query's former 200-row cap, and loss of supplier/report export safeguards.

### Validation and non-ERP blockers

The baseline CI run on this branch had **344 frontend test files passing and 7 failing** (3,256 individual tests passing, 11 failing), including ERP-provider regressions corrected above. Build succeeded. The failing TypeScript, lint, repository-audit, security and UI-quality jobs also reported changes in separately developed Factory/Properties code, such as Factory Dispatch report typing, rental reconciliation nullability, documentation/script inventory and a POS Jnah voucher company-scope security finding. Do **not** "fix" these by relaxing permissions, bypassing the tests, or mutating accounting records.

**Merge gate:** run CI on the final Phase 7 SHA. All new ERP UI tests and targeted route/report regressions must pass, then reconcile this long-running branch with current `main` (which has substantially advanced), resolve conflicts, and run the suite again. A Phase 7 code commit is *not* a claim that the combined PR is ready to merge; leave it as draft until verified.

## Phase 9: company-scoped access on every permission reader

- All screens consuming `/api/my-erp-pages` now use `erpPageAccessQueryOptions(selectedCompany?.id, true)`, with Vouchers retaining its existing ERP-mode / non-POS enable condition.
- Shared Factory/Properties surfaces keep their cost visibility and role decisions. Factory Daybook now scopes its cost-visibility query to the active company.
- Removed the old unscoped query-cache mirror in `ErpAccessBoundary`. The boundary continues to wait for the current company's permissions before rendering the shell.
- Tests protect every former legacy reader and verify company-specific page grants and hidden cost fields remain in independent query cache entries. Backend authorization and accounting workflows are unchanged.

## Rollout rules

1. Phase 1 sets the stable API and migrates Opening/Closing Stock Summary as non-accounting pilot pages, retaining their existing shell spacing and header semantics.
2. Phase 2 introduces the standard list table, shared filter toolbar, and pagination controls. Phase 3 standardizes controlled fields, async form actions, row buttons and confirmations; Phase 4 centralizes ERP route/navigation roles and company-scoped page grants; Phase 5 standardizes queries, server paging and number/date display; Phase 6 unifies reports/export controls; Phase 7 removes proven duplicates and adds cross-phase regressions.
3. Never move voucher posting, ledger calculations, stock valuation, payroll arithmetic, or company authorization into UI components. Server authorization remains definitive.
4. Do not change data-testid, route URLs, stock balance calculations, or create/edit behavior as part of a presentational migration. Stock Query's former 200-result cap is separately replaced by explicit company-aware server pagination.
