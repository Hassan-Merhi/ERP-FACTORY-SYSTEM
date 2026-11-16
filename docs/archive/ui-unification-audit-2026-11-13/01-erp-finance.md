# 01 — ERP Accounting / Finance / Report pages — UI unification audit

Scope: `client/src/pages` root-level accounting/finance/report pages + their sub-folders + `client/src/components/financial/*`.
Method: route map from `routes/ErpRoutes.tsx` + `lazyPages.ts`; metrics CSV to prioritise; targeted reading/grep of each file. Line numbers are from the current working tree. Paths are relative to `client/src/`. Items I did not open line-by-line are marked "unverified".

Legend — PH = `@/components/PageHeader`; "bare h1" = hand-written `<div><h1 class="text-2xl font-semibold">` + `<p>`; EREM = `ErpReportExportMenu`; PF = `PeriodFilter`; nat-date = `<Input type="date">`; nat-select = native `<select>`; btn-tabs = `<Button variant={tab===k?"default":"outline"}>` used as tabs.

## Page inventory

| Page (file) | Route | Shell/Header | Tabs | Export/Print | Table | Filters | States | Notable issues |
|---|---|---|---|---|---|---|---|---|
| Accounts.tsx -> AccountsLegacy.tsx (+accounts/, accountslegacy/) | `/accounts` | PH "Accounts Overview" (:203); 11 link-buttons to `/accounting/*` built in page (:180-198) | shadcn Tabs view/find, local `useState` (:65) not URL-backed | none on list; statement: EREM-like menu w/ server Excel + 3-language PDF via `window.open` (accounts/AccountStatementView.tsx:262-289, 415-435) | `ErpListTable` (accounts/AccountTable.tsx) | ad-hoc search Input + raw clear `<button>` (:368-375); PF in statement | "Loading accounts…" text (:389) + `ErrorState` (:392) | 34 hard-coded colours; header label "Create" (:252) vs "New X" elsewhere; `toLocaleString` for counts (:272) |
| accounts/HistoricalOpenings.tsx | `/accounts/historical-openings` | PH | none | none | `Table` (HistoricalOpeningResolver) | none | "Loading" text | — |
| accounts/FxAgentEurStatement.tsx (statement panel) | inside `/accounts` | panel | none | 2 standalone buttons "EUR PDF" / "EUR Excel" via `window.open` (:242, :250) | `Table` | PF | — | export buttons not in EREM; delete uses raw `AlertDialog` (:472) |
| AccountGroups.tsx | `/account-groups` | PH twice, two different layouts (:249, :257) | none | none | card list, raw `<button>` rows (:291) | `SearchField` (:274) + ad-hoc Input (:528) | `Skeleton` | `ErpConfirmDialog` (:594); mixes shared/ad-hoc search in one file |
| AccountMigration.tsx | `/account-migration` | PH (:477) | none | none | none (cards) | Command combobox | `Skeleton` | local `fmt()` (:88); raw `<button>` x2 (:216, :237); 22 hard colours |
| AccountTransfer.tsx | `/account-transfer` | PH w/ icon (:256) | none | none | raw `<table>` (:371) | ad-hoc search (:111, :351) | "Loading entries…" text (:366) | hard-coded `$` + `toLocaleString("en-US")` (:499, :507); local `fmtMoney` (:41) |
| AccountingCreate.tsx (+accountingcreate/) | `/create` | PH "Create Master Data" (:59) | custom raw `<button>` side-nav (:112) | n/a | n/a | — | FormButtons ad-hoc loading | own `FormButtons`/`CreateFormShell` instead of `ErpFormActions` |
| AccountingToolbox.tsx | `/accounting/toolbox` | `<main class="container mx-auto max-w-6xl">` + bare h1 (:31-33) | none | n/a | link cards | none | none | only page in scope using `<main>`/container width |
| AccountingOpenItems.tsx | `/accounting/open-items` | bare h1 (:174) | none | none | raw `<table>` x2 (:256, :315) | nat-select (:183), nat-date (:212) | "Loading entries…" (:226); inline `<p text-destructive>` | no export; "Refresh" (:221) |
| CashBankReconciliation.tsx | `/accounting/cash-bank` | bare h1 (:260); primary action is a raw `<a class="rounded-md border">` (:265) | none | import only (CSV/XLSX) | raw `<table>` x2 (:479, :589) | nat-select x2 (:275, :541), nat-date x2 (:321, :332) | inline error `<p>` | local `fmt` (:101); no export of matches |
| MonetaryFxAccounting.tsx | `/accounting/monetary-fx` | bare h1 (:161) | none | none | raw `<table>` x3 | nat-select x2, nat-date | inline error `<p>` | "Refresh FX analysis" (:183) |
| ErpInventoryAccounting.tsx | `/accounting/erp-inventory` | bare h1 (:111) | none | none | raw `<table>` (:296) | nat-select x2 (:249, :273), nat-date (:182) | inline error `<p>` | "Refresh audit" (:195) |
| FactoryProductionAccounting.tsx | `/accounting/factory-production` | bare h1 (:141) | none | none | raw `<table>` x3 | nat-select x2, nat-date | "Loading Factory accounting…" (:166) | button text swaps to "Loading…" (:154) |
| UnifiedRentalAccounting.tsx | `/accounting/rentals` | bare h1 (:203) | none | none | raw `<table>` x2 | nat-select x2, nat-date | inline `<p>` | "Refresh rental accounts" (:246) |
| GroupConsolidationAccounting.tsx | `/accounting/consolidation` | bare h1 (:208) | btn-tabs (:350) | none | raw `<table>` x4 | nat-date x2 | "Loading transfer evidence…" (:475) | "Refresh financial workpaper" (:268) |
| HistoricalAccounting.tsx | `/accounting/history` | bare h1 (:201) | btn-tabs (:292) | none | raw `<table>` x3 | nat-date x2 | "Loading dated ledger evidence…" (:246) | "Refresh historical evidence" (:231) |
| ProfessionalFinancialStatements.tsx | `/accounting/statements` | bare h1 (:304) | btn-tabs (:397, unverified which) | EREM: "Export CSV" + "Print / Save PDF" (:328-339), `ErpReportPrintFooter` (:705); file `financial-statements-{companyId}-{date}.csv` (:210) | raw `<table>` x2 | nat-date x2 | "Loading financial statements…" (:359) | no Excel; local `number()` (:120) |
| FiscalCloseReview.tsx | `/accounting/fiscal-review` | bare h1 (:260) | btn-tabs (:391) | none | raw `<table>` x2 (:604, :648) | nat-select x2, nat-date x2 | inline `<p role=alert>` | "Refresh financial evidence" (:381) |
| UnifiedAccountingDashboard.tsx | `/accounting/dashboard` | bare h1 (:305) | btn-tabs (:377) | hand-rolled CSV Blob (:246-296), standalone button "Export overview CSV" (:326); file `unified-accounting-{id}-{date}.csv` | raw `<table>` x2 | nat-date x2 | "Reading posted financial records…" (:339) | same family as Statements but does not use EREM/`exportErpReportCsv`; local `money()` (:139) |
| UnifiedAccountingRollout.tsx | `/accounting/rollout` | bare h1 (:200) | btn-tabs (:238) | none | raw `<table>` (:318) | nat-select (:362) | "Loading current company trial balance…" (:254) | "Refresh release readiness" (:218) |
| CostCenters.tsx (+components/financial/CostCenter*.tsx) | `/cost-centers` | PH w/ `onBack` -> /accounts (:159-162) | none (4 stacked sections :382-385); CostCenterReports uses btn-tabs (unverified exact line ~:440) | CostCenterReports: 3 loose buttons "CSV" "XLSX" "PDF" server download (:460); file `cost-centers-{view}-{from}-{to}.{fmt}` (:232) | raw `<table>` x7 in Reports/Historical; raw `<button>` rows (:215, :324, :334) | ad-hoc search (:168), nat-date (:298, :310; Reports :273, :280; Historical :274, :286) | "Loading cost centers…" text (:201) | `window.confirm` (:152, CostCenterAutomationRules.tsx:297); "New Cost Center" (:182); local `fmt` x2 |
| Analytics.tsx -> AnalyticsLegacy.tsx (+analyticslegacy/) | `/analytics` | PH (:76) | custom raw `<button>` sidebar sections w/ `data-testid="tab-*"` (:59), local state | none in any section (grep: no export code in analyticslegacy/) | `Table` in 5 panels | PF (:78); nat-date in SalesSectionPanel; ad-hoc search in FactoryAllContainersReport | mixed "Loading" text / shared state | `Analytics.tsx` monkey-patches `window.fetch` (:44-97); report hub with zero export |
| BalanceRepair.tsx | `/balance-repair` | PH (:199) | none | none | `Table` x4 (:291…:463) | none | `Loader2` spinners (:225-239) | local `fmt` (:26); `Badge variant=destructive` for amounts |
| ConvergenceReconciliation.tsx | `/convergence-reconciliation` | PH w/ children (:72) | none | none | `Table mobileLayout="cards"` (:159) | none | ad-hoc loading | — |
| Dashboard.tsx (+dashboard/) | `/financial-overview` | PH (:61) | none | none | n/a (KPI cards; local `DashboardKPICard`) | ad-hoc search x2 in DashboardFinancePanel | `ErrorState` (:69) but KPI value string "Loading..." (:180, :193, :217) | own KPI card instead of `StatCard`/`KPICard` |
| Daybook.tsx (+daybook/) | `/daybook` | PH (:652) | shadcn Tabs "Transactions" / "Edits & Activity" (:692-699), local state | EREM "Summary"/"Detailed" (:662-674) -> `exportErpReportRowsExcel`, `erpReportFileName("Daybook","xlsx")` (daybook/exportDaybook.ts:32, :45) | `ErpListTable`, sticky header + sticky first col (daybook/DaybookTable.tsx:157) | PF + ad-hoc Input "Voucher # or description..." (DaybookFilters.tsx:80); "Reset Filters" (:266) | `Skeleton` + explicit empty/error | delete confirm is raw `AlertDialog` (:879); `PaginationBar` (:809); export labels lack format word; no print |
| TransactionJournal.tsx (+transactionjournal/) | `/transaction-journal` | hand-built gradient `<header>` w/ violet/fuchsia palette + h1 (:17-41) | chip raw `<button>` (JournalOverview.tsx:35) | none | `Table` | PF; shadcn Select; ad-hoc Input "Voucher # or narration…" (JournalFilters.tsx:167); "Reset Filters" (:222) | `Skeleton`; empty text | custom Previous/Next pager (JournalVoucherList.tsx:396-421) vs Daybook `PaginationBar`; 117 hard-coded colours across folder; near-twin of Daybook with no export |
| IntercompanyLinks.tsx | `/intercompany-links` | PH `onBack=window.history.back()` (:284-287) | none | none | `Table` (:305) | none | "Loading…" text (:299) | "New Link" (:291); `confirmAction` from ConfirmHost (:363) |
| IntercompanyRequests.tsx | `/intercompany-requests` | PH `onBack=window.history.back()` (:143-146) | status filter (unverified component) | none | cards | — | "Loading…" text (:162) | local `StatusBadge` with hard-coded emerald/rose/amber (:43-49); `parseFloat().toLocaleString()` (:201, :287); route not wrapped in `R()`/`G()` guard (ErpRoutes.tsx:461) |
| LedgerMonthlySummary.tsx | `/ledger-monthly/:accountId` | PH title = account name, `"Loading..."` as title (:125) | none | none | `Table mobileLayout="cards"` (:178), `Table` (:288) | PF (:134) | `Skeleton` | report page without export |
| LedgerVouchers.tsx | `/ledger-vouchers/:accountId/:year/:month` | PH, `"Loading..."` title (:132) | none | none | `ErpListTable` (:183) | PF (:136) | `Skeleton` | report page without export; 28 hard colours |
| NetProfitDetails.tsx (+netprofitdetails/) | `/net-position-details` | PH "Net Position Details" (:271) | none | "Actions" dropdown: "Export (full)", "Monthly Excel" server Excel via `window.open` (:289-318) + WhatsApp | card panels, raw `<button>` rows (NetPositionSidePanel) | custom date filter (:386) | full-page `Skeleton` (:225-235) | file/route name "NetProfit" vs UI "Net Position"; export hidden under "Actions"; 81 hard colours |
| NetProfitReport.tsx | `/net-profit-report` | PH w/ icon+meta (:332) | none | single primary `Button` "Export" -> `window.open('/api/reports/net-profit-excel')` (:307, :337) | raw `<table>` (:214) | own preset list duplicating PF presets (:32-39) + nat-date x2 (:418, :428) | `Loader2` spinner (:446) + `ErrorState` (:451) | 54 hard colours; local `formatAmount` (:112) |
| OptionalVouchers.tsx | `/optional-vouchers` | PH (:173) | none | none | `ErpListTable` (:289) + totals row (:382) | `ErpListFilters`; nat-date x2 (:213, :220) | `Skeleton` | `ErpConfirmDialog` x2 (:472, :484); `toLocaleString` x4 |
| PartiesHub.tsx | `/parties` | no header; tab bar only | shadcn Tabs + `useHubQueryState` (URL-backed) (:32) | — | — | — | Suspense "Loading…" text (:63) | the one URL-backed tab hub in scope (good reference) |
| Customers.tsx | tab in `/parties` (lazy export exists but no direct route) | PH `showBackButton={false}` (:347) | none | none (row "Print Invoice" -> server PDF :683) | `ErpListTable` (:431) + `Table` x2 | `ErpListFilters` | `Skeleton` | "New Customer" (:352) but dialog title "Create New Customer" (:357); 30 hard colours; no export of customer list |
| SupplierProfitCheck.tsx (+supplierprofitcheck/) | `/supplier-profit-check` + tab in `/parties` | PH (SupplierProfitCheckSetup.tsx) | none | 2 loose buttons "Supplier Excel" / "Analysis Excel" duplicated top and bottom (Setup.tsx:113-124, :505-509); 3 implementations: `xlsx-js-style` dynamic import (useSupplierProfitCheckModel.tsx:247), manual anchor (:633-686), private `downloadBlob` (useSupplierProfitCheckSafeModel.tsx:37) | `ErpListTable` | PF; ad-hoc search | ad-hoc loading text | local `components/StatCard.tsx` + wrapper `StatusBadge`; 94 hard colours; file names `proforma-{ref}.xlsx`, `profit-analysis-{ref}.xlsx` |
| SupplierProfitReconciliation.tsx | `/supplier-profit-reconciliation` | PH "Supplier Profit Review" (:186) — title differs from route/file name | none | none | summary sections | nat-date x3 (:245, :270, :273) | ad-hoc | report page without export |
| SalesReport.tsx -> SalesReportLegacy.tsx (+salesreportlegacy/) | `/sales-report` | raw `<Link>` pill nav above (SalesReport.tsx:28-44) + PH (SalesReportLegacy.tsx:429) | none | EREM "Export Excel" + "Print / Save PDF" (:434-441); excelHelper; file `detailed-sales-report-{yyyy-MM-dd}.xlsx` (salesreportlegacy/exportExcel.ts:80); `ErpReportPrintFooter` | `Table mobileLayout="cards"` (:577) | PF (:516) + ad-hoc Input "Search..." (:520) | `Skeleton` + `ErrorState` (:633) | writes `globalThis.selectedCompany` (SalesReport.tsx:16); 32 hard colours |
| SalesReportDetail.tsx (+salesreportdetail/) | `/sales-report/detail` | PH in SalesReportDetailHeader.tsx:82 w/ `onBack` | view toggle buttons (ghost Buttons :107-139) | none found (no export code in folder) | `Table` x2 + dedicated mobile view | column chooser popover (:208) w/ raw `<button>` (:233) | `Skeleton` | uses `money_shared` consistently; no export |
| SalesReportComparison.tsx | `/sales-report/comparison` | PH "Company Comparison", `onBack=navigate("/sales-report")` (:266-269) | raw `<button>` toggles (:350, :428) | none | `Table` (:501) | nat-date x4 (:278-375); ad-hoc "Search items..." (:481) | "Loading comparison data…" text (:496) | `toFixed` (:217); no export |
| StockInSalesReport.tsx | `/stock-in-sales-report` | PH, `onBack=window.location.href="/sales-report"` (:402 — full reload) | sub-views via `?view=` (:220-222) | EREM "Export Excel" / "Export CSV" / "Print / Save PDF" (:409-417); `erpReportFileName("stock-in-sales-report","xlsx",…,"-")` (:355) | `ErpListTable` (:561) | PF (:472) + ad-hoc "Search items..." (:480) | `Skeleton` | best-practice reference in scope |
| StockInSalesReportComparison.tsx | `/stock-in-sales-report?view=comparison` | PH, `onBack=window.history.back()` (:380-383) | raw `<button>` (:151, :164) | none | `Table` x3 | PF (:392) + ad-hoc search (:408) | `Skeleton` | no export though sibling has full menu |
| StockInSalesReportDetail.tsx | `/stock-in-sales-report?view=detail` | PH x2 (:493, :504), `window.history.back()` | none | EREM "Export Excel" / "Print / Save PDF" (:514-521); file `stock-flow-detail-{label}.xlsx` (:471) — not via `erpReportFileName` | `Table mobileLayout="cards"` x3 | — | `Skeleton` | no CSV though parent has it |
| TransporterStatement.tsx (+transporterstatement/) | embedded in `TrackingHub` (no own route) | no PH; print-only `<h1>` (:438) | none | one button "Print / Export PDF" (:513) -> html2canvas image; PNG file `TransporterStatement_{name}_{date}.png` (:269); inline print `<style>` with hex colours (:395-430) and hard-coded "HMD International Group" footer (:242) | `Table` (:579) + HTML-string `<table>` (:231) | nat-date x2 (:458, :469) | `Skeleton`; "Refreshing…" text (:721) | local `toLocaleString("en-US")` fmt (:135, :142); wrapper `StatusBadge` |
| Payroll.tsx | `/payroll` | thin wrapper -> `payroll/PayrollView` (out of scope) | — | — | — | — | — | wrapper only |

Routed pages/tab-panels audited: 44 rows (41 routed pages/sub-views + 3 embedded panels). `components/financial/financial-screen.tsx` is covered in finding 1.

## Inconsistency findings

1. **Three page-frame families; the purpose-built `FinancialScreen` is used by nobody.**
   - `components/financial/financial-screen.tsx` exports `FinancialScreen`, `FinancialScreenHeader`, `FinancialSectionHeader`, `FinancialSummaryCard`, `FinancialSummaryGrid`, `FinancialStatusStrip`, `FinancialTableShell` (:12-188). A repo-wide grep for `FinancialScreen|FinancialTableShell|FinancialSummaryCard` under `client/src` finds no consumer outside that file.
   - Family A (12 `/accounting/*` pages): `<div class="space-y-5 p-3 sm:p-5">` + bare `<h1 class="text-2xl font-semibold">` — AccountingOpenItems.tsx:172-174, CashBankReconciliation.tsx:257-260, MonetaryFxAccounting.tsx:159-161, UnifiedAccountingDashboard.tsx:303-305 (same in the other 8). No back button, no icon, no actions slot.
   - Family B (`PageHeader`): Daybook.tsx:652, NetProfitReport.tsx:332, CostCenters.tsx:159, etc.
   - One-offs: AccountingToolbox.tsx:31 (`<main class="container mx-auto max-w-6xl">`), TransactionJournal.tsx:17 (bespoke gradient `<header>`), TransporterStatement.tsx (no header), PartiesHub.tsx (tabs only).
   - Nothing in scope uses `ErpPage` / `PageShell` (metrics: shell_ErpPage=0, shell_PageShell=0 for every file in scope).
   - Standard: `ErpPage` (or `PageHeader` at minimum) everywhere; either adopt `FinancialScreen*` for the 12 accounting pages or delete it. Size M (12 mechanical header swaps) / low risk; TransactionJournal header S / low.

2. **Back-navigation is implemented four ways.**
   - `window.history.back()`: IntercompanyLinks.tsx:287, IntercompanyRequests.tsx:146, StockInSalesReportComparison.tsx:383, StockInSalesReportDetail.tsx:506.
   - `navigate(path)`: CostCenters.tsx:162, SalesReportComparison.tsx:269, LedgerVouchers.tsx:133.
   - `window.location.href = "/sales-report"` (full page reload, loses SPA state): StockInSalesReport.tsx:402.
   - Default shared back (PageHeader.tsx:60 `showBackButton = true`, :75) on most; explicitly off in Customers.tsx:347; absent on all 12 Family-A pages even though they are only reachable from the Accounts header/toolbox.
   - Standard: rely on PageHeader's shared back handler; pass `onBack` only for a fixed parent; never `window.location.href`. Size S / low.

3. **Tabs: four mechanisms, only one URL-backed.**
   - shadcn `Tabs` + `useHubQueryState`: PartiesHub.tsx:32-50 (only one).
   - shadcn `Tabs` with local state: AccountsLegacy.tsx:65, :330; Daybook.tsx:692.
   - `Button` default/outline pretending to be tabs: GroupConsolidationAccounting.tsx:350, HistoricalAccounting.tsx:292, FiscalCloseReview.tsx:391, UnifiedAccountingDashboard.tsx:377, UnifiedAccountingRollout.tsx:238 (no `role="tab"`, no keyboard nav, not deep-linkable).
   - Raw `<button>`: AnalyticsLegacy.tsx:59 (sidebar, testid `tab-*`), JournalOverview.tsx:35, SalesReportComparison.tsx:350, :428, StockInSalesReportComparison.tsx:151, :164, AccountingCreate.tsx:112.
   - `?view=` param swapping whole page components: StockInSalesReport.tsx:220-222.
   - Standard: `Tabs`/`PillTabButton` + `useHubQueryState` for every section switcher. Size M / low-medium (deep-link behaviour changes).

4. **Export: eight implementations, inconsistent labels, placement and file names.**
   - EREM (the standard): Daybook.tsx:662, SalesReportLegacy.tsx:434, StockInSalesReport.tsx:409, StockInSalesReportDetail.tsx:514, ProfessionalFinancialStatements.tsx:328.
   - Hand-rolled CSV Blob + standalone outline button "Export overview CSV": UnifiedAccountingDashboard.tsx:246-296, :325 (sister page Statements uses `exportErpReportCsv`, :207).
   - Server Excel via `window.open`: NetProfitReport.tsx:307 (primary filled button "Export", :337), NetProfitDetails.tsx:300, :318 (inside an "Actions" dropdown, labels "Export (full)" / "Monthly Excel"), accounts/AccountStatementView.tsx:281, accounts/FxAgentEurStatement.tsx:242-250 (two loose buttons "EUR PDF"/"EUR Excel").
   - Server fetch + manual anchor: components/financial/CostCenterReports.tsx:210-232, three loose buttons labelled only "CSV" "XLSX" "PDF" (:460).
   - `xlsx-js-style` + manual anchors + a private `downloadBlob` clone: supplierprofitcheck/useSupplierProfitCheckModel.tsx:247, :633, :658, :686; useSupplierProfitCheckSafeModel.tsx:37 (shared `@/lib/downloadBlob` exists).
   - html2canvas image export labelled "Print / Export PDF": TransporterStatement.tsx:255-288, :513.
   - Labels for the same action: "Export Excel" (StockInSalesReport.tsx:415), "Export" (NetProfitReport.tsx:339), "Export (full)" (NetProfitDetails.tsx:304), "Summary"/"Detailed" (Daybook.tsx:668, :674), "XLSX" (CostCenterReports.tsx:460), "Supplier Excel" (SupplierProfitCheckSetup.tsx:116), "EUR Excel" (FxAgentEurStatement.tsx:253).
   - File names: `erpReportFileName(...)` (StockInSalesReport.tsx:355, daybook/exportDaybook.ts:32 — and those two already differ: kebab-case vs `Daybook_Detail`), `detailed-sales-report-{date}.xlsx` (salesreportlegacy/exportExcel.ts:80), `stock-flow-detail-{label}.xlsx` (StockInSalesReportDetail.tsx:471), `unified-accounting-{id}-{date}.csv` (UnifiedAccountingDashboard.tsx:296), `TransporterStatement_{name}_{date}.png` (TransporterStatement.tsx:269), `cost-centers-{view}-{from}-{to}.{fmt}` (CostCenterReports.tsx:232).
   - Standard: one EREM in the header actions slot, items always "Export Excel" / "Export CSV" / "Print / Save PDF", names from `erpReportFileName` (kebab-case). Size M / low for labels+placement, M-L for swapping implementations.

5. **Report/list pages with no export at all.** AnalyticsLegacy (whole hub; no export code anywhere in `analyticslegacy/`), TransactionJournal (twin of Daybook, which has export), LedgerMonthlySummary.tsx, LedgerVouchers.tsx, SalesReportComparison.tsx, SalesReportDetail (+ folder), StockInSalesReportComparison.tsx, SupplierProfitReconciliation.tsx, OptionalVouchers.tsx, Customers.tsx, AccountsLegacy account list, and 10 of the 12 `/accounting/*` pages (AccountingOpenItems, CashBank, MonetaryFx, ErpInventory, FactoryProduction, UnifiedRental, GroupConsolidation, Historical, FiscalCloseReview, Rollout). Standard: every tabular report gets EREM Excel + Print. Size M each family / low risk (client-side row export via `exportErpReportRowsExcel`).

6. **Tables: raw `<table>` in all newer accounting pages vs shared tables in older ones.**
   - Raw `<table class="w-full text-sm">`: AccountingOpenItems.tsx:256, :315; CashBankReconciliation.tsx:479, :589; MonetaryFxAccounting.tsx:200, :253, :367; GroupConsolidationAccounting.tsx:372-556; CostCenterReports.tsx:476-591; AccountTransfer.tsx:371; NetProfitReport.tsx:214 (≈36 raw tables in scope; none has sorting, column chooser, sticky header or mobile card fallback).
   - `ErpListTable`: Daybook, LedgerVouchers.tsx:183, OptionalVouchers.tsx:289, StockInSalesReport.tsx:561, Customers.tsx:431, accounts/AccountTable.tsx, SupplierProfitCheckTable.
   - shadcn `Table` (with or without `mobileLayout="cards"`): BalanceRepair.tsx:291 (no mobile layout) vs ConvergenceReconciliation.tsx:159 (cards).
   - Standard: `ErpListTable` for record lists; `Table mobileLayout="cards"` for small evidence tables; `FinancialTableShell` if kept. Size L / medium (36 tables), can be done per page.

7. **Date filters: `PeriodFilter` vs native date inputs vs re-implemented presets.**
   - PF: Daybook, TransactionJournal, LedgerMonthlySummary.tsx:134, SalesReportLegacy.tsx:516, StockInSalesReport.tsx:472, AnalyticsLegacy.tsx:78.
   - Native `<Input type="date">` From/To: SalesReportComparison.tsx:278-375 (4 inputs) — while its sibling StockInSalesReportComparison.tsx:392 uses PF; OptionalVouchers.tsx:213, :220; SupplierProfitReconciliation.tsx:245-273; TransporterStatement.tsx:458, :469; CostCenters.tsx:298, :310; all Family-A pages.
   - NetProfitReport.tsx:32-39 re-declares its own preset list (Today/Yesterday/This Week/…/Custom Range) plus native inputs (:418, :428).
   - Standard: `PeriodFilter` for ranges; `date-picker-input` for single as-of dates. Size M / low-medium (query param shapes).

8. **Select controls: native `<select>` only in Family-A pages.** AccountingOpenItems.tsx:183, CashBankReconciliation.tsx:275, :541, MonetaryFxAccounting.tsx:235, :328, ErpInventoryAccounting.tsx:249, :273, FiscalCloseReview.tsx:351, :488, UnifiedAccountingRollout.tsx:362 (17 total) vs shadcn `Select` everywhere else (e.g. JournalFilters.tsx:92, AccountMigration.tsx:513). Standard: shadcn `Select`. Size S-M / low.

9. **Search inputs: `SearchField` used in 2 files, ad-hoc `Input` in ~15.** Shared: AccountGroups.tsx:274, accountslegacy/FindVoucherTab.tsx. Ad-hoc with differing placeholders: "Search..." (SalesReportLegacy.tsx:520), "Search items..." (StockInSalesReport.tsx:480, SalesReportComparison.tsx:481), "Search accounts by name or code…" (AccountsLegacy.tsx:368), "Voucher # or description..." (daybook/DaybookFilters.tsx:80) vs "Voucher # or narration…" (transactionjournal/components/JournalFilters.tsx:167), "Search by name or code" (CostCenters.tsx:168). AccountGroups even mixes both (:274 vs :528). Ellipsis char also inconsistent ("..." vs "…"). Standard: `SearchField`, placeholder "Search {things}…". Size S / low.

10. **Loading / empty / error states: five styles; shared `page-state` barely used.**
    - "Loading…" plain text: AccountingOpenItems.tsx:226, IntercompanyLinks.tsx:299, IntercompanyRequests.tsx:162, AccountTransfer.tsx:366, SalesReportComparison.tsx:496, CostCenters.tsx:201, AccountsLegacy.tsx:389, PartiesHub.tsx:63.
    - `"Loading..."` injected as data: page title (LedgerMonthlySummary.tsx:125, LedgerVouchers.tsx:132), KPI value (Dashboard.tsx:180, :193, :217), button label (FactoryProductionAccounting.tsx:154).
    - `Loader2` spinner: NetProfitReport.tsx:446, BalanceRepair.tsx:225.
    - `Skeleton`: Daybook, StockInSalesReport, Customers, OptionalVouchers, NetProfitDetails.
    - Errors: `ErrorState` only in Dashboard.tsx:69, NetProfitReport.tsx:451, SalesReportLegacy.tsx:633, AccountsLegacy.tsx:392; elsewhere inline `<p class="text-sm text-destructive">` (e.g. MonetaryFxAccounting.tsx:198, :248, :249; FiscalCloseReview.tsx:271, :414) or no error branch (IntercompanyLinks, LedgerMonthlySummary — unverified beyond grep).
    - `LoadingState`/`EmptyState` from `page-state`: zero uses in scope.
    - Standard: `Skeleton` for tables/cards, `LoadingState`/`EmptyState`/`ErrorState` for panels. Size M / low.

11. **Confirm dialogs: four mechanisms incl. native `confirm`.**
    - `window.confirm`: CostCenters.tsx:152, components/financial/CostCenterAutomationRules.tsx:297.
    - Raw `AlertDialog`: Daybook.tsx:879, accounts/FxAgentEurStatement.tsx:472, accountslegacy/AccountsConfirmDialogs.tsx:23, :49.
    - `ErpConfirmDialog`: AccountGroups.tsx:594, OptionalVouchers.tsx:472, :484, accounts/DisplayAccountGroups.tsx:434.
    - `confirmAction` (ConfirmHost): IntercompanyLinks.tsx:363.
    - Standard: `ErpConfirmDialog` (declarative) or `confirmAction` (imperative) — pick one; remove native confirm. Size S / low.

12. **Money/number formatting: ≥12 private formatters; currency symbol hard-coded.**
    - Local helpers: AccountMigration.tsx:88 `fmt`, AccountTransfer.tsx:41 `fmtMoney`, BalanceRepair.tsx:26 `fmt`, CashBankReconciliation.tsx:101 `fmt`, NetProfitReport.tsx:112 `formatAmount`, ProfessionalFinancialStatements.tsx:120 `number`, UnifiedAccountingDashboard.tsx:139 `money`, CostCenterReports.tsx:97 `fmt`, CostCenterHistorical.tsx:93 `fmt`, VoucherCostCenters.tsx:38 `money`, accounts/FxAgentNativeBalance.tsx:3, supplierprofitcheck/utils.ts:57, transporterstatement/utils.ts `fmtAmt`.
    - Hard-coded `$`/`USD`: AccountTransfer.tsx:499, :507; CostCenters.tsx:352 (`"USD " + toFixed(2)`).
    - Locale differs: `"en-US"` (AccountMigration.tsx:89, TransporterStatement.tsx:135) vs `undefined` (BalanceRepair.tsx:27, OptionalVouchers.tsx:249) — digits/grouping will differ per browser locale.
    - Shared `formatMoneyDisplay`/`formatNumber` used correctly in: StockInSalesReport*, salesreportdetail/*, LedgerMonthlySummary.tsx:7.
    - Standard: `@/lib/moneyDisplay` + `@/lib/formatNumber` / `MoneyAmount`. Size M / low (visual diffs in decimals).

13. **Status badges / KPI cards re-implemented.** IntercompanyRequests.tsx:43-49 local `StatusBadge` with emerald/rose/amber classes (shared `StatusBadge` exists and is already wrapped by transporterstatement/components/StatusBadge.tsx and supplierprofitcheck/components/StatusBadge.tsx). BalanceRepair.tsx:317 uses `Badge variant="destructive"` to display an amount. Private KPI cards: dashboard/components/DashboardKPICard.tsx, supplierprofitcheck/components/StatCard.tsx, `FinancialSummaryCard` (unused) vs shared `StatCard`/`KPICard`. Standard: shared `StatusBadge` + one `StatCard`. Size S-M / low.

14. **Action-button wording and placement.**
    - Create: "Create" (AccountsLegacy.tsx:252), "New Customer" (Customers.tsx:352) with dialog title "Create New Customer" (:357), "New Cost Center" (CostCenters.tsx:182), "New Link" (IntercompanyLinks.tsx:291), "Create Account Group" (AccountGroups.tsx:431).
    - Refresh — nine different labels across one family: "Refresh" (AccountingOpenItems.tsx:221, ProfessionalFinancialStatements.tsx:326), "Refresh FX analysis" (MonetaryFxAccounting.tsx:183), "Refresh audit" (ErpInventoryAccounting.tsx:195), "Refresh accounting audit" (FactoryProductionAccounting.tsx:154), "Refresh rental accounts" (UnifiedRentalAccounting.tsx:246), "Refresh financial workpaper" (GroupConsolidationAccounting.tsx:268), "Refresh historical evidence" (HistoricalAccounting.tsx:231), "Refresh financial evidence" (FiscalCloseReview.tsx:381), "Refresh release readiness" (UnifiedAccountingRollout.tsx:218); icon-only ghost in CostCenters.tsx:176; outline+icon in TransactionJournal.tsx:33. Placement: inside the filter card (Family A) vs header (TransactionJournal).
    - Primary action as raw anchor: CashBankReconciliation.tsx:265 `<a class="rounded-md border px-3 py-2 text-sm">`; SalesReport.tsx:28-44 raw `<Link>` pills.
    - Reset: "Reset Filters" (DaybookFilters.tsx:266, JournalFilters.tsx:222) vs title "Clear date filter" (NetProfitDetails.tsx:386) vs none on most.
    - Standard: "New {Entity}" in header; "Refresh" (icon + label, outline, header); `Button asChild` for link actions. Size S / low.

15. **Pagination differs between twin pages.** Daybook uses shared `PaginationBar` (Daybook.tsx:809); TransactionJournal has a private Previous/Next footer (transactionjournal/components/JournalVoucherList.tsx:396-421); CostCenterReports has private offset buttons (:642-650); AccountTransfer paginates privately (unverified UI). Standard: `PaginationBar`/`ErpListPagination`. Size S / low.

16. **Hard-coded palette instead of theme tokens (top offenders).** TransactionJournal folder (utils.tsx 48, JournalVoucherList 47, JournalFilters 22, header violet/fuchsia gradient TransactionJournal.tsx:17-22), NetProfitReport.tsx (54), NetProfitDetails.tsx (47) + NetPositionSidePanel (34), accountslegacy/FindVoucherTab.tsx (43), SupplierProfitCheckSetup (41) / Table (33), AccountsLegacy.tsx (34), accounts/AccountTable.tsx (34), SalesReportLegacy.tsx (32), Customers.tsx (30); TransporterStatement print CSS uses hex (`#0d7c66`, :405) and a hard-coded company name "HMD International Group" (:242) in a multi-company product. Standard: semantic tokens + `drCrClass`. Size L / low-medium (visual).

17. **Naming mismatches between menu label, title, route, file.**
    - "Net Position Details" (NetProfitDetails.tsx:272) at `/net-position-details` in file `NetProfitDetails`, alongside a different "Net Profit Report".
    - "Supplier Profit Review" (SupplierProfitReconciliation.tsx:186) at `/supplier-profit-reconciliation`.
    - "Stock & Sales Report" (StockInSalesReport.tsx:401) at `/stock-in-sales-report`; its detail is "Stock Flow Details" (StockInSalesReportDetail.tsx:505).
    - TransactionJournal eyebrow "All Daybook" + title "Transaction Journal" (TransactionJournal.tsx:28-29).
    - "Accounts Overview" (AccountsLegacy.tsx:204) for nav item Accounts; `/financial-overview` renders title "Dashboard" (Dashboard.tsx:62).
    - Accounts header link labels differ from the destination h1: "Rental Accounting" (AccountsLegacy.tsx:192) -> "Unified Rental Accounting"; "Financial Statements" (:195) -> "Professional Financial Statements"; "Fiscal Closing & Audit" (:196) -> "Fiscal Period Closing & Audit Review"; "Open Items" (:180) -> "Open-item reconciliation" (sentence case, the only non-Title-Case h1).
    - Standard: one name per page used in nav, link, title and export file name. Size S / low.

18. **Route guarding is uneven.** All `/accounting/*` use `R(path, true, …)` (ErpRoutes.tsx:258-270); `/intercompany-requests` is a bare `<Route>` (:461) while `/intercompany-links` is `R(...)` (:460); `/ledger-monthly` and `/ledger-vouchers` are bare routes (:273, :280, surrounding condition unverified). No `Can`/`useCan` gating seen inside the Family-A pages for their mutation buttons (grep found none; server-side enforcement unverified).

19. **i18n.** Metrics show `hardcoded_text_i18n_t` > 0 only in transactionjournal/components/JournalFilters.tsx (3); every other file in scope is hard-coded English, so the journal is the odd one out (or the only one started). Unverified whether an i18n rollout is intended for ERP.

## Duplicates / dead candidates

- `components/financial/financial-screen.tsx` — 7 exported primitives, zero consumers (dead, or the intended standard never adopted).
- `Accounts.tsx` (11 lines) -> `AccountsLegacy.tsx`; `Analytics.tsx` -> `AnalyticsLegacy.tsx`; `SalesReport.tsx` -> `SalesReportLegacy.tsx`: the "Legacy" file is the only implementation; the wrapper adds a global hack (`window.fetch` patch in Analytics.tsx:44-97; `globalThis.selectedCompany` in SalesReport.tsx:16). Not dead, but the Legacy suffix is misleading — rename/merge once the hacks are removed.
- `TransactionJournal` ("All Daybook") vs `Daybook`: same domain, two filter bars, two tables, two pagers, two voucher detail dialogs (`transactionjournal/components/JournalDetailDialog.tsx` + `detail/*Panel.tsx` vs `daybook/VoucherDetailsDialog.tsx` + `voucherdetailsdialog/*Entries.tsx`). Strong merge candidate.
- `SalesReportComparison.tsx` vs `StockInSalesReportComparison.tsx`: two comparison pages with different filters (native dates vs PF), neither exports.
- `supplierprofitcheck/useSupplierProfitCheckModel.tsx` (798 lines) and `useSupplierProfitCheckSafeModel.tsx` (329): SupplierProfitCheck.tsx:3 imports only the Safe model; whether the Safe model wraps the big one is unverified — check before deleting. Both contain export code.
- `SupplierProfitCheck` is reachable twice: `/supplier-profit-check` (ErpRoutes.tsx:314) and PartiesHub tab `profit-check`.
- `lazyPages.ts:63` exports `Customers` but ErpRoutes has no direct Customers route (only via PartiesHub's own lazy import) — unused export in ERP routes (may be used by other route files; unverified).
- `AccountGroups.tsx` (page) vs `accounts/DisplayAccountGroups.tsx` (446 lines, same ErpField/ErpConfirmDialog imports) — likely two UIs for account groups; overlap unverified.
- `NetProfitDetails` ("Net Position") vs `UnifiedAccountingDashboard` ("Unified Net Position & Accounting Dashboard") vs `Dashboard` Net Position KPI (Dashboard.tsx:192) — three net-position surfaces.
- Private formatter clones listed in finding 12; private `downloadBlob` clone (useSupplierProfitCheckSafeModel.tsx:37); private `StatCard`/`DashboardKPICard`.
- CSS one-offs: `daybook/daybook-premium.css` (373 lines), `accounts/propertiesLedger.css` (469 lines).

## Quick wins (mechanical, low risk)

1. Replace `window.confirm` (CostCenters.tsx:152, CostCenterAutomationRules.tsx:297) with `ErpConfirmDialog`/`confirmAction`.
2. Fix `window.location.href` back (StockInSalesReport.tsx:402) -> `navigate`; drop `window.history.back()` overrides in 4 files in favour of PageHeader default.
3. Normalise export item labels to "Export Excel" / "Export CSV" / "Print / Save PDF" and move NetProfitReport, NetProfitDetails, UnifiedAccountingDashboard, CostCenterReports, FxAgentEurStatement, SupplierProfitCheckSetup buttons into an `ErpReportExportMenu`.
4. Route all export file names through `erpReportFileName` (kebab-case).
5. Swap the 12 bare-h1 headers for `PageHeader` (title/subtitle already present as text).
6. Swap ad-hoc search Inputs for `SearchField` with a consistent placeholder.
7. Replace IntercompanyRequests local `StatusBadge` with shared one.
8. Replace "Loading..." used as title/KPI value with skeletons; replace plain "Loading…" paragraphs with `LoadingState`.
9. Unify Refresh label/placement on the 12 accounting pages ("Refresh", outline, header action).
10. Replace hard-coded `$` in AccountTransfer.tsx:499/:507 and `"USD "+toFixed` in CostCenters.tsx:352 with `formatMoneyDisplay`.
11. Replace raw `<a>`/`<Link>` action pills (CashBankReconciliation.tsx:265, SalesReport.tsx:28-44) with `Button asChild`.
12. TransactionJournal pager -> `PaginationBar`.
13. Align Accounts-header link labels with destination page titles (finding 17).

## Bigger refactors

1. Decide the accounting page frame: adopt `FinancialScreen*` (or `ErpPage`) across the 12 `/accounting/*` pages + CostCenters, including raw `<table>` -> `FinancialTableShell`/`ErpListTable`, native `<select>` -> `Select`, native dates -> `PeriodFilter`/`date-picker-input`, button-tabs -> `Tabs` + `useHubQueryState`. (L, medium; ~36 tables, 17 selects.)
2. Merge TransactionJournal into Daybook (one filter bar, one table, one detail dialog, one export). (L, medium-high.)
3. Add exports to the report pages listed in finding 5 using one client helper (`exportErpReportRowsExcel`) so they respect current filters. (M-L, low.)
4. Remove global hacks and "Legacy" indirection: Analytics fetch patch, SalesReport `globalThis.selectedCompany`. (M, medium.)
5. Consolidate formatters onto `moneyDisplay`/`formatNumber` and purge hard-coded palette (TransactionJournal, NetProfit*, SupplierProfitCheck, Accounts). (L, low-medium visual risk.)
6. Unify comparison pages (SalesReportComparison + StockInSalesReportComparison) and the three net-position surfaces. (L, product decision needed.)
7. TransporterStatement: replace html2canvas image "PDF" + inline print CSS + hard-coded company name with the shared print footer/export menu. (M, medium.)
8. SupplierProfitCheck: single export path, confirm whether the 798-line model is still needed. (M, medium.)
