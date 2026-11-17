# 04 — Factory: Production / Bales / Stock / Scanning — UI unification audit

Scope: `client/src/pages/factory/` production, bales, stock and scanning pages (plus `pages/StockEntryHistory.tsx`, which is a tab of Stock Entry).
Method: route map from `components/FactoryRoutes.tsx`, `lazyPages.ts`, `factory/config/navigationPresentation.ts`, `shared/factoryAccessRegistry.ts`; every top-level page file was profiled with a per-file pattern scan and the header / tabs / export / filter / action areas were read. Large sub-component folders (`productiontargets/`, `production-raw-stock/`) were profiled and spot-read, not read line by line — items there marked "unverified" where I did not open the code.
All paths below are relative to `client/src/pages/factory/` unless they start with `client/` or `shared/`.

Headline facts (whole scope, ~50k lines):
- `ErpPage`, `ErpReportExportMenu`, `ErpListTable`, `PaginationBar`/`ErpListPagination`, `@/components/ui/page-state` are used by **zero** files in scope.
- `PageShell` is used by exactly one page (`FactoryStockBaleList.tsx:75`). `SearchField` by 3 files, `PeriodFilter` by 1 (`wastedispatch/components/DispatchHistoryPanel.tsx`), against ~70 native `type="date|month|time"` inputs in 35 files and 19 hand-built `<Search className…>` + `<Input>` search boxes.
- Raw `<table>` appears at 37 places in 26 files; shadcn `Table` in about 20 files — roughly half/half, sometimes both in the same file (`ProductionComparison.tsx`, `WasteDispatch.tsx`, `FactoryProductionTargets.tsx`).

## Page inventory

Legend: PH = `@/components/PageHeader`; h1/h2 = hand-built heading; URL = `useHubQueryState`; "local" = `useState` only.

### Hubs

| Page (file) | Route | Shell/Header | Tabs | Export/Print | Table | Filters | States | Notable issues |
|---|---|---|---|---|---|---|---|---|
| `BaleStockEntry.tsx` | `/factory/stock-entry` | `FactoryMobilePage` + `FactoryMobileHeader`, hand-built h1 (title changes with tab, :134) | shadcn `Tabs`, **local state**, manual `?tab=production-targets` read only (:35) | `LabelPrintSettings` in header | — | — | — | Only hub not URL-backed; `history` tab has content but **no TabsTrigger** (reachable only via button in Stock Entry, :198-212); 4 page-specific CSS files; title/labels English while one tab label is translated (:192) |
| `FactoryBalesHub.tsx` | `/factory/bales-hub` | PH "Bales", `showBackButton={false}` | shadcn, URL `?tab=` | — | — | — | plain text "No Bale Explorer tabs…" | Hub title "Bales", first tab "Bales", and tab body repeats `<h1>Bales</h1>` (`baleshistory/components/BalesHistoryOverview.tsx:41`) |
| `FactoryProductionIntelHub.tsx` | `/factory/intelligence/production-hub` | **no header at all** | shadcn, URL `?section=` | — | — | — | plain text | Different query key (`section`) from the other hubs (`tab`); each child renders its own PH |
| `DailyProductionReport.tsx` ("Overview") | `/factory/production-report` | PH "Overview" (back button default on) | shadcn, URL `?tab=` | — | — | — | "Loading access..." text | Component/file/route say "production report", page says "Overview"; header restyles itself per active tab (`shipping`) |
| `FactoryOthers.tsx` | `/factory/others` | PH "Others" | shadcn, URL `?tab=` | — | — | — | "Loading access..." text | Two tabs gated by raw role check (`user.role === "Admin"`, :26) while the other two use hidden-keys |
| `FactoryImport.tsx` | `/factory/import` | **no header** | `PillTabButton`, local state | per-tab template download | — | — | plain text | Not URL-backed; no title |
| `FactoryRawMaterialsHub.tsx` | `/factory/raw-materials` | — | none | — | — | — | — | 5-line wrapper around `ProductionRawStock`; same page also routed at `/factory/raw-stock` |
| `FactoryKpis.tsx` | `/factory/intelligence/kpis` | PH + date inputs to the right | shadcn, local state | **none** (3 report tables) | shadcn `Table` ×3 | 2 native date `Input` | `Loader2` + "Loading daily production..." | Report page without export; tabs not URL-backed |

### Stock Entry tabs (inside `BaleStockEntry`)

| Page (file) | Route | Shell/Header | Tabs | Export/Print | Table | Filters | States | Notable issues |
|---|---|---|---|---|---|---|---|---|
| `bale-stock-entry/StockEntryTab.tsx` (+Cart, Scanner, Sidebar, Dialogs, Printing) | tab `entry` | Card title "New Production Entry" | — | label printing through new window + `win.print()` (:840) | `ResponsiveDataList` (Cart) | — | toasts ×13 | Only scanner screen using `FactoryMobileScannerPanel` |
| `client/src/pages/StockEntryHistory.tsx` | tab `history` (no trigger) | h2 + icon tile | Button-pair Condensed/Detailed (:269-287) | **none** | raw `<table>` ×3 | `HistoryFilters` (custom) | "Loading" text | Lives outside `factory/`; only file in scope using `Can`-style gating (4 hits) |
| `GroundScan.tsx` | tab `ground-scan` | no heading | — | "Export Verification" → ExcelJS via `excelHelper`, `ground-verification-<date>.xlsx` (:613, :738) | shadcn `Table` | shadcn `Select` location, scan `Input` | `Loader2`; AlertDialog "Clear All" | Uses shared `StatusBadge` through a local wrapper |
| `DailyScan.tsx` | tab `daily-scan` | no heading | — | "Export" → ExcelJS via `excelHelper`, `daily-scan-<date>.xlsx` (:350, :407) | shadcn `Table` ×2 | native date + prev/next chevrons | "Loading…" text | Own `StatusBadge` with solid colours; "Sold" = red, same as "Deleted" (:74-79) |
| `PressingMachineManagement.tsx` (+`ContinuousPressingScanner.tsx`, `PressingOfflineQueueStatus.tsx`) | tab `pressing-machines` | h2 "Pressing Scan" | Button-pair barcode/manual (:210-225) | — | — | scan `Input` | — | Own camera stack (`pressing-scanner/cameraDecoder`), not `MobileBarcodeScanner` |
| `PressingHistoryReport.tsx` | inside pressing tab | h3 "Pressing Overview" | raw `<button aria-pressed>` condensed/detailed (:569-580) | "Export Excel" → `pressing-scanner/pressingReportClient` (:555) | raw `<table>` | 4 native date/time inputs, 3 native `<select>` | text | "Refresh" labelled button with spinning icon |
| `PressingWorkerTotals.tsx` | inside pressing tab | h3 | — | **none** | raw `<table>` | native date | text | "Refresh" labelled |
| `PressingHourlyTargets.tsx` | inside pressing tab | — | `role="tab"` raw buttons (:532) | **none** | raw `<table>` | native date | text "Could not load… Try Refresh." | Refresh is icon-only with sr-only label (:324) |
| `PressingCorrectionReview.tsx` | inside history report | CardTitle | raw `<button aria-pressed>` active/voided (:169-178) | — | raw `<table>` | `Input` | text | — |
| `FactoryProductionTargets.tsx` (+`productiontargets/`) | tab `production-targets` | h2 inside CSS-skinned hero (`productionTargetsPremium.css`) | Selects for period | "Export production Excel" (`FileDown` icon, range dialog → `productionWeeklyExcel.ts`), PNG via `html2canvas` (:142) | raw `<table>` + shadcn `Table` | `SearchField`, native date, shadcn `Select` | `Loader2` | Fully translated (57 `tr()` calls) while sibling tabs are English-only |
| `FactoryProductionBonuses.tsx` (+ panels) | `/factory/production-bonuses` (Admin/Owner only) | hand-built h1 + ghost "Back to targets" text button | — | "Export formatted Excel" (`ProductionBonusHistoryPanel.tsx:97`), "Export Excel" (`ProductionTargetWeeklyBonusPaymentsPanel.tsx:302`) | mixed raw/shadcn across panels | ~25 native date inputs | AlertDialog confirms | Three different export labels and two icons (`FileDown`, `Download`) inside one feature |

### Bales hub tabs and bale pages

| Page (file) | Route | Shell/Header | Tabs | Export/Print | Table | Filters | States | Notable issues |
|---|---|---|---|---|---|---|---|---|
| `BalesHistory.tsx` (+`baleshistory/`) | hub tab `history`; also `/factory/bales-history` | h1 "Bales" in summary card | — | "Tools" dropdown: "Export Bales (date)" and "Export Names" via `window.open(/api/…xlsx)` (:222, :241); "Export Register" button → dialog → fetch blob, `stock_register_<from>_to_<to>.xlsx` (`useBalesHistoryModel.tsx:140`); label printing via popup `print()` | shadcn `Table` | native date + chevrons + "Clear", shadcn `Select` status | `Skeleton`; "Page X of Y" custom pager | Three exports in two different places on one screen; delete/repack confirms are plain `Dialog`s named `BalesHistoryDialog1..5` |
| `FactoryBaleTracking.tsx` | `/factory/bale-tracking` | PH, `max-w-2xl` | — | — | cards | `Input` + Enter | `Skeleton` | Developer-only check done in page body (:118), not via route |
| `FactoryReprintLabels.tsx` | `/factory/reprint-labels` | PH + separate `<p>` subtitle instead of `subtitle` prop (:254-257) | — | print via popup `print()` | raw `<table>` | 2 `Input`, raw `<button>` ×4 | "Loading…" text + Skeleton | — |
| `FactoryBaleRelabeling.tsx` | `/factory/bale-relabeling` | PH below pill tabs | `PillTabButton` used as **route links** to sibling page (:236-246) | "Download Template", "Print Labels (fmt)" | shadcn `Table` ×4 | — | toasts | "Start Over" uses `RefreshCw` icon |
| `WipersReEntry.tsx` | `/factory/bale-relabeling/wipers-re-entry` | PH below pill tabs | same pill-as-link pattern (:320-330) | Print A4/Sticker/A5/All; button **"Export CSV" actually writes `.xlsx`** (:292-295, :785 → `wipersreentry/exportWorkbook.ts:16`) | shadcn `Table` ×3 | native date | Skeleton | Mislabelled export |
| `bale-product-history/FactoryBaleProductHistory.tsx` | `/factory/bale-product-history/:p/:l` | ghost icon back + PH | — | **none** | shadcn `Table` | — | Skeleton | — |
| `bale-product-history/FactoryBaleProductMonthDetail.tsx` | `…/:year/:month` | ghost icon back + **h1** | — | **none** | shadcn `Table` | `Input` search, shadcn `Select` status | Skeleton, text empty | Sibling of the row above but different header component |
| `bale-product-history/FactoryBaleProductAllMonths.tsx` | `…/:year/all` | ghost icon back + **h1** | — | **none** | shadcn `Table` | shadcn `Select` | Skeleton | Near-copy of MonthDetail (see Duplicates) |
| `MergeBaleProducts.tsx` | `/factory/merge-bale-products` | ghost icon back + PH | — | — | lists | `Input` | Skeleton + Loader2 | Back/Done/Cancel navigate to `"/settings"` (:101, :138, :337), which is not a factory route (factory settings is `/factory/settings`) — falls through to the default-page redirect (behaviour unverified at runtime) |
| `BaleProductImages.tsx` | `/factory/bale-product-images` | h2 list title; PH only after selecting a product; text "Back" with `ChevronLeft` | — | — | grid | `Input` | Loader2 | Image delete fires immediately, **no confirm** (:263) |
| `LabelBannersSettings.tsx` | `/factory/label-banners` | PH with `showBackButton` | — | — | cards | — | Loader2, "Loading" text | Colour delete fires immediately, **no confirm** (:278) |
| `FactoryCatalogTranslations.tsx` | `/factory/catalog-translations` | PH with editor passed as children | — | — | (shared editor) | — | — | Sentence-case title ("Catalog translations") vs Title Case elsewhere |
| `FactoryPriceList.tsx` | `/factory/price-list` | PH + actions right | — | "Download Template" (ExcelJS → `downloadBlob`, `factory_price_list_<date>.xlsx`), "Upload Prices" | shadcn `Table` | `SearchField`, shadcn `Select` | Skeleton | The "template" is the only way to export the price list; uses `RefreshCw` as upload spinner |

### Stock / inventory pages

| Page (file) | Route | Shell/Header | Tabs | Export/Print | Table | Filters | States | Notable issues |
|---|---|---|---|---|---|---|---|---|
| `FactoryLocationInventory.tsx` → `…LocationView.tsx` | `/factory/location-inventory` | hand-built h1 | — | "Export All (Excel)" `FileSpreadsheet`, `window.open(/api/…/export/all)` (:48-52) | cards | `SearchField` | Skeleton | — |
| `…ProductView.tsx` (+Renderers, Model, dialogs) | same route, location selected | ghost icon back + h1 | — | **icon-only** Print and "Export Excel" buttons (:217-237); server xlsx; proforma Excel/PDF via `window.open` (`…Model.tsx:705-716`) | raw `<table>` ×2 | 2 `Input` | Skeleton | Same export on the sibling view is a labelled button; local `StatCard` |
| `FactoryLocationInventoryMockup.tsx` | `/factory/location-inventory-mockup` (developer) | back + h1 | — | "Export", "Print", Refresh buttons with **no onClick** (:307-315) | shadcn `Table` | — | sample data | Routed mockup with hard-coded sample data (:28) |
| `FactoryStockQueryWorkspace.tsx` | `/factory/stock-query` | PH "Stock Query – Factory" | — | "Export sales CSV" manual CSV + `downloadBlob`, `factory-stock-query-sales.csv` (:83, :297); inventory table has no export | raw `<table>` ×4 | 2 native date, **5 native `<select>`** | Skeleton | "Clear filters" + unlabelled-icon "Refresh" text button; local `fmt`/`money` |
| `FactoryStockItemDetail.tsx` | `/factory/stock-query/:id` | ghost text "Back to Stock Query" + PH (title "Loading..." fallback) | — | **none** | shadcn `Table` ×4 | — | Skeleton | — |
| `FactoryStockBaleList.tsx` | `/factory/stock-bale-list` | **`PageShell` + PH + `PageActions`** (only one in scope) | — | **none** | raw `<table>` | — | `EmptyState`/`LoadingRows` from `display-state` | Title contains raw enum "IN_STOCK Bales — …" (:77) |
| `ProductionRawStock.tsx` (+`production-raw-stock/`) | `/factory/raw-stock`, `/factory/raw-materials` | hand-built gradient hero h1 "Raw Production" | — | "Export Cost Excel" (`MixBatchList.tsx:227-239`, native `<select>` + `<input type=month>`), WhatsApp PNG via `html2canvas` (:219); raw stock table has no export | shadcn `Table` | native month/date | Skeleton/Loader2; AlertDialog | Nav label "Raw Materials", page title "Raw Production", command palette "Raw material inventory" |
| `production-raw-stock/RawStockRecalculate.tsx` | `/factory/raw-stock/recalculate` | ghost icon back (`Link`) + h1 | `PillTabButton`, local | — | shadcn `Table` | — | Skeleton | "Refresh" labelled, `RefreshCw` also used for "Recompute Supplier Rates" |
| `FactorySheetsAndSacks.tsx` (+`factorysheetsandsacks/`) | `/factory/sheets-sacks`; Overview tab `sheets-sacks` | hand-built gradient hero h1 (:283) | `PillTabButton` with gradient override classes (:377-402), local | "Export" manual CSV (`sheets-sacks-stock.csv`, :244), "Print" = `window.print()` (:509); Movement Log has **no export** | card rows / shadcn `Table` in log | `Input`, shadcn `Select`, native dates in log | Loader2; AlertDialog delete | 39 hard-coded palette classes; h1 nested under Overview's PH |
| `FactoryStatusBuilder.tsx` (+`factorystatusbuilder/`) | Overview tab `sheets` only | toolbar, no heading | `role="tab"` custom sheet tabs (`TabLabel.tsx:49`) | "Export Excel" → `window.open(/api/…/sheets/export)` (:363; toolbar :81) | raw `<table>` (spreadsheet grid) | — | "Loading pages…" text | 4 raw `<button>`, no `Button` in page file |
| `WasteDispatchOptimized.tsx` (+`wastedispatch/`) | `/factory/waste-dispatch` | PH inside custom hero | — | "Print" per dispatch (`optimizedPrint.ts`, popup) | shadcn `Table` + raw `<table>` in history | native date, `PeriodFilter` in history, scan `Input` | Loader2; `Dialog`-based confirms | History has no export |

### Report / analytics panels

| Page (file) | Route | Shell/Header | Tabs | Export/Print | Table | Filters | States | Notable issues |
|---|---|---|---|---|---|---|---|---|
| `dailyproductionreport/components/ProductionTabPanel.tsx` | Overview tab `production` | h2 "Production Overview" in CSS hero | Button-pair selling/cost (:151-161) | **none** | shadcn `Table` | 2 native date + prev/next | own `SkeletonBox` | Daily production report has no export or print; 30 hard-coded colours |
| `FactoryMonthlyProductionMatrix.tsx` | `/factory/monthly-production-matrix`; Overview tab | PH + actions right | Button-pair all/selected months | "Export Excel" (paged fetch → workbook) **and** "Export CSV" (manual) side by side (:385-402); `factory-monthly-production.csv` | raw `<table>` | native month, hand-built search | text | Refresh uses `RotateCcw` (elsewhere = undo/retry); "Export Excel" is hard-coded English next to translated "Export CSV" |
| `FactoryMonthlyProductionDrilldown.tsx` (Workers, Bales) | `/factory/monthly-production-matrix/:id/workers`, `…/bales/:workerId` | PH + outline "← label" back button (:62) | Button-pair condensed/detailed | **none** | raw `<table>` ×3 | hand-built search | "Loading worker production…" text | Custom Prev/Next pager; untranslated while parent matrix is translated |
| `ProductionComparison.tsx` (+`productioncomparison/`) | `/factory/production-comparison`; Others tab `comparison` | PH inside gradient hero | — | "Export CSV" (solid blue override, :654-659), supplier table only, `production-supplier-comparison.csv` | shadcn + raw + `ResponsiveDataList` | 4 native dates, custom `MultiSelectFilter` | Skeleton | Local `StatCard`; 32 hard-coded colours |
| `productcomparison/ProductComparisonCharts.tsx` | Others tab `product-comparison` | h2 | raw `<button aria-pressed>` period/metric | **none** | charts | 4 native dates | Skeleton | Folder name differs from sibling by one letter (`productcomparison` vs `productioncomparison`) |
| `ProductionSummary.tsx` | Production-intel tab `production-summary` (`/factory/production-summary` redirects) | icon + PH (no subtitle) | — | **none** | shadcn `Table` ×2 | **none** (fixed today/week/month) | Skeleton | Only panel using `formatNumber` helpers consistently |
| `FactoryWaste.tsx` | Production-intel tab `waste` | PH + From/To right | — | **none** | shadcn `Table` | native dates, native `<select>` in dialog (:232) | Loader2 | Tab label "Waste Tracking", page title "Factory Waste" |
| `FactoryMixOptimizer.tsx` | Production-intel tab `mix-optimizer` | PH | — | **none** | cards | shadcn `Select` | Loader2 + text | — |
| `FactoryPriorityScan.tsx` (+`PriorityScanLoadingControl.tsx`, `PriorityScanColorLetter.tsx`) | tab `priority` in `/factory/invoicing` and `/factory/sales/loadings` | h2 in custom hero | — | — | cards | scan `Input` | Skeleton | Fully translated; 59 hard-coded colours; "Remove priority" fires without confirm (`PriorityScanLoadingControl.tsx:350`) |
| `FactoryMhdViewManagerPage.tsx` | `/factory/intelligence/mhd-view` | `<main>` wrapper, no PH (delegates to `factorysettings/MhdViewManager`) | — | — | — | — | — | Out-of-scope inner component, not opened |

Routed pages / tab panels audited: **53 rows** (8 hubs, 11 stock-entry panels, 13 bale pages, 11 stock pages, 10 report panels; some files serve two routes).

## Inconsistency findings

### A. Page frame and headers

1. **Five different page-title constructions; the canonical `ErpPage` is used nowhere.**
   - `PageShell`+`PageHeader`: `FactoryStockBaleList.tsx:75-80` (only one).
   - Bare `PageHeader` in ad-hoc `div`s: `FactoryKpis.tsx:123`, `FactoryPriceList.tsx:306`, `FactoryWaste.tsx:168`.
   - Hand-built `<h1>`: `ProductionRawStock.tsx:270`, `FactorySheetsAndSacks.tsx:283`, `FactoryLocationInventoryLocationView.tsx:35`, `FactoryProductionBonuses.tsx:30`, `production-raw-stock/RawStockRecalculate.tsx:60`, `bale-product-history/FactoryBaleProductMonthDetail.tsx:134`.
   - `FactoryMobileHeader` + h1: `BaleStockEntry.tsx:128-151`.
   - No title at all: `FactoryImport.tsx:46`, `FactoryProductionIntelHub.tsx:48`, `GroundScan.tsx`, `DailyScan.tsx`.
   - Standard: one frame (`ErpPage` or `PageShell`+`PageHeader`) for every routed page; hero decorations become an optional `variant`. Size L, risk medium (five pages carry bespoke CSS files).

2. **Double headers when a page is embedded in a hub.** Child pages always render their own page title, so the user sees two titles; one hub has none.
   - `FactoryBalesHub.tsx:65` PH "Bales" → tab "Bales" (:78) → `baleshistory/components/BalesHistoryOverview.tsx:41` `<h1>Bales</h1>`.
   - `DailyProductionReport.tsx:98` PH "Overview" → `FactoryMonthlyProductionMatrix.tsx:380` PH, `FactorySheetsAndSacks.tsx:283` h1.
   - `FactoryOthers.tsx:59` PH "Others" → `ProductionComparison.tsx:389` PH.
   - `FactoryProductionIntelHub.tsx` no hub header → `ProductionSummary.tsx:121`, `FactoryWaste.tsx:168`, `FactoryMixOptimizer.tsx:93` each a PH.
   - Standard: hub owns the single h1; embedded panels take an `embedded` prop (or a `SectionHeader`) and render at most an h2 plus their actions. Size M, risk low.

3. **Back-navigation has six shapes.** Ghost icon `ArrowLeft` (`MergeBaleProducts.tsx:101`, `bale-product-history/FactoryBaleProductHistory.tsx:67`), ghost text "Back to Stock Query" (`FactoryStockItemDetail.tsx:103-107`), outline "← label" (`FactoryMonthlyProductionDrilldown.tsx:61-64`), `ChevronLeft` text (`BaleProductImages.tsx:176`), `Link`-wrapped icon (`RawStockRecalculate.tsx:54`), PH `showBackButton` (`LabelBannersSettings.tsx:188`) and explicitly disabled (`FactoryBalesHub.tsx:69`, `FactoryStockBaleList.tsx:79`).
   - Standard: PH `showBackButton` driven by `lib/parent-routes.ts`. Size S-M, risk low.

4. **Subtitle placement.** `FactoryReprintLabels.tsx:254-257` and `FactoryStockItemDetail.tsx:118-119` put the subtitle in a sibling `<p>` instead of the `subtitle` prop used by `FactoryKpis.tsx:123`, `WasteDispatchOptimized.tsx:53-55`. Size S.

5. **Naming drift for the same destination.**
   - Raw stock: nav "Raw Materials" (`shared/factoryAccessRegistry.ts` key `factory/raw-materials`), page h1 "Raw Production" (`ProductionRawStock.tsx:270`), command palette "Raw material inventory" (`client/src/components/CommandPalette.tsx:107`).
   - Waste: tab "Waste Tracking" (`FactoryProductionIntelHub.tsx:66`) vs title "Factory Waste" (`FactoryWaste.tsx:168`).
   - Overview: route `/factory/production-report`, component `DailyProductionReport`, title "Overview" (`DailyProductionReport.tsx:99`).
   - `FactoryStockBaleList.tsx:77` shows the enum "IN_STOCK Bales"; `FactoryCatalogTranslations.tsx:14` is sentence case.
   - Standard: one label per registry key, reused by nav, tab, title. Size S, risk low.

### B. Tabs

6. **Hub tab state: three mechanisms and two query keys.**
   - `useHubQueryState` key `tab`: `FactoryBalesHub.tsx:43`, `DailyProductionReport.tsx:84`, `FactoryOthers.tsx:35`.
   - `useHubQueryState` key `section`: `FactoryProductionIntelHub.tsx:32`.
   - Local `useState`: `BaleStockEntry.tsx:38` (manual one-off `?tab=` read at :35), `FactoryImport.tsx:26`, `FactoryKpis.tsx:152`, `FactorySheetsAndSacks.tsx:377`, `RawStockRecalculate.tsx:113`.
   - Standard: every hub URL-backed with `useHubQueryState`, key `tab` (keep `section` only where a second level exists). Size S per hub, risk low — but `BaleStockEntry` has a test pinning its query behaviour (:107 comment).

7. **Hub hidden-tab logic is copy-pasted with three variants.** `my-access` query + `hiddenCostFields` in `FactoryBalesHub.tsx:31-41`, `FactoryProductionIntelHub.tsx:24-28`, `FactoryImport.tsx:28-34`, `BaleStockEntry.tsx:52-68`; `useFactoryNavigationAccess()` in `DailyProductionReport.tsx:44`, `FactoryOthers.tsx:21`; raw role check in `FactoryOthers.tsx:26`. "No tabs" message: `p-6` in three hubs, `p-5` in `FactoryOthers.tsx:53`; "Loading access..." only in two.
   - Standard: one `FactoryHub` component taking `{title, tabs:[{key,label,icon,hideKey,render}]}`. Size M, risk medium (permission gating).

8. **Tab component mix.** shadcn `TabsTrigger` (5 hubs, `FactoryKpis.tsx:158`); `PillTabButton` (`FactoryImport.tsx:52`, `RawStockRecalculate.tsx:113`); `PillTabButton` with gradient overrides (`FactorySheetsAndSacks.tsx:380-384`); `PillTabButton` as navigation links between two routes (`FactoryBaleRelabeling.tsx:236-246`, `WipersReEntry.tsx:320-330`); raw `role="tab"` (`PressingHourlyTargets.tsx:532`, `factorystatusbuilder/components/TabLabel.tsx:49`).
   - Standard: `Tabs`/`TabsTrigger` for in-page tabs, `PillTabButton` only for route-level sub-nav, no class overrides. Size M.

9. **Segmented view toggles (condensed/detailed, cost/selling) built three ways.** `Button` default/ghost pair (`client/src/pages/StockEntryHistory.tsx:269-287`, `FactoryMonthlyProductionDrilldown.tsx:289-293`, `ProductionTabPanel.tsx:151-161`, `PressingMachineManagement.tsx:210-225`); `Button` default/outline pair (`FactoryMonthlyProductionMatrix.tsx:407-410`); raw `<button aria-pressed>` (`PressingHistoryReport.tsx:569-580`, `PressingCorrectionReview.tsx:169-178`, `ProductComparisonCharts.tsx:510-564`).
   - Standard: one `SegmentedControl` (or `ToggleGroup`). Size M, risk low.

10. **Icon spacing inside tab triggers differs per hub.** `mr-1` (`BaleStockEntry.tsx:167`), none/gap (`FactoryBalesHub.tsx:77`), `mr-2` (`FactoryProductionIntelHub.tsx:59`), `mr-1.5` (`DailyProductionReport.tsx:113`, `FactoryOthers.tsx:70`); `FactoryKpis.tsx:158` has no icons. Size S, mechanical.

### C. Export and print (largest gap)

11. **Seven export implementations, none through `ErpReportExportMenu`.**
    - `window.open` to a server xlsx: `BalesHistory.tsx:222,241`, `FactoryLocationInventoryLocationView.tsx:48`, `FactoryLocationInventoryProductView.tsx:228`, `FactoryStatusBuilder.tsx:363`.
    - Fetch blob + hand-made anchor: `baleshistory/useBalesHistoryModel.tsx:125-147`.
    - ExcelJS through `@/lib/excelHelper`: `GroundScan.tsx:300-613`, `DailyScan.tsx:268-350`, `FactoryPriceList.tsx:176-221`, `wipersreentry/exportWorkbook.ts`.
    - Dedicated export modules: `productiontargets/productionWeeklyExcel.ts`, `productionBonusHistoryExcel.ts`, `weeklyBonusPaymentsExcel.ts`, `production-raw-stock/mixBatchCostExport.ts`, `monthlyProductionExcelExport.ts`, `pressing-scanner/pressingReportClient.ts`.
    - Manual CSV + `downloadBlob`: `FactoryMonthlyProductionMatrix.tsx:270-289`, `ProductionComparison.tsx:380`, `FactorySheetsAndSacks.tsx:244`, `FactoryStockQueryWorkspace.tsx:83` (three separate `csvCell`-style implementations; BOM handling differs: string-prefixed in the matrix, Blob part in the other two, absent in `ProductionComparison.tsx:380`).
    - `html2canvas` image: `ProductionRawStock.tsx:219`, `FactoryProductionTargets.tsx:142`.
    - `window.print()` of the live page: `FactorySheetsAndSacks.tsx:509`.
    - Standard: `ErpReportExportMenu` in the header action slot with Excel / CSV / Print entries; a single `exportRowsToCsv` helper; server exports go through one `downloadFromApi` helper so loading and error toasts are uniform. Size L, risk medium.

12. **Export button label, icon, variant and position all vary.**
    - Labels: "Export" (`DailyScan.tsx:407`, `FactorySheetsAndSacks.tsx:503`), "Export Excel" (`PressingHistoryReport.tsx:555`, `FactoryMonthlyProductionMatrix.tsx:392`, `StatusBuilderToolbar.tsx:81`), "Export CSV" (`ProductionComparison.tsx:659`), "Export sales CSV" (`FactoryStockQueryWorkspace.tsx:297`), "Export Verification" (`GroundScan.tsx:738`), "Export Register" (`BalesHistoryOverview.tsx:84`), "Export All (Excel)" (`FactoryLocationInventoryLocationView.tsx:52`), "Export Cost Excel" (`MixBatchList.tsx:239`), "Export formatted Excel" (`ProductionBonusHistoryPanel.tsx:97`), "Download Template" used as the export (`FactoryPriceList.tsx:320`).
    - Icons: `Download`, `FileSpreadsheet` (`MixBatchList.tsx:237`, `FactoryLocationInventoryLocationView.tsx:52`, `WipersReEntry.tsx:784`), `FileDown` (`FactoryProductionTargets.tsx:381`, `ProductionBonusHistoryPanel.tsx:96`).
    - Variants: outline sm (most), icon-only (`FactoryLocationInventoryProductView.tsx:217-237`), solid blue override (`ProductionComparison.tsx:654`), emerald override (`MixBatchList.tsx:231`), hidden inside a "Tools" dropdown (`BalesHistory.tsx:214-245`).
    - Busy state: "Exporting…" (`PressingHistoryReport.tsx:555`), "Exporting..." (`GroundScan.tsx:738`), spinner only (`MixBatchList.tsx:233`), none (`DailyScan.tsx:405`, all `window.open` exports).
    - Standard: label "Export" opening a menu (Excel / CSV / Print), `Download` icon, `variant="outline" size="sm"`, right side of the page header, disabled + spinner while running. Size M, risk low.

13. **Mislabelled export.** `WipersReEntry.tsx:783-785` button "Export CSV" (handler `exportCsv`, testid `button-export-csv`) writes `wipers-re-entry-<date>.xlsx` (`wipersreentry/exportWorkbook.ts:16`). Size S, risk none.

14. **File-name conventions differ.** kebab + date: `ground-verification-<date>.xlsx`, `daily-scan-<date>.xlsx`, `wipers-re-entry-<date>.xlsx`; snake: `stock_register_<from>_to_<to>.xlsx` (`useBalesHistoryModel.tsx:140`), `factory_price_list_<date>.xlsx` (`FactoryPriceList.tsx:221`), `bale_import_template.xlsx` (`bale-stock-entry/ImportBalesTab.tsx:48`); kebab with **no date or filter in the name**: `factory-monthly-production.csv`, `production-supplier-comparison.csv`, `sheets-sacks-stock.csv`, `factory-stock-query-sales.csv`.
    - Standard: `<area>-<report>-<from>_<to>.<ext>` built by one helper. Size S.

15. **Report/list screens with no export or print at all** (verified by scan, no export/print code in file): `FactoryKpis.tsx` (3 tables), `ProductionSummary.tsx`, `FactoryWaste.tsx`, `dailyproductionreport/components/ProductionTabPanel.tsx`, `FactoryMonthlyProductionDrilldown.tsx` (both drill-downs — parent matrix has two exports), `productcomparison/ProductComparisonCharts.tsx`, `PressingWorkerTotals.tsx`, `PressingHourlyTargets.tsx`, `client/src/pages/StockEntryHistory.tsx`, `factorysheetsandsacks/components/MovementLog.tsx`, `wastedispatch/components/DispatchHistoryPanel.tsx` (print per row only), `FactoryStockItemDetail.tsx`, `FactoryStockBaleList.tsx`, all three `bale-product-history/*` pages, `production-raw-stock/RawStockTable.tsx`.
    Partial coverage: `ProductionComparison.tsx` exports only the supplier table; `FactoryStockQueryWorkspace.tsx` exports sales but not the "Inventory in Hand" table (:372).
    - Standard: every list/report gets the shared export menu fed by the already-filtered rows. Size M-L, risk low.

16. **Print is implemented four ways.** Popup window + `w.print()` with image-load counting (`baleshistory/useBalesHistoryModel.tsx:547-560`, `FactoryReprintLabels.tsx:165-180`, `bale-stock-entry/RemoveFromStockTab.tsx:159-209`, `FactoryBaleRelabeling.tsx:206`, `bale-stock-entry/StockEntryTab.tsx:840`, `WasteDispatch.tsx:244`, `wastedispatch/optimizedPrint.ts`); `window.print()` on the page (`FactorySheetsAndSacks.tsx:509`); server PDF via `window.open` (`FactoryLocationInventoryModel.tsx:716`); icon-only print (`FactoryLocationInventoryProductView.tsx:217`). `ErpReportPrintFooter` is unused.
    - The popup label-print routine (open window, write HTML, wait for images, print) is repeated in at least four files → one `printLabels()` helper. Size M, risk medium (label layouts are business-critical).

### D. Tables, pagination, filters

17. **Raw `<table>` vs shadcn `Table` for the same kind of list.** Raw: `PressingHistoryReport.tsx:596`, `PressingWorkerTotals.tsx:106`, `PressingHourlyTargets.tsx:338`, `FactoryStockQueryWorkspace.tsx:422,486,585,643`, `FactoryMonthlyProductionDrilldown.tsx:174,338,355`, `FactoryStockBaleList.tsx:107`, `FactoryReprintLabels.tsx:485`, `client/src/pages/StockEntryHistory.tsx:338,424,524`. shadcn: `GroundScan.tsx`, `DailyScan.tsx`, `BalesHistory.tsx`, `FactoryKpis.tsx`, `ProductionSummary.tsx`, `FactoryStockItemDetail.tsx`. Neither `ErpListTable` nor a column chooser/sort is used anywhere in scope.
    - Standard: `ErpListTable` (or shadcn `Table` + `ResponsiveDataList` on phones) for all lists; raw tables only for spreadsheet-grid (`FactoryStatusBuilder`) and print HTML. Size L, risk medium.

18. **Three hand-built pagers, no shared `PaginationBar`.** `BalesHistory.tsx:697` ("Page X of Y — N bales total" + chevrons), `FactoryMonthlyProductionDrilldown.tsx:385` (Prev/Next buttons), `PressingHistoryReport.tsx:690-693` ("Previous"), `wastedispatch/components/WasteBaleGroupTable.tsx:131-141`. Size S-M, risk low.

19. **Date filters: ~70 native inputs, one `PeriodFilter`.** Same From/To pair re-implemented in `FactoryKpis.tsx:126-146`, `FactoryWaste.tsx:172-190`, `ProductionComparison.tsx:410-435`, `ProductComparisonCharts.tsx:588-624`, `factorysheetsandsacks/components/MovementLog.tsx:129-136`, `ProductionTabPanel.tsx:116-124`, `PressingHistoryReport.tsx:400-435`; the only `PeriodFilter` is `wastedispatch/components/DispatchHistoryPanel.tsx`. Single-day pickers with prev/next chevrons are built three times (`BalesHistory.tsx:158-190`, `DailyScan.tsx:363-369`, `ProductionTabPanel.tsx:94-138`).
    - Standard: `PeriodFilter` for ranges, one `DayStepper` for single-day reports. Size M, risk low.

20. **Search boxes.** `SearchField` in `FactoryLocationInventoryLocationView.tsx`, `FactoryPriceList.tsx:340`, `FactoryProductionTargets.tsx`; hand-built absolute-positioned `Search` icon + `Input` elsewhere, e.g. `FactoryMonthlyProductionMatrix.tsx:423-432`, `FactoryMonthlyProductionDrilldown.tsx`, `FactoryReprintLabels.tsx`, `BaleProductImages.tsx`. Size S, mechanical.

21. **Native `<select>` next to shadcn `Select`.** `FactoryStockQueryWorkspace.tsx:216,227,238,249,386`, `PressingHistoryReport.tsx:449,466,496`, `FactoryWaste.tsx:232`, `production-raw-stock/MixBatchList.tsx:204`; sibling pages (`BalesHistory.tsx:193`, `GroundScan.tsx:668`) use shadcn. Size S-M, risk low.

22. **Clear/reset filter wording.** "Clear" (`BalesHistory.tsx:188`), "Clear filters" with `FilterX` (`FactoryStockQueryWorkspace.tsx:261`), "Start Over" with `RefreshCw` (`FactoryBaleRelabeling.tsx:266`), "Clear All" for data deletion (`GroundScan.tsx:758`). Most report filters have no reset. Size S.

### E. Actions, confirms, states

23. **Refresh action: four presentations, two icons.** Labelled outline with `RefreshCw` (`PressingHistoryReport.tsx:219`, `PressingWorkerTotals.tsx:94`, `RawStockRecalculate.tsx:105`); icon-only (`FactorySheetsAndSacks.tsx:513-522`, `PressingHourlyTargets.tsx:324`); text with no icon (`FactoryStockQueryWorkspace.tsx:263`); `RotateCcw` icon (`FactoryMonthlyProductionMatrix.tsx:383`) — which elsewhere means retry/undo (`ContinuousPressingScanner.tsx:442`, `LabelBannersSettings.tsx:370`). `RefreshCw` is also used for non-refresh actions: "Start Over" (`FactoryBaleRelabeling.tsx:266`), "Recompute Supplier Rates" (`RawStockRecalculate.tsx:93`), repack (`BalesHistory.tsx:657`), upload spinner (`FactoryPriceList.tsx:331`).
    - Standard: icon-only `RefreshCw` with tooltip in the header actions; `Loader2` for spinners. Size S.

24. **Destructive confirmation: four patterns, plus three unconfirmed deletes.**
    - `AlertDialog`: `GroundScan.tsx:744-758`, `FactorySheetsAndSacks.tsx`, `factorystatusbuilder/components/DeleteConfirmationDialog.tsx`, `productiontargets/ProductionBonusesPanel.tsx`.
    - Plain `Dialog` used as confirm: `baleshistory/components/BalesHistoryDialog1.tsx` ("Delete Bale"), `wastedispatch/OptimizedDialogs.tsx:46,125`, `FactoryWaste.tsx` (`setPendingDeleteId`, :354).
    - Shared confirm dialog: `bale-stock-entry/StockEntryTab.tsx` (4 references).
    - **No confirm**: `BaleProductImages.tsx:263` (`deleteMutation.mutate(img.id)`), `LabelBannersSettings.tsx:278`, `PriorityScanLoadingControl.tsx:350`.
    - Standard: one shared confirm (`ConfirmDialog`/`ConfirmHost`) for every destructive action. Size M, risk low.

25. **Row-action pattern.** Icon ghost buttons with `title` (`FactorySheetsAndSacks.tsx:672-702`, `production-raw-stock/RawStockTable.tsx:389-409`), tiny text buttons `h-6 text-xs` (`wastedispatch/components/DispatchHistoryPanel.tsx:236-255`), icon buttons without label (`BalesHistory.tsx:642-677`), "Tools" dropdown for page-level actions (`BalesHistory.tsx:214`). `ErpRecordAction` unused. Size M.

26. **Loading states: four styles.** `Skeleton` (`BalesHistory.tsx`, `FactoryPriceList.tsx:380`), `Loader2` + sentence (`FactoryKpis.tsx:182-185`, `FactoryMixOptimizer.tsx:104-107`), bare text with mixed ellipsis — "Loading…" (`DailyScan.tsx:439`, `FactoryReprintLabels.tsx:284`), "Loading access..." (`DailyProductionReport.tsx:93`), "Loading pages…" (`FactoryStatusBuilder.tsx:520`) — and a private `dailyproductionreport/components/SkeletonBox.tsx`. Only `FactoryStockBaleList.tsx:13` uses the shared `display-state` components.
    - Standard: `LoadingState`/`EmptyState`/`ErrorState`. Size M, mechanical.

27. **Empty states: plain `<p>` everywhere.** "No bales found" (`BalesHistory.tsx:362`), "No products found" as h3 (`FactoryPriceList.tsx:564`) vs p (`BaleProductImages.tsx:140`), "No dispatches yet." (`WasteDispatch.tsx:623`), `<tr><td colSpan>` (`PressingWorkerTotals.tsx:135`). Only `FactoryStockBaleList.tsx:100` uses `EmptyState`. Error states are mostly absent (pressing panels show inline text, `PressingHourlyTargets.tsx:331`).

28. **Toast wording.** Generic title "Error" 38 times in scope; "Export failed" (5) vs "Export Failed" (`useBalesHistoryModel.tsx:145`) vs "Excel export failed" (3) vs "Unable to export Excel" (1); "Upload failed" (3) vs "Upload Failed" (1); "Print Error" (2). Success toasts exist for some exports (`PressingHistoryReport.tsx:179`) and not others (`DailyScan.tsx:350`).
    - Standard: sentence-case "<Action> failed" + description; success toast for every export. Size S, mechanical.

### F. Formatting and display

29. **Bale status badge: five implementations, conflicting colours.** Shared `StatusBadge` via wrapper (`groundscan/components/StatusBadge.tsx`); solid-colour local `StatusBadge` where Sold = `bg-red-600`, same as Deleted (`DailyScan.tsx:74-80`); outline tinted map where Sold = blue (`bale-product-history/BaleHistoryStatusBadge.tsx:12-37`); `BALE_STATUS_COLORS` → Badge variant (`BalesHistory.tsx:464,597`); `STATUS_COLORS` class map (`client/src/pages/StockEntryHistory.tsx:553`); icon map (`FactoryBaleTracking.tsx:48`). Labels also differ: "Pending Loading" vs "Loading"; "Reserved" vs "Reserved for Order".
    - Standard: shared `StatusBadge` with one bale-status map. Size S-M, risk low.

30. **Number/money/date helpers re-declared per file.** `fmt`/`money` (`FactoryStockQueryWorkspace.tsx:75-76`), `fmt` (`FactoryStockItemDetail.tsx:63`), `fmtNum` (`FactoryBaleTracking.tsx:61`), `kg` (`FactoryMonthlyProductionDrilldown.tsx:46`), `formatKg` defined twice identically (`PressingHourlyTargets.tsx:33`, `PressingWorkerTotals.tsx:16`), `fmtKg`/`fmtMoney` defined in both `dailyproductionreport/utils.tsx:54-69` and `productioncomparison/utils.ts:69-83`, `money` defined three times in `productiontargets/` (`ProductionBonusesPanel.tsx:58`, `ProductionBonusHistoryPanel.tsx:24`, `ProductionBonusManualPaymentPanel.tsx:46`), `fmtDate` (`FactoryStockBaleList.tsx:29`, `factorysheetsandsacks/utils.ts:33`).
    - Standard: `@/lib/formatNumber`, `MoneyAmount`/`@/lib/moneyDisplay`, one date helper. Size M, risk low-medium (decimal places differ: 3 for kg in pressing, unverified elsewhere).

31. **KPI/stat card duplicated five times.** `factorylocationinventory/components/StatCard.tsx`, `productioncomparison/components/StatCard.tsx`, `productiontargets/PremiumKpiCard.tsx` (+`ProductionTargetKpiGrid.tsx`, `ProductionTargetSummaryTiles.tsx`), `production-raw-stock/KpiCards.tsx`, `dailyproductionreport/components/StatRow.tsx`, `bale-stock-entry/DailyStockSummary.tsx`; the mockup has a sixth (`FactoryLocationInventoryMockup.tsx:196`). Shared `StatCard`/`KPICard`/`FactoryKpiCard` appear only in `ProductionComparison.tsx` and `FactoryLocationInventoryProductView.tsx` (via local wrappers, unverified which base). Size M.

32. **Hard-coded palette colours and per-page CSS.** Highest counts: `FactoryPriorityScan.tsx` 59, `FactorySheetsAndSacks.tsx` 39, `productiontargets/ProductionBonusWeeklySheet.tsx` 37, `ProductionComparison.tsx` 32, `ProductionTabPanel.tsx` 30; primary buttons recoloured inline (`ProductionRawStock.tsx:288,297` blue and emerald, `FactorySheetsAndSacks.tsx:292` gradient). Nine page-specific CSS files in scope (`baleStockEntryModern.css`, `baleStockEntryRefresh.css`, `stockEntryApprovedDesign.css`, `factoryTrackingModern.css`, `balesExplorerModern.css`, `productionTargetsPremium.css`, `product-comparison-premium.css`, `production-overview-premium.css`, `FactoryLocationInventoryRedesign.css`). Each "premium" page therefore looks unlike its neighbour tab. Size L, risk medium (visual).

### G. Scanner screens

33. **Scanner layout and input are different on every scanning screen.**
    - Frame: only `bale-stock-entry/StockEntryScanner.tsx:5` uses `FactoryMobileScannerPanel`/`FactoryMobileStatus`; `GroundScan.tsx`, `DailyScan.tsx`, `FactoryPriorityScan.tsx`, `WasteDispatchOptimized.tsx`, `PressingMachineManagement.tsx` each hand-build the panel.
    - Camera: `MobileBarcodeScanner` in Ground/Daily/Priority/Stock Entry/Waste; a separate decoder stack in `ContinuousPressingScanner.tsx:7-8`.
    - Placeholder text: "Scan ref code / barcode..." (`GroundScan.tsx:704`), "Scan bale ref code / barcode…" (`DailyScan.tsx:419`), "Scan bale or priority product barcode..." (`PressingMachineManagement.tsx:255`), "Scan code or type product name..." (`StockEntryScanner.tsx:112`), "REF123456 + Enter" (`WasteDispatchOptimized.tsx:102`), "Manual barcode entry" (`ContinuousPressingScanner.tsx:448`), translated key (`FactoryPriorityScan.tsx:453`).
    - Enter handling is inlined each time (`GroundScan.tsx:703`, `DailyScan.tsx:418`, `PressingMachineManagement.tsx:258`).
    - Feedback: sound/vibration toggles only in `ContinuousPressingScanner.tsx:2`; others rely on toasts or inline badges (unverified in detail).
    - Standard: one `ScanInputPanel` (input + camera button + last-scan status + sound) on top of `FactoryMobileScannerPanel`. Size L, risk medium-high (floor workflow, offline queue).

34. **Scanner list exports differ for near-identical data.** `GroundScan.tsx:737` "Export Verification" with busy state; `DailyScan.tsx:405` "Export" with none; pressing "Export Excel" hidden unless history is expanded and not in simple mode (`PressingHistoryReport.tsx:552`); priority scan and waste scan have none.

### H. i18n and permissions

35. **Translation coverage is per-file, so a single hub mixes languages.** Translated: `FactoryPriorityScan.tsx` (43 calls), `FactoryProductionTargets.tsx` (57), `FactoryMonthlyProductionMatrix.tsx` (63), `productiontargets/ProductionBonusCheckoutPanel.tsx` (62). Hard-coded English: every other tab of `BaleStockEntry` (`:168-187`), `FactoryMonthlyProductionDrilldown.tsx` (child of the translated matrix; titles at :98, :267), `FactoryKpis.tsx`, `BalesHistory.tsx`, all pressing panels. Inside the translated matrix "Export Excel"/"Exporting…" is still literal (`FactoryMonthlyProductionMatrix.tsx:392`). Size L.

36. **Permission gating style.** Hidden-key arrays from `my-access` (hubs), `useFactoryNavigationAccess` (`DailyProductionReport.tsx`, `FactoryOthers.tsx`), `recordChanges.allowed` from `factoryRecordChangeAccess.ts` (`FactoryWaste.tsx:350`, `FactoryPriceList.tsx:322`, `ProductionRawStock.tsx:284`), inline role string checks (`FactoryOthers.tsx:26`, `FactoryBaleTracking.tsx:118`, `BaleStockEntry.tsx:74`), route-level role checks (`client/src/components/FactoryRoutes.tsx:188-191`). No `Can`/`useCan` in `factory/`. Not necessarily wrong, but four idioms. Size M, risk high — leave until a dedicated pass.

## Duplicates / dead candidates

| Item | Evidence | Suggestion |
|---|---|---|
| `WasteDispatch.tsx` (778 lines) | Superseded by `WasteDispatchOptimized.tsx`, which `FactoryRoutes.tsx:127` routes. Legacy file is referenced only by `lazyPages.ts:217` (`WasteDispatchPage` export, not imported by `FactoryRoutes`) and `lib/offlinePrep.ts`. Drags `wastedispatch/components/WasteDispatchDialogs.tsx` (256 lines) and most of `wastedispatch/types.ts` with it. | Dead candidate; confirm `offlinePrep` preloading then delete. |
| `wastedispatch/OptimizedDialogs.tsx` vs `wastedispatch/components/WasteDispatchDialogs.tsx`; `optimizedTypes.ts` vs `types.ts` | Two dialog sets with the same three dialogs (confirm disposal, delete, print). | Keep the Optimized set. |
| `FactoryLocationInventoryMockup.tsx` (661 lines) | Routed at `/factory/location-inventory-mockup` and registered (`shared/factoryAccessRegistry.ts:554`, developer); sample data only (:28), Export/Print/Refresh buttons have no handlers (:307-315). | Remove route, registry entry and file. |
| `FactoryRawMaterialsHub.tsx` | 5-line pass-through; `/factory/raw-materials` and `/factory/raw-stock` render the same page. | One route, redirect the other. |
| Double routing of the same component | `BalesHistory` (`/factory/bales-history` + hub tab), `FactorySheetsAndSacks` (`/factory/sheets-sacks` + Overview tab), `FactoryMonthlyProductionMatrix` (own route + Overview tab), `ProductionComparison` (`/factory/production-comparison` + Others tab). `/factory/production-summary` already redirects into its hub — the others do not. | Redirect standalone routes to the hub tab, as done for production-summary. |
| Unused lazy exports | `lazyPages.ts:155` `ProductionSummary`, `:212` `FactoryMixOptimizer`, `:213` `FactoryWaste`, `:217` `WasteDispatchPage` — not in the `FactoryRoutes.tsx` import list (hub imports them directly). | Remove (check `routes/ErpRoutes.tsx` first — unverified). |
| `bale-product-history/FactoryBaleProductAllMonths.tsx` (340) vs `FactoryBaleProductMonthDetail.tsx` (372) | Same header (h1 + back), same table, same "Correct weight" action (:216/:254), same status `Select` with identical items (:159/:184). | One component with an optional `month` param. |
| `FactoryMonthlyProductionDrilldown.tsx` Workers vs Bales | Two pages in one file sharing header/back/search scaffolding (:98, :267). | Extract shared drill-down frame. |
| `productcomparison/` vs `productioncomparison/` | Two folders one letter apart with separate `utils.ts` (date range, formatters). | Merge utils; rename one folder. |
| `baleshistory/components/BalesHistoryDialog1..5.tsx` | Numbered names for Delete / Repack / Label design / Export register / (5 unverified). | Rename by purpose; Delete → shared confirm. |
| Hub-tab hiding boilerplate | Finding 7. | `FactoryHub` component. |
| Popup label-print routine | Finding 16. | One helper. |
| `formatKg`, `money`, `fmtKg`, `fmtMoney` copies | Finding 30. | Shared helpers. |
| `PriorityScanLoadingControl.tsx` | Imported only by `FactoryPendingLoadings.tsx` (outside this scope) — in use, not dead. | — |

## Quick wins

1. Rename `WipersReEntry.tsx:785` "Export CSV" → "Export Excel" (and handler/testid).
2. Add confirm before delete in `BaleProductImages.tsx:263`, `LabelBannersSettings.tsx:278`, `PriorityScanLoadingControl.tsx:350`.
3. Fix `MergeBaleProducts.tsx:101,138,337` back target `"/settings"` → `/factory/settings` (verify intended destination).
4. Remove `<h1>Bales</h1>` duplication (`BalesHistoryOverview.tsx:41`) and rename the first Bales-hub tab (e.g. "History") so hub title ≠ tab label.
5. Give `FactoryProductionIntelHub` and `FactoryImport` a `PageHeader` like the other hubs.
6. Normalise tab-trigger icon spacing and add `data-[state=inactive]:hidden`/padding consistently across the five hubs.
7. Swap `RotateCcw` → `RefreshCw` in `FactoryMonthlyProductionMatrix.tsx:383`; add the icon to `FactoryStockQueryWorkspace.tsx:263`; stop using `RefreshCw` for "Start Over" and as an upload spinner.
8. Unify export icon to `Download` and label to "Export Excel" / "Export CSV" in the ~12 buttons listed in finding 12; make the two icon-only buttons in `FactoryLocationInventoryProductView.tsx:217-237` labelled like the sibling view.
9. Add date/filter range to CSV file names (finding 14) and a BOM to `ProductionComparison.tsx:380`.
10. Toast titles to sentence case ("Export failed", "Upload failed"); replace bare "Error" titles where the action is known.
11. Replace the 10 native `<select>` with shadcn `Select`; replace hand-built search boxes with `SearchField`.
12. Use the `subtitle` prop in `FactoryReprintLabels.tsx:254` and `FactoryStockItemDetail.tsx:118`; humanise "IN_STOCK Bales" (`FactoryStockBaleList.tsx:77`).
13. Translate the literal "Export Excel"/"Exporting…" in `FactoryMonthlyProductionMatrix.tsx:392`.
14. Delete `FactoryLocationInventoryMockup.tsx` + route + registry entry; delete legacy `WasteDispatch.tsx` + its dialogs after checking `offlinePrep`.
15. Remove the four unused `lazyPages.ts` exports.
16. URL-back the tabs of `FactoryImport`, `FactoryKpis`, `FactorySheetsAndSacks`, `RawStockRecalculate` with `useHubQueryState`.

## Bigger refactors

1. **`FactoryHub` component** — one hub shell (PageHeader, URL tabs with key `tab`, hidden-key filtering, loading/no-tabs states, lazy mount) replacing the six hand-written hubs; embedded panels get an `embedded` mode that suppresses their own h1 (findings 2, 6, 7, 10). M-L, medium risk (permissions, the pinned production-session query in `BaleStockEntry`).
2. **Export standardisation** — adopt `ErpReportExportMenu` in the header action slot; one CSV helper, one "download from API" helper with busy/toast handling, one file-name builder; then add exports to the ~15 report screens that have none (findings 11-15). L, medium risk.
3. **Shared scanner panel** — `ScanInputPanel` on `FactoryMobileScannerPanel` for Ground/Daily/Priority/Pressing/Waste/Stock Entry, with one placeholder, one Enter handler, one feedback model; decide whether pressing's continuous decoder becomes a mode of `MobileBarcodeScanner` (finding 33). L, medium-high risk.
4. **Report filter bar** — `PeriodFilter` + `DayStepper` + `SearchField` + shadcn `Select` + "Clear filters" as one `ReportFilters` row used by KPIs, Waste, Comparison, Product Comparison, Movement Log, Pressing history, Production overview, Bonus panels (findings 19-22). M-L, low risk.
5. **Tables and pagination** — move raw tables to `ErpListTable`/shadcn `Table` with `PaginationBar`, right-aligned numerics, totals row and phone fallback; start with pressing panels, Stock Query, monthly drill-downs, Stock Entry History (findings 17-18). L, medium risk.
6. **Page frame migration** — all routed pages onto `ErpPage`/`PageShell`+`PageHeader` with `PageActions`; retire the hand-built hero headers and fold the nine page-specific CSS files into theme tokens/variants (findings 1, 3, 32). L, medium visual risk.
7. **Bale status + formatting kit** — one bale status map on shared `StatusBadge`; shared kg/count/money/date formatters; one KPI card (findings 29-31). M, low risk.
8. **Label printing helper** — single `printLabels({format, bales})` used by Bales History, Reprint Labels, Remove From Stock, Relabeling, Wipers Re-Entry, Stock Entry (finding 16). M, medium risk.
9. **Confirm + state components** — shared confirm dialog for every destructive action; `LoadingState`/`EmptyState`/`ErrorState` everywhere (findings 24, 26, 27). M, low risk.
10. **i18n pass** — bring the English-only tabs of Stock Entry, pressing panels, drill-downs and report panels to the same translation mechanism used by Production Targets / Priority Scan / Monthly Matrix (finding 35). L, low risk.
