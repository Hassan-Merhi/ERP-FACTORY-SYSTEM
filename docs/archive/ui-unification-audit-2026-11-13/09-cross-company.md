# 09 — Cross-company-type & shared-infrastructure comparison

Scope: `client/src` (1,966 non-test ts/tsx files; 1,048 tsx under `pages/`). Read-only audit.
Method: shells/sidebars/hooks read in full; every page variant in Part 2 opened or profiled with the same grep profile
(page file + its sub-component folder); Part 3 counts are `grep -rE` over `client/src`, tests excluded.
Counts are regex counts (files / occurrences) — treat as ±5 %, not exact. Paths are relative to `client/src/`.
Area keys in count tables: `erp` = `pages/*` root + root sub-folders, `fac` = `pages/factory`, `pos`, `ret`(ail), `prop`(erties), `sp`, `set`(tings), `pay`(roll), `cmp` = `components/`.

---

## Part 1 — Shells & navigation

### 1.1 Shell matrix

| Capability | ErpShell (`app/ErpShell.tsx`) — erp, retail, supplier_partner | FactoryShell | PropertiesShell | PosShell |
|---|---|---|---|---|
| Sidebar | `AppSidebar` (shared `sidebar/sidebarPrimitives`) 16rem | `FactorySidebar` (same primitives) 16rem | `PropertiesSidebar` (same primitives) 16rem | **Inline hand-built `<Sidebar>`** in the shell (PosShell.tsx:121-267), 14rem, own CSS `styles/pos-sidebar-modern.css` |
| Top bar | `AppTopBar` + `simplifyMobileNavigation` (ErpShell:98-104) | `AppTopBar` (FactoryShell:113-118) | `AppTopBar` (PropertiesShell:68-73) | **Own `<header data-slot="pos-top-bar">`** (PosShell:270-352) |
| Accent | `MODULE_ACCENT.erp` token | `MODULE_ACCENT.factory` | `MODULE_ACCENT.properties` | hard-coded `"#8b5cf6"` (PosShell:350) |
| Search trigger text | "Search modules, transactions, reports..." (AppTopBar:107) | same | same | "Search anything..." (PosShell:340), only if admin |
| Command palette | yes, `hasErpAccess` | yes, `hasFactoryAccess` | yes, `hasPropertiesAccess` | only when `canUseAdminSearch` (PosShell:375) |
| Mobile bottom nav | **`ErpMobileBottomNav` + lazy `ErpMobileNavSheet`** (ErpShell:133-146) | none (sidebar sheet) | none | none |
| Sidebar toggle on phone | hidden (bottom-nav "More" replaces it) | shown | shown | shown |
| Company selector | top bar (centre on phone) | top bar | top bar | **sidebar footer** (PosShell:249) |
| Theme toggle / Currency toggle | top bar / workspace controls | same | same | sidebar footer |
| Notifications centre | yes (`MobileWorkspaceControls`) | yes | yes | **no** |
| User menu | top bar `UserMenu` + sidebar `ModuleFooter` | same | same | top bar `UserMenu` + custom footer avatar + separate logout icon |
| Pinned (drag-reorder) + Recent nav | yes (`usePinnedOrder("erp-pinned-order")`, `useRecentNav`) | yes | yes | no (flat "Workspace" + collapsible "More tools") |
| Shell-level Back button | no (page-level `PageHeader`) | no | no | **yes, in sidebar header** (PosShell:131-140, `handleGoBack`) |
| `PhoneSheetDialogs` (dialogs → bottom sheets on phone) | yes | yes | yes | **no** |
| `AppModeProvider` | `erp` | `factory` | `properties` | **none** |
| `useDocumentAppShell`, `useVisualViewportMetrics`, `useScrollOverflowProbe` | all three | all three | all three | **none of the three** |
| `ReadOnlyRoleRouteGate` | yes | yes | yes | no |
| View-only / create-only banner | yes, hard-coded English (ErpShell:76-97) | no | no | no |
| `DailyRateModal` | yes (skipped for read-only roles) | yes (not skipped) | **no** | yes |
| Workspace CSS guard list (`[&_button]:touch-manipulation`, 44px inputs…) | no (uses `erp-mobile-operations.css`) | `factoryWorkspaceClasses` (FactoryShell:57-72) | none | `posWorkspaceClasses` (PosShell:50-69) — near-copy of the factory list |
| Theme CSS | `styles/erp-unified-theme.css` | `styles/factory-unified-theme.css` | `styles/properties-unified-theme.css` | `styles/pos-sidebar-modern.css` |
| Content padding | `p-3 sm:p-6` | `p-3 pb-[max(.75rem,safe-area)] sm:p-6` | `p-3 sm:p-6` | `p-3 pb-[safe] sm:p-6` or full-height |
| Shell i18n | `t()` for skip-link + main aria-label | skip-link only; `aria-label="Factory and inventory workspace"` literal | skip-link only; literal aria-label | skip-link only; all nav labels literal ("Workspace", "More tools", "POS user", "Go back") |

**What each company type gets / does not get**
- **erp / retail / supplier_partner** share ErpShell. Retail and SP are *not* shells: retail pages are an `if (location === …)` chain in `routes/AppRoutes.tsx:40-70` and bring their own in-page `RetailNav` (below); SP adds sections to `AppSidebar` (AppSidebar.tsx:129-138).
- **factory**: no phone bottom nav; extra floating controls (`FactoryCatalogLanguageSwitch`, `FactoryMhdViewToggle`) injected above every route (FactoryShell:128-129).
- **properties**: no bottom nav, no DailyRateModal, shortest utility list (Help & Training, My Settings, Settings — no Chat / Conflicts / IC links).
- **POS**: a separate product visually — own sidebar, own top bar, no notifications, no pinned/recent, no phone-sheet dialogs.

**Sidebar utility block (bottom links)** — same primitives, different content/order:
| | ERP | Factory | Properties | POS |
|---|---|---|---|---|
| Help & Training | `/help-training` | `/factory/help-training` | `/properties/help-training` | `/help-training` (tools group) |
| Chat | `/chat` | `/factory/chat` | — | `/pos-chat` |
| Conflicts | `/conflicts` | `/factory/conflicts` | — | — |
| My Settings | `/my-settings` | `/my-settings` (unprefixed) | `/properties/my-settings` | `/my-settings` |
| Settings | `/settings` | `/factory/settings` | `/properties/settings` | `/pos-settings` |
| Extra | IC Requests, IC Links | Accounting Toolbox, Spreadsheet, Intel Settings | (Accounting Toolbox is a *section*, not a utility link) | — |
| Header tagline | "Business OS · ERP / Warehouse" | "Business OS · Factory / Production" | "Business OS" | wordmark "Dakzo Systems" + `ModuleIdentity` |

**RetailNav** (`pages/retail/RetailNav.tsx`): a pill "switcher" with exactly **one** link ("Inventory"), built from raw `<button>`s, rendered on 5 pages (RetailDashboard:302, RetailSalesHistory:120, RetailStockCount:248, and the two retired pages RetailQuickAdd:325 / RetailStockOperations:334 whose routes redirect — AppRoutes.tsx:49-52). It is a second, in-page navigation layer that no other company type has.

### 1.2 Back / Escape / breadcrumbs

| Mechanism | Where | Notes |
|---|---|---|
| `PageHeader` built-in Back (`showBackButton` default true; hides itself if it detects a manual back button via MutationObserver — PageHeader.tsx:81-110) | 153 files use `PageHeader` | ERP mode = history-first (`goBackToPreviousErpLocation`), Factory/Properties = deterministic `getParentRoute` (hooks/use-back-to-parent.ts:15-28) |
| `lib/parent-routes.ts` registry | factory (hand-written regex list, lines 7-65) + properties (delegates to `properties/config/propertiesNavigation`) + ERP fallback | no POS / retail entries |
| `useEscapeToParent` / `useEscapeBack` | 26 / 17 files: root ERP pages 18, `pages/factory` 16, **pos 0, retail 0, properties 0, sp 0, settings 0** | Esc-goes-back exists only in ERP + Factory |
| `useBackToParent` called directly | 16 files (10 root ERP pages) | |
| Raw `window.history.back()` | 10 files (5 root ERP pages) | bypasses both strategies |
| Manual `<ArrowLeft>` back buttons | 99 files import `ArrowLeft`, 22 `ChevronLeft`; 37 files pass `onBack=` | the PageHeader observer exists precisely because of these |
| Breadcrumbs | 3 files mention "Breadcrumb" — only `pages/location-inventory/LocationInventoryBreadcrumb.tsx` is a real one | no shared breadcrumb component |
| POS | shell-level Back arrow in the sidebar header (PosShell:131) + pages' own | third pattern |

Divergences without an evident reason:
1. Back semantics differ by mode (ERP history-first vs Factory/Properties parent-first) — documented in the hook, but the same shared page (`Vouchers`, `Daybook`, `LedgerVouchers`) therefore behaves differently depending on the shell it is mounted in.
2. Factory parent routes themselves mix URL conventions: `/factory/payroll-hub?section=employees` (parent-routes.ts:9) vs `/factory/invoicing?tab=invoices` (parent-routes.ts:21).
3. Esc-back absent from POS/retail/properties/SP/settings.
4. PosShell skips 6 shell behaviours the other three share (table above) — it predates the unification and was never brought in.

---

## Part 2 — Equivalent pages across company types

Legend: PH = `@/components/PageHeader`; h1 = hand-rolled heading; ERM = `ErpReportExportMenu`; xh = `lib/excelHelper`; srv = server endpoint via `window.open`/fetch; RTP = `react-to-print`.

### 2.1 Dashboard

| Variant (route) | Header | KPI component | Table | Filters | Loading / empty / error | Actions |
|---|---|---|---|---|---|---|
| `pages/Dashboard.tsx` (`/financial-overview`; also has an `isFactoryMode` branch, l.62-63, 105, 174) | PH "Dashboard" / "Factory Dashboard" | local `DashboardKPICard` (`pages/dashboard/components`) + shared `KPICard` in `FactoryProductionPanel` | none | none | value text `"Loading..."` inside the card (l.180,193); `ErrorState` banner (l.68-71) | "Quick actions" dropdown (l.98) |
| `pages/factory/FactoryDashboard.tsx` (`/factory/intelligence/dashboard`, lazy name `FactoryDashboardIntel`) | PH "Factory Dashboard" / "Production overview and operations" | `FactoryKpiCard` ×6 | shadcn `Table` ×2 | 1 native `type="date"` | `LoadingSkeleton variant="kpi-grid"` (l.146) — the **only** user of `LoadingSkeleton` in the repo | 1 Button |
| `pages/pos/POSDashboard.tsx` (`/pos-dashboard`) | PH "POS Dashboard" | hand-rolled `Card`s | shadcn `Table` | none | `Skeleton` ×4; `ErrorState`-style banner (l.270); "No shift history found" text | Start/End shift, 4 tile buttons `h-20` |
| `pages/properties/PropertiesDashboard.tsx` (`/properties/dashboard`) | PH "Dashboard" `showHomeButton={false}` (deprecated no-op prop, l.277) | `KPICard` ×3 | none | none | `"Loading..."` in card + `<p>Loading...</p>` (l.321); "No accounts added yet" | add-account popovers |
| `pages/retail/RetailDashboard.tsx` (`/retail/reports`) | **`<h1 class="text-2xl font-bold">`** (l.307) + `RetailNav` | local `SummaryCard` ×8 (defined l.111) | raw `<table>` ×2 | native `type="date"` ×2 + native `<select>` | text "Loading retail reporting…" (l.461) | "Refresh" (RefreshCw) |
| `pages/sp/SpOverview.tsx` (`/sp`) | **`<h1 class="text-2xl font-semibold">`** (l.125) | none (navigation cards) | cards | none | `Loader2` + "Loading sales…" | row "Reverse" |

Two files both render a page titled **"Factory Dashboard"**: `Dashboard.tsx` in factory mode and `FactoryDashboard.tsx`. `PropertiesDashboard.tsx` is a 760-line fork of `Dashboard.tsx` (identical "Total Income / Net Position / Import Cycle Balance" cards, Dashboard:179-217 vs PropertiesDashboard:283-302).
**Standard:** PH + shared `StatCard` family + `page-state` skeleton. **One component?** Yes for ERP/Properties (config: which panels); Factory/POS/Retail keep their own body but should share header, KPI card and state primitives. S–M each.

### 2.2 Daybook

| Variant | Header | Tabs | Export | Table | Filters | States | Create action |
|---|---|---|---|---|---|---|---|
| `pages/Daybook.tsx` (+`pages/daybook/`, 4.6k lines) — `/daybook`; **also Properties** via 5-line wrapper `PropertiesDaybook.tsx` | PH "Daybook" + icon, `showBackButton` | shadcn `Tabs`: "Transactions" / "Edits & Activity" (l.698-699), default styling | **ERM** "Export" ▸ "Summary" / "Detailed" (l.662-678); file `erpReportFileName("Daybook","xlsx")` (`daybook/exportDaybook.ts:32`) | `ErpListTable` + `Table`; `PaginationBar` (l.809) | `PeriodFilter` + SearchField-less ad-hoc input "Voucher # or description..." + shadcn Select; Clear | `Skeleton`; "No transactions found for the selected period and filters." | "New Voucher" (Plus) in header |
| `pages/factory/FactoryDaybook.tsx` (+`factory/daybook/`, 4.2k lines) — `/factory/daybook` | PH "Factory Daybook" | shadcn `Tabs`, same two labels, but **re-skinned inline** (`data-[state=active]:bg-blue-600`, l.112-125) | hand-built `DropdownMenu`, **`FileDown`** icon, "Export" ▸ "Summary Export" / "Detailed Export (with entries)" (l.74-95); xh `writeFile`; file `FactoryDaybook_yyyy-MM-dd.xlsx` (`factoryDaybookExports.ts:49,138`) | **raw `<table>` ×9**, no pagination | `PeriodFilter` + prev/next-day arrows + input "Search..." | "Loading…" text ×8, `ErrorState`; "No transactions found" | none |
| `pages/pos/POSDaybook.tsx` (845 lines) — `/pos-daybook`; also a tab of ERP `SalesToolsHub` | **`<h1>`** (l.317) | none | none (per-row "Print" receipt via RTP) | shadcn `Table` + raw `<table>` (print) | `PeriodFilter` + prev/next-day arrows + input "Search transactions..." | `Skeleton`; "No transactions found" / "No matching transactions" | "New sale" CTA in empty state |

**Standard:** `Daybook.tsx` (ERM, ErpListTable, PaginationBar). FactoryDaybook is the same information architecture rebuilt by hand; converging it means a shared frame (header + ERM + tab strip + filter bar) with a factory row renderer. L, medium risk (different data model). POSDaybook: adopt PH + shared filter bar. S.

### 2.3 Accounts / Ledger — already unified (good reference)

| Route | File | Reality |
|---|---|---|
| `/accounts` | `Accounts.tsx` (11 lines) → `AccountsLegacy.tsx` (481) + `accountslegacy/` + `accounts/` (6.8k lines) | the real page is the file named *Legacy* |
| `/factory/accounts` | `FactoryAccounts.tsx` (14) → `<FactoryRelatedLinks/>` + `<Accounts/>` | wrapper |
| `/properties/accounts` | `PropertiesAccounts.tsx` (5) → `<Accounts/>` | wrapper |
| `/ledger-monthly/:id`, `/factory/ledger-monthly/:id` | `LedgerMonthlySummary.tsx` routed directly (FactoryRoutes.tsx:327) | no wrapper |
| `/properties/ledger-monthly/:id` | `PropertiesLedgerMonthly.tsx` (5) → `<LedgerMonthlySummary/>` | wrapper |
| `/ledger-vouchers/…` (+factory direct, FactoryRoutes:328) / properties | `LedgerVouchers.tsx` / `PropertiesLedgerVouchers.tsx` (5) | wrapper |

Inside the shared page the *statement* view still mixes icons for the same job: `FileDown` ×3, `FileSpreadsheet` ×2, `FileText` ×4, and exports go through `window.open("/api/accounts/statement/export-excel?…")` (`accounts/AccountStatementView.tsx:264,281,289`) rather than ERM. `LedgerMonthlySummary` / `LedgerVouchers` have PeriodFilter but **no export at all**.
Inconsistent wrapper policy: Factory routes the shared ledger pages directly while Properties adds 5-line pass-through files (4 of them) — pick one.

### 2.4 Vouchers list — unified
`/vouchers` → `Vouchers.tsx`; `/factory/vouchers` → `FactoryVouchers.tsx` (5-line wrapper); `/properties/vouchers` → `PropertiesVouchers.tsx` (5-line wrapper); POS `/vouchers` routes `<Vouchers posUser>` directly (PosRoutes.tsx:77). `Vouchers.tsx` uses `useHubQueryState` ×2 and a custom `vouchers/VoucherTabNav` rather than `Tabs`. No list-level export. Nothing to merge; only the wrapper-vs-direct policy.

### 2.5 Customers

| Variant | Header | Primary action | Export / print | Table | Filters | States | Delete confirm |
|---|---|---|---|---|---|---|---|
| `pages/Customers.tsx` (778) `/customers` | PH "Customers" / "Manage customer accounts and receivables", `showBackButton={false}` (l.347) | **"New Customer"** (Plus) → dialog "Create New Customer" | none for list; per-row "Print Invoice" via `window.open('/api/pos/invoice/…/pdf')` (l.683) | `ErpListTable` + `Table`; cols Customer / Balance | `ErpListFilters` | `Skeleton` ×9; "No customers found" | — |
| `pages/factory/FactoryCustomers.tsx` (764) `/factory/customers`, tab of `FactoryPartiesHub` | PH "Customers" (error state only, l.300) **and** `<h1>` (l.386) for the normal state | **"Add Customer"** (l.417) | CSV: manual `Blob("text/csv")` + `downloadBlob(…, "factory-customers.csv")` (l.284), `Download` icon | `Table` + `PaginationBar` (l.660) + `TableViewOptions` | ad-hoc input + shadcn Select; "Refresh customers" icon | `Skeleton`; `ErrorState`; "No customers yet" | `ConfirmDialog` "Delete Customer" (l.748) |
| `pages/pos/POSCustomers.tsx` (587) `/pos-customers` | PH "Customers" / "Manage customer accounts" (l.124) | **"New Customer"** → "Create New Customer" | statement "Print" via RTP (`Printer`), `FileDown` | `Table` + raw `<table>`; cols Customer Name / Phone / Balance / Side | ad-hoc input | `Skeleton`; "No customers found" / "No customers yet" | — |

The create dialogs of ERP and POS are the same form duplicated (same placeholders "+1234567890", "0.00", "Select side": Customers.tsx:268-308 vs POSCustomers.tsx:161-199).
**Standard:** ERP shell (PH + ErpListFilters + ErpListTable) + Factory's pagination/column chooser/CSV → via ERM. **One component?** Yes: `CustomersDirectory` with config `{columns, canExport, createLabel, statementRenderer}`; factory keeps destination/price-list extras. M, low-medium risk.

### 2.6 Suppliers

| Variant | Header | Tabs | Primary action | Table | Filters | States |
|---|---|---|---|---|---|---|
| `pages/Suppliers.tsx` (444, + `suppliers/`) `/suppliers` | PH "Suppliers" / "Manage supplier accounts and track container shipments" | shadcn `Tabs` ×2 triggers | none ("Create suppliers in the Master Data page", l.281) | `Table` | `ErpListFilters` + `use-debounce` | `Skeleton` ×14; "No suppliers found" |
| `pages/factory/FactorySuppliers.tsx` (7 lines → `factory-suppliers/`, 5.4k lines) | **`<h1>`** ×2, no PH | none | "Add Supplier" / "Add Linked Supplier" (`FactorySuppliersDirectory.tsx:90,392`) | `Table` ×4 | input "Search suppliers...", native `type="date"` ×4, Select ×7 | `PageState "No suppliers found"`; `toFixed` ×31, `toLocaleString` ×15 |

Different domain depth (factory = brokers, FX pools, multi-currency statement), so not one component; unify header, search, empty state and money formatting. M.

### 2.7 Containers / tracking

| Variant | Mounted at | Title | Export / import | Table | Filters | States |
|---|---|---|---|---|---|---|
| `Containers.tsx` (+`containers/`, 2.0k) | ERP `InventoryHub ?tab=containers` via **5-line `ContainersPage.tsx`** alias | PH **"Container Tracking"** (l.91) | toolbar "Export" ×2 + "Add" (`ContainerToolbar.tsx:38,45,74`); files `containers.xlsx`, `containers_full_export_<date>.xlsx`, `otw_containers.xlsx`, `container_import_template.xlsx` (`useContainerImportExport.ts:39-110`) | custom grid (no `Table`) | `SearchField` "Search by container number..." | Skeleton, `AlertDialog` |
| `GITContainers.tsx` (+`git-containers/`, 3.3k) | ERP `/` and `TrackingHub ?tab=containers-otw` | PH **"Containers OTW"** ×3 copies (l.323,336,368) | `Download`, `FileSpreadsheet`, `Upload`; `window.print()` (l.579) | `Table` | ad-hoc input, native date ×5, native `<select>`, Select ×7 | Skeleton, Loader2 |
| `GITMockup.tsx` (+`git-mockup/`, 3.8k) | **production** `TrackingHub ?tab=git-tracking` | PH (embedded) | — | raw `<table>` ×9 | native `<select>` ×3 | Skeleton |
| `FactoryContainers.tsx` (+`factory-containers/`, 4.4k) | `/factory/containers`, `/factory/containers-hub` (14-line "hub" = RelatedLinks + page) | PH **"Factory Containers"** / "Track incoming containers (separate from ERP containers)" | xh; "Import Containers from Excel" dialog | `Table` ×3 + `TableViewOptions` | Select ×17, native date ×4 | "No factory containers yet" |
| `FactoryContainerTracking.tsx` (174) | section of `FactoryProductionIntelHub` | none | none | `Table` | input "Search container, customer, invoice…" | Skeleton |
| `FactoryOtwTrackingTab.tsx` (713), `FactoryShippingContainers.tsx` (797) | factory hubs | — | CSV tools (`useOtwCsvTools.ts:115`) | — | — | local `SummaryCard` |
| `POSContainerTracking.tsx` (704) | POS `/` and `/pos-containers` | **`<h1 class="pos-containers-title">Containers OTW`** (l.329) | none | `Table` | input + Select ×5, native date | Skeleton, Loader2 |

Three "Containers OTW" screens (GITContainers, POSContainerTracking, Factory OTW tab) and two "container list" screens (Containers, FactoryContainers) with five different search placeholders. A page named `GITMockup` is live production UI. `ContainersPage.tsx` and `FactoryContainersHub.tsx` are pass-throughs.
**Standard:** GITContainers' data model + ErpListTable/ERM. **One component?** POSContainerTracking is a read-only projection of GITContainers → yes (config: `readOnly`, visible columns). Factory containers differ in workflow → share toolbar/filter/table primitives only. L.

### 2.8 Price list

| | `factory/FactoryPriceList.tsx` (587) | `pos/POSPriceList.tsx` (+`pospricelist/`, 1.9k) |
|---|---|---|
| Header | PH "Factory Price List" / "Set selling prices for bale products." (l.306) | PH "Price List" (`PriceListToolbar.tsx:24`) |
| Template button | "Download Template" / "Template" (phone) — `Download` icon (l.320) | "Template" — `Download` |
| Import button | `Upload` icon | "Upload" — `Upload` + `FileSpreadsheet` |
| Export | exceljs `wb.xlsx.writeBuffer()` + `downloadBlob`, **`factory_price_list_<date>.xlsx`** (l.217-221) | `XLSX.writeFile` (xh), **`price_list_<location><filters>_<date>.xlsx`**, template `price_list_template_<date>.xlsx` (`usePosPriceListModel.ts:478,639`) |
| Search | `SearchField` "Search..." | ad-hoc input "Search by name or code…" |
| Filters | Select "All Categories" | Select "All groups" + `PeriodFilter` ×2 |
| Empty | "No products found" | `page-state` |
| Refresh | `RefreshCw` ×3 | — |

Same workflow (template → upload → grid edit → export). **One component?** Yes — `PriceListWorkspace` with a column/key config. M.

### 2.9 Location inventory

| Variant | Header | Export / print | Table | Search | States |
|---|---|---|---|---|---|
| `LocationInventory.tsx` (+`location-inventory/`, 6.2k) — ERP hub tab + POS `/location-inventory` | PH "Location Inventory" (`LocationInventoryHeader.tsx:204`) + the repo's only breadcrumb | srv PDFs `<loc>_Godown_<date>_with_cost.pdf`, xlsx `<loc>_inventory_<date>.xlsx` (`useLocationInventoryExports.ts:27-80`); `Printer` ×5 | raw `<table>` ×6 + mobile records | `SearchField` | Skeleton ×6, **Loader2 ×12**, AlertDialog ×2 |
| `FactoryLocationInventory.tsx` (+3 sibling files + 2 folders, 3.1k) | **`<h1>`** ×2, own CSS `FactoryLocationInventoryRedesign.css` | icon-only buttons `title="Export Excel"`, print via RTP; `FileSpreadsheet` ×3, `FileText` ×3 | raw ×3 + `Table` ×2 | `SearchField` "Search locations...", ad-hoc "Search product or article code..." | Skeleton ×7; "No products found" ×2 |
| `FactoryLocationInventoryMockup.tsx` (661) | **routed** at `/factory/location-inventory-mockup` (FactoryRoutes.tsx:207) | — | — | — | uses shared `StatCard` (the only page that does, besides a local one) |
| `CombinedInventory.tsx` (836) — imported only by `StockOTW.tsx` | PH "Combined Inventory" ×2 | "Export Excel" **and** "Export" (l.427, 511), `Download`; files `combined_inventory.xlsx` (no date, l.360-361) | `Table` | — | Skeleton |
| `retail/RetailInventory.tsx` (+`RetailCatalogList`) | **`<h1>`** ×2 | label print `window.print()` (`retailLabels.tsx:178`) | cards | ad-hoc input, native `<select>` ×3 | "Loading…" text ×3 |

Not one component (domain differs), but header, export control, search and loading state should be the same four primitives. L if done fully; S for header+export.

### 2.10 Statements

| Statement | File | Header | Date filter | Export | Print |
|---|---|---|---|---|---|
| ERP account (customer/supplier/any) | `accounts/AccountStatementView.tsx` | inside Accounts PH | **`PeriodFilter`** (l.502,649) | srv `window.open('/api/accounts/statement/export-excel')` (l.281), FX `.pdf/.xlsx` URLs | RTP (`useAccountsLegacyModel.ts:16`) |
| ERP transporter | `TransporterStatement.tsx` | `<h1>` = transporter name (l.438) | **native `type="date"` ×2** (l.458,469) | none | `html2canvas` image (l.249-256) + print CSS |
| Factory customer | `factory/FactoryCustomerStatement.tsx` | PH = customer name (l.403); tabs "Statement" / price list | **native `type="date"` ×2** (l.504,514) | "Export PDF" / "Export Excel" → srv `window.open` (`CustomerStatementExports.tsx:38-54`) | `window.print()` (l.35); `window.confirm` for unsaved edits (l.152) |
| Factory supplier | `factory/FactorySupplierStatement.tsx` + `factory-suppliers/SupplierStatement.tsx` | PH "Supplier Statement" + `<h1>` supplier name | Select only | none found | none found |
| Factory transporter | `factory/FactoryTransporters.tsx` | PH "Transporters" | native date ×2 | none | RTP |
| Factory broker | `factory/FactoryBrokerVisualStatement.tsx` | PH | native date ×2 | none | — |

Six statements, four print mechanisms (RTP, `window.print`, html2canvas, none), two date-range controls, three export mechanisms. **Standard:** `AccountStatementView` pattern (PeriodFilter + ERM{Excel, PDF, Print}). A shared `StatementFrame` (party header, period, opening/closing balance row, export menu, print footer) is feasible for all six. L, medium risk (multi-currency in factory).

### 2.11 Import pages

| Variant | Frame | Title | Template button | Upload control | Result |
|---|---|---|---|---|---|
| `ImportStockItems.tsx` (915) | PH + shadcn `Tabs` (New items / Barcodes / Categories) | card "Upload Excel File" | "Download Template" (`Download`) | `<input accept=".xlsx,.xls">` | "Import Another File" |
| `POImport.tsx` (1,068) → delegates to `SpPOImport.tsx` (586) for SP companies | PH "PO Import (Excel)" | card "Upload Purchase Order Excel File" | "Download Template" | same | "Preview & Validation" card, "Import" |
| `factory/FactoryImport.tsx` (+`factoryimport/`, 1.6k) | **no PH**, `PillTabButton` mode chooser | — | `Download` | Dropzone components | `Loader2` ×5 |
| `pos/POSImport.tsx` (+`posimport/`, 1.4k) | PH | card "Upload Sales Data" | "Download Template" | same input | print template, `AlertDialog` ×2 |
| `retail/RetailImportDialog.tsx` (161) | Dialog "Import Retail Products" | — | "Download template" (lower-case t) | bare `<Input type="file">` | — |
| `retail/RetailSupplierImportDialog.tsx` (+Preview, 1.1k) | Dialog | — | — | 3 inputs (.pdf/.jpg, .xlsx/.csv, .zip) | `window.confirm` (l.304); errors CSV `retail_supplier_import_errors.csv` |
| `components/CombinedImportDialog.tsx` (417) | Dialog + `Tabs` | — | `Download` ×2 | — | — |

"Download Template" appears 18× + "Download template" 2× + "Template" + "Download Excel Template" 1× — the single most repeated button in the app, each with its own handler and a different file name style (`container_import_template.xlsx`, `Insurance_Import_Template.xlsx`, `factory-mhd-template.xlsx`, `price_list_template_<date>.xlsx`).
**Standard / one component:** yes — `ImportWizard` (steps: template → choose file → preview/validate → commit → result) with a per-import config. Biggest single dedup opportunity in this family. L.

### 2.12 Hubs

| Hub | Tab component | URL key | Own header | Tabs (order) | Restricted-state |
|---|---|---|---|---|---|
| `InventoryHub` `/inventory` | `Tabs` default style | `?tab` | **none** (child PH shows) | By Location · On The Way · Containers | `RestrictedTabsState` |
| `StockHub` `/stock` | `Tabs` | `?tab` | none | Items · Query · Offload Search | `RestrictedTabsState` |
| `PartiesHub` `/parties` | `Tabs` | `?tab` | none | **Suppliers · Customers** · Profit Check | `RestrictedTabsState` |
| `SalesToolsHub` `/sales-tools` | `Tabs` | `?tab` | none | POS Daybook · Stock Transfers · Price List · Item Replacement | (own handling) |
| `TrackingHub` `/tracking` | `Tabs`, **custom gradient hero + re-skinned TabsList** (l.31-52) | `?tab` | PH "Tracking" in violet hero | Containers OTW · GIT Tracking · Transporter Statement | none |
| `FactoryBalesHub` | `Tabs` | `?tab` | PH | Bales · Barcode Lookup · Bale Products · Customer Loading | text |
| `FactoryOthers` | `Tabs` | `?tab` | PH | 4 | — |
| `FactoryEmployeesHub` / `FactoryWorkersHub` | `Tabs` | `?tab` (nested inside PayrollHub `?section`) | none | — | — |
| `FactoryInvoicing` | **`PillTabButton`** | `?tab` | PH | Proformas · Invoices · Container Loadings · Pending Loadings | — |
| `FactoryLoadingsHub` | **`PillTabButton`** | `?tab` | **`<h1 class="text-base">`** (l.70) | Container Loadings · Pending Loadings · Priority Scan | "No Loadings tabs are available for this user." |
| `FactoryPartiesHub` `/factory/parties` | `Tabs`, **blue re-skin** (`data-[state=active]:bg-blue-600`, l.68-80) | **`?section`** (`clearKeys:["tab"]`) | PH "Parties" in gradient hero | **Customers · Suppliers** (reverse of ERP) | "No Parties tabs are available for this user." |
| `FactoryPayrollHub` | **`PillTabButton`** | **`?section`** | PH | Workers · Employees · Insurance | — |
| `FactoryProductionIntelHub` | `Tabs` | **`?section`** | none | Production Summary · Waste Tracking · Mix Optimizer · Container Tracking | — |
| `FactorySupplierHub` | `Tabs` | **`?section`** | none | Supplier Report · Supplier Statement · Supplier Scores | — |
| `FactoryContainersHub`, `FactoryFinancialHub`, `FactoryRawMaterialsHub` | — (14 / 5 / 5-line pass-throughs named "Hub") | — | — | — | — |
| `PropertiesRentalsHub` `/properties/rentals` | `Tabs` | `?tab` | none | Cash Transfer · Warehouses · Shops · Payments | — |
| `settings/PosSetupHub`, `settings/SessionsHub` | `Tabs` | **none — `useState`**, not deep-linkable | `<h2>` | 5 / 3 | — |
| `Settings.tsx` | custom section list | **none — `useState("users-permissions")`** (l.90) | PH | ~15 sections | — |
| `Vouchers.tsx` | custom `VoucherTabNav` | `?tab` | PH | — | — |

Summary: 22 files use `useHubQueryState`: 16 `?tab`, 5 `?section`, 1 `?mode`. `?section` is factory-only and applied to hubs that are structurally identical to `?tab` hubs (FactoryPartiesHub vs PartiesHub). Tab control: default `Tabs` (ERP hubs), re-skinned `Tabs` (TrackingHub, FactoryPartiesHub, FactoryDaybook), `PillTabButton` (14 files, 12 in factory, none in ERP). Empty-permission state: shared `RestrictedTabsState` in 3 ERP hubs (Inventory, Stock, Parties) vs ad-hoc sentences in factory. Tab order of the same pair differs: ERP Parties = Suppliers → Customers, Factory Parties = Customers → Suppliers. "Container Loadings" and "Pending Loadings" appear as tabs in both `FactoryInvoicing` and `FactoryLoadingsHub`.
**Standard / one component:** a `HubPage` component `{title?, tabs:[{value,label,icon,featureKey,render}], queryKey:"tab"}` would replace ~15 files of near-identical boilerplate (InventoryHub.tsx:26-73 ≈ PartiesHub ≈ StockHub ≈ SalesToolsHub). M, low risk if `?section` is kept as an accepted alias for old links (the hook already supports `clearKeys`/legacy hashes).

---

## Part 3 — Shared-primitive duplication (repo-wide)

### 3.1 Confirm dialogs

| Implementation | Files | Occ. | By area |
|---|---|---|---|
| `<AlertDialog>` built by hand per page (`ui/alert-dialog`) | **58** | 82 | fac 26, erp 16, set 7, cmp 4, pay 2, pos 2, app 1 |
| `confirmAction()` imperative (`ConfirmHost`, mounted once in `App.tsx:275`) | 15 | 18 | erp 5, pay 3, cmp 3, ret 2, sp 1, lib 1 |
| `<ConfirmDialog>` | 10 | 13 | cmp 4, fac 3, erp 1, prop 1, pos 1 |
| `<DeleteConfirmDialog>` (from `ConfirmationDialog.tsx`) | 8 | 8 | erp 4, fac 3, cmp 1 |
| `<ConfirmationDialog>` | 3 | 3 | payroll only |
| `window.confirm()` | **11** | 14 | erp 3, fac 3, set 3, ret 1, cmp 1 |
| `ConfirmPasswordDialog` / `usePasswordConfirmedAction` | 2 / 3 | | |
| `AdminAuthDialog`, `AdminOverrideDialog`, `AppLeaveConfirmDialog` | 2 / 1 / 1 | | special-purpose, keep |
| native `alert()` / `prompt()` | 0 | | (`promptText()` exists in ConfirmHost) |

`ConfirmationDialog`, `DeleteConfirmDialog` and `ConfirmHost` are already thin wrappers over `ConfirmDialog` — the stack is sound; the problem is the 58 hand-rolled `AlertDialog` files and 14 native confirms. `window.confirm` examples: `pages/factory/factorynetposition/components/FactoryFxAgentWalletCard.tsx:204,281,423,500`, `pages/CostCenters.tsx:152`, `pages/settings/FxRatesCard.tsx:129`, `pages/factory/FactoryCustomerStatement.tsx:152`, `pages/retail/RetailSupplierImportDialog.tsx:304`, `pages/vouchers/useVoucherFxWalletPayment.ts:284`.
**Standard:** `confirmAction()` for simple yes/no; `<ConfirmDialog>` when the body needs custom content; delete `ConfirmationDialog` (3 payroll users) in favour of `ConfirmDialog`. Native confirms → S (mechanical). AlertDialog migration → M (58 files, per-file trivial).

### 3.2 Stat / KPI cards

| Implementation | Used by |
|---|---|
| `components/StatCard` (canonical, tones, memo) | **imported by exactly 2 files — its own wrappers** `KPICard.tsx`, `FactoryKpiCard.tsx` |
| `components/KPICard` | 2 files: `properties/PropertiesDashboard.tsx:282-298`, `dashboard/components/FactoryProductionPanel.tsx:22-38` |
| `components/FactoryKpiCard` | 1 file: `factory/FactoryDashboard.tsx` |
| `OperationsMetricCard` (`components/operations/operations-screen.tsx:131`) | **0** |
| `FinancialSummaryCard` (`components/financial/financial-screen.tsx:109`) | **0** |
| Local `function StatCard/SummaryCard/KpiCard/MetricCard/SummaryTile` re-definitions | **16 files / 17 defs** (5 `StatCard`, 7 `SummaryCard`, 2 `KpiCard`, 1 `MetricCard`, 2 tiles): e.g. `retail/RetailDashboard.tsx:111`, `NetProfitReport.tsx:136`, `supplierprofitcheck/components/StatCard.tsx:10`, `factory/factorylocationinventory/components/StatCard.tsx:9`, `factory/productioncomparison/components/StatCard.tsx:40`, `factory/factoryfinancialsnapshot/components/KpiCard.tsx:10`, `factory/factoryattendance/components/SummaryCard.tsx:8`, `factory/factoryotwtrackingtab/components/SummaryCard.tsx:5`, `containerverification/SummaryCards.tsx:33`, `itemMarketAnalysisParts.tsx:113`, `dashboard/components/DashboardKPICard.tsx:10` |
| Inline `<Card>` + `text-2xl font-bold` number (no component) | ~33 files / 63 occ (fac 16, erp 6, sp 4…) |

Five shared implementations, three in use, by three files; ~50 files roll their own. **Standard:** `StatCard` (keep `KPICard`/`FactoryKpiCard` only as tone presets or delete them). M.

### 3.3 Loading / empty / error states

| Implementation | Files | Notes |
|---|---|---|
| `ui/page-state` (`PageState`, `LoadingState`, `EmptyState`, `ErrorState`, `SuccessState`) | 20 | `<ErrorState>` 14 files, `<EmptyState>` 10, `<LoadingState>` 4, `<PageState>` 4 |
| `ui/display-state` (`LoadingRows`, **another `EmptyState`**) | 3 | `OpeningStockSummary.tsx:9`, `ClosingStockSummary.tsx:27`, `factory/FactoryStockBaleList.tsx:13` |
| `ui/empty-state` (**a third `EmptyState`**) | 3 | `analyticslegacy/useAccountRenderers.tsx:5`, `vouchers/StockTransferRevisionHistory.tsx:5`, `location-inventory/CombinedStockView.tsx:7` |
| `components/LoadingSkeleton` | 1 | `factory/FactoryDashboard.tsx` |
| `app/AppLoadingState`, `WorkspaceRouteBoundary` | shell-level | fine |
| Raw `<Skeleton>` composed per page | 172 files / 460 occ | erp 77, fac 67, pos 10 |
| `<Loader2>` spinner | **239 files / 462 occ** | fac 122, set 36, erp 35, cmp 22, sp 14 |
| other `animate-spin` (RefreshCw / CSS border) | 44 / 50 | |
| Text "Loading…" as JSX content | 126 files / 157 occ | fac 51, erp 37, cmp 14 |
| `"Loading..."` as a value string (e.g. inside KPI cards) | 24 / 31 | `Dashboard.tsx:180`, `properties/PropertiesDashboard.tsx:284` |
| Literal ">No … found/yet/available<" | **153 files / 184 occ** | fac 60, erp 54, set 17 |

Three components all exported as `EmptyState` from three modules. Factory favours spinners (122 files with Loader2 vs 67 with Skeleton); ERP favours skeletons (77 vs 35). **Standard:** `ui/page-state` only; fold `display-state.LoadingRows` into it as a table-rows variant; delete `ui/empty-state` and `LoadingSkeleton` (7 importers total → S). Converting the 153 literal empty messages is L but mechanical.

### 3.4 Pagination

| Implementation | Files |
|---|---|
| `components/PaginationBar` | 3 pages (`Daybook.tsx:809`, `factory/FactoryCustomers.tsx:660`, `factory/FactoryContacts.tsx:567`) + wrapped by ErpListPagination |
| `erp-core/ErpListPagination` (+ `useErpServerPagination`) | 1 page (`StockQuery.tsx:215`) |
| `ui/pagination` (shadcn) | **0 importers — dead** |
| `hooks/use-client-table-pagination` | 2 (factory) |
| `hooks/use-paginated-filter-state` | 9 pages (erp 6, pos 2, fac 1) — state only, no UI |
| Ad-hoc "Page {x} of {y}" markup | **10 pages**: `settings/AuditLog.tsx:538`, `stockitems/StockItemsView.tsx:587,701`, `AccountTransfer.tsx:450`, `StockInSalesReportComparison.tsx:675`, `transactionjournal/components/JournalVoucherList.tsx:370`, `analyticslegacy/components/SalesSectionPanel.tsx:329`, `factory/BalesHistory.tsx:697`, `factory/wastedispatch/components/WasteBaleGroupTable.tsx:131`, `factory/factoryshippingcontainers/components/DoneContainersSection.tsx:126` |
| Ad-hoc Previous/Next buttons | 5 files |

Most list pages have **no pagination at all** (218 files with `<Table>`, 163 with raw `<table>`, ~15 with any pager). **Standard:** `ErpListPagination` (which already wraps `PaginationBar`). Ad-hoc → S each.

### 3.5 Export / print code paths

| Path | Files | Occ. | By area |
|---|---|---|---|
| **`ErpReportExportMenu`** (canonical) | **5** | 5 | erp only: `Daybook.tsx`, `StockInSalesReport.tsx`, `StockInSalesReportDetail.tsx`, `SalesReportLegacy.tsx`, `ProfessionalFinancialStatements.tsx` |
| `erp-core/erpReportExports` (`exportErpReportRowsExcel`, `erpReportFileName`, CSV) | 4 | 9 | erp |
| `ErpReportPrintFooter` | 4 | | erp |
| `lib/excelHelper` (exceljs wrapper exposing an `XLSX`-like `utils`/`writeFile`) | **67** | 73 | erp 28, fac 27, set 5, pos 2, ret 2, cmp 2 |
| `writeFile(` / `XLSX.writeFile(` call sites | 56 | 75 | |
| Direct `exceljs` import (bypassing helper) | 14 | 21 | fac 8 (`productiontargets/weeklyBonusPaymentsExcel.ts`, `productionWeeklyExcel.ts`, `finalizedSaleReturnMatchWorkbook.ts`), lib 4, erp 1 (`baleproducts/baleOrderSheetExport.ts`), pos 1 |
| `wb.xlsx.writeBuffer()` + own Blob | 13 | 14 | e.g. `factory/FactoryPriceList.tsx:217` |
| Direct `xlsx` (SheetJS) import | 0 | | good — fully replaced |
| Manual CSV (`text/csv` Blob) | 12 | 12 | **fac 8**: `FactoryCustomers.tsx:284`, `FactoryMonthlyProductionMatrix.tsx:288`, `FactoryStockQueryWorkspace.tsx:83`, `ProductionComparison.tsx:380`, `FactorySheetsAndSacks.tsx:244`, `FactoryEmployeeBonusesTab.tsx:161`, `factorybalerelabeling/utils.tsx:78`, `factoryotwtrackingtab/hooks/useOtwCsvTools.ts:115`; erp `UnifiedAccountingDashboard.tsx:293`; ret 1 |
| `.join(",")` row builders | 28 | 49 | |
| `lib/downloadBlob` | 15 | 16 | |
| Manual `a.download = …` + `URL.createObjectURL` (re-implementing downloadBlob) | **43** | 53 | fac 22, erp 12, cmp 4, set 3 |
| Server-rendered Excel (`…/export-excel`, `/excel`) | 40 | 63 | fac 20, erp 16 |
| Server-rendered PDF (`…/pdf`, `export-pdf`) | 28 | 45 | fac 16, erp 8 |
| `window.open("/api/…")` to trigger a download | 22 | 29 | fac 13, erp 5 |
| jsPDF (+autotable) | 3 | 6 | `lib/containerExportEnhancements.ts:388`, `settings/datatoolstab/useDataToolsModel.ts:463`, `stock-transfer-order/useStockTransferOrderWorkflows.ts:320` |
| html2canvas (excluding remote-support screen feed) | 1 page | | `TransporterStatement.tsx:249-256` (+ factory share-as-image flows, unverified count ≈5) |
| `react-to-print` | 10 | 10 | pos 4, erp 3, fac 3 |
| `window.print()` | 18 | 20 | erp 9, fac 6 |
| Pop-up `document.write` print windows | **18** | 27 | **fac 13** (`bale-stock-entry/*`, `baleshistory/*`, `FactoryBaleRelabeling.tsx:203`, `wipersreentry/printUtils.ts:65`), pay 1, prop 1 (`property-rental/components/LedgerView.tsx:248`) |
| `lib/daybook-export` | 2 | | |
| `lib/containerExportEnhancements` | **0 importers** (unverified dynamic import) | | |
| `pages/settings/ExportCenter*` (5 files) | settings bulk export UI | | own UI, own progress dialog |

Four print mechanisms and six spreadsheet mechanisms. The canonical export menu is used by **5 files out of 100+ that export something** (67 import `excelHelper` alone), and by **zero** factory / POS / properties / retail / SP pages.

**Export button labels (JSX text, repo-wide):** "Export" 21 · "Download Template" 18 (+"Download template" 2, "Template", "Download Excel Template") · "Export Excel" 12 · "Print" 8 · "Excel" 7 · "Export PDF" 4 · "PDF" 4 · "Download Excel" 3 · "Export CSV" 2 · "Download PDF" 2 · "Download" 2 · "Export to Excel" 1 · "Export formatted Excel" 1 · "Export / Import" 1 · "Export PDF / Print" 1 · "Print / PDF" 1 · plus ~25 one-off "Export <Thing>" labels. So the same action is "Export Excel" / "Excel" / "Download Excel" / "Export to Excel" / "Export".

**Icon actually placed next to those labels (3 lines of context):**
| Label | Icons |
|---|---|
| "Export" | `Download` 8, `FileDown` 5 |
| Excel-type labels | `Download` 10, `FileDown` 6, `FileSpreadsheet` 5, `Sheet` 1, `FileText` 1 |
| PDF-type labels | `FileDown` 4, `Printer` 2, `FileText` 2, `Download` 2 |
| "Print" | `Printer` 7 (consistent) |
| Template | `Download` 17, `FileDown` 4, `FileSpreadsheet` 2 |
Icon file counts: `Download` 98, `Upload` 59, `FileSpreadsheet` 53, `FileText` 49, `Printer` 47, `FileDown` 33, `Sheet` 19.
`data-testid`: `button-export-excel` ×20, `button-download-template` ×10, `button-export-dropdown` ×8, `button-export-pdf` ×6.

**Filename conventions** (113 distinct filename literals/templates found): ~47 kebab-case (`factory-customers.csv`, `daily-scan-<date>.xlsx`, `loading-status.xlsx`), ~36 lower_snake (`combined_inventory.xlsx`, `otw_containers.xlsx`, `factory_price_list_<date>.xlsx`), ~14 Title_Snake (`Journal_Voucher_Detailed_<date>.xlsx`, `Payroll_<from>_<to>.xlsx`, `HMD_Order_Selling_Price.xlsx`, `Insurance_Import_Template.xlsx`), plus PascalCase (`FactoryDaybook_<date>.xlsx`). ~70 % carry **no date** and none carry the company name (except what `erpReportFileName` adds — used by 3 files). Date stamps in names are produced three ways: `toLocaleDateString("en-CA")` 126 occ, `toISOString().slice(0,10)` 65 occ (UTC — can be a day off local), `format(new Date(),"yyyy-MM-dd")` 15 occ.

**Standard:** `ErpReportExportMenu` for the control (label "Export", `Download` icon, options Excel `FileSpreadsheet` / CSV `FileText` / PDF / Print `Printer`), `erpReportFileName()` for names, `downloadBlob()` for every client download, one `printDocument()` helper replacing the 18 `document.write` pop-ups. Rename/re-home `ErpReportExportMenu` out of the "Erp" namespace so factory/POS adopt it. L overall; S per page.

### 3.6 Number / money / date formatting

| Helper | Files | Occ. |
|---|---|---|
| `useCurrency().formatAmount()` (context-aware) | 131 | 822 — erp 90, cmp 12, **fac 11**, pay 11 |
| `@/lib/formatNumber` (`formatNumber`, `formatCurrency`, `formatCurrencyWithLabel`, `formatPercent`) | 101 | erp 45, fac 37 |
| `@/lib/moneyDisplay` | 11 | |
| `<MoneyAmount>` | **3** | properties only |
| `useDateFormat()` (company date format) | 80 | erp 30, fac 35 |
| `date-fns` import | 73 | erp 44, fac 8 |
| **Ad-hoc `.toLocaleString(`** | **296** | 627 — **fac 130**, erp 88, cmp 31 |
| **Ad-hoc `.toFixed(`** | 229 | 627 — fac 97, erp 41 (29 are i18n files) |
| `Intl.NumberFormat` | 20 | 34 |
| Local formatter definitions (`const fmt = …`, `fmtMoney`, `formatMoney`, `money`, `fmtQty`, `fmtKg`…) | **141** | 162 — **fac 74**, erp 38, cmp 13 |
| `.toLocaleDateString(` | 115 | 194 — fac 58, erp 24 |
| `.toLocaleTimeString(` | 24 | 31 |
| Local date formatter definitions (`fmtDate`, `formatDate`, …) | 41 | 46 — fac 25 |
| Hard-coded `$` prefix in JSX/template | 86 | 398 — fac 45, erp 21, cmp 12 |
| Shared `lib/date*` helper | none exists | |

Factory uses the currency context in 11 files but defines 74 local formatters; ERP is the reverse. There is no shared date-display helper other than the `useDateFormat` context. **Standard:** `formatAmount` / `MoneyAmount` for money, `formatNumber` for quantities, `useDateFormat` for dates; add `formatQuantity`/`formatWeight` to `lib/formatNumber` to absorb the `fmtKg`/`fmtQty` family. L (141 files) but codemod-able.

### 3.7 Debounce
`hooks/use-debounce.ts` (`useDebounce(value, delay=300)`) — 6 importers; `hooks/useDebouncedValue.ts` (`useDebouncedValue(value, delayMs)`) — 2 importers (`git-containers/usePaginatedGITContainers.ts:3`, `daybook/usePaginatedDaybookVouchers.ts:3`). Same function, two names. Plus inline `setTimeout(() => setDebounced…)` in ≥7 files (`StockInSalesReport.tsx:238`, `StockEntryHistory.tsx:60`, `ItemMarketAnalysis.tsx:55`, `retail/RetailInventory.tsx:66`, `retail/RetailVariantReports.tsx:65`, `vouchers/useVoucherQueries.ts:46`, `vouchers/journalform/useJournalFormModel.tsx:113`). Most search boxes are not debounced at all. **Standard:** keep `useDebounce`, delete `useDebouncedValue`. S.

### 3.8 Search inputs
`<SearchField>` — **15 files**. Any `placeholder="Search…"` — **137 files / 151 occ**. Hand-positioned `<Search className="… absolute …">` icon inside a relative wrapper — 94 files / 99 occ (fac 41, erp 33). So ≈ 1 in 9 search boxes uses the shared field. Placeholder wording is free-form ("Search...", "Search…", "Search suppliers...", "Search by name or code…", "Voucher # or description..."), mixing `...` and `…`. **Standard:** `SearchField` (with built-in clear + optional debounce). M, mechanical.

### 3.9 Date inputs
| Control | Files | Occ. | Area |
|---|---|---|---|
| native `<input type="date">` | **186** | 309 | fac 88, erp 40, cmp 17, pay 10 |
| `PeriodFilter` | 26 | 31 | **erp 22**, fac 2, pos 2 |
| shadcn `<Calendar>` popover | 27 | 30 | erp 13, fac 8 |
| `ui/date-picker-input` (`DatePickerInput`) | **0 — dead** | | |
| native `type="month"` | 7 | | |
`PeriodFilter` is effectively ERP-only: the only factory users are `FactoryDaybookFilters.tsx:46` and `wastedispatch/components/DispatchHistoryPanel.tsx:94`. Every other factory report builds a from/to pair of native date inputs. Native `<select>`: 54 files / 101 occ (ret 11, erp 13, fac 12) vs shadcn `Select` 258 files; `ErpNativeSelect` 1 file.
**Standard:** `PeriodFilter` for ranges; one single-date control (either adopt `DatePickerInput` or delete it and bless native). M–L.

### 3.10 Status badge colour maps
`<StatusBadge>` (25 `StatusKind`s) — 18 files (fac 13, erp 5; 0 in pos/properties/retail/settings). Local status→colour maps/functions — **47 files / 52 defs** (fac 25, erp 12, cmp 8): `STATUS_COLORS` ×8 (`containers/ActiveContainersTable.tsx:82`, `BatchDetail.tsx:45`, `stockentryhistory/utils.tsx:23`, `factory/factoryshippingcontainers/utils.tsx:22`, `factory/factorystockallocationv3/utils.tsx:23`, `factory/FactoryProductionTargets.tsx:833`, `factory/factory-suppliers/AssignContainersDialog.tsx:30`, `components/OfflineModePanel.tsx:72`), `getStatusBadge` ×4, `statusColors` ×3, bespoke `ContainerStatusBadge`, `BaleStatusBadge`, `RideStatusBadge`, `TripStatusBadge`, `RevisionStatusBadge`. `<Badge className="bg-<palette>-…">` — 31 files / 58 occ. Hard-coded Tailwind palette backgrounds overall: 389 files / 2,788 occ (fac 202). **Standard:** `StatusBadge` + extend `StatusKind` (container/bale/ride states). M.

### 3.11 i18n coverage
Two mechanisms coexist:
1. **Key-based** `t("…")` from `useApplicationLanguage` — dictionaries `i18n/applicationTranslations{,.ar,.fr}.ts` (≈546 keys). Used in 43 files / 439 calls: cmp 21, fac 8, app 5, set 3, pos 3, **erp pages 2**, properties 0, retail 0, sp 0.
2. **Runtime literal translator** `components/ApplicationInterfaceTranslator.tsx` — a `TreeWalker` + `MutationObserver` that rewrites English text nodes and `aria-label`/`title`/`placeholder` attributes from ≈46,500 lines of `{en, ar, fr}` phrase tables (`phase3RemainingTranslations.part01-39` ≈25.7k lines, `sharedUi…`, `tabsFilters…`, `reportsExports…`, `propertiesRentals…`, `supplierPartner…`, `retailWave1-3`, `payrollUi…`, `backendMessages…`). Opt-out via `data-no-translate` / `data-business-value`.
3. A third style: per-feature `translateXxxText(key, language)` helpers — 59 files / 116 calls, mostly factory (22 files: priority scan, container loading, insurance, production planner).

Consequences for unification: because pages are written in hard-coded English and translated by exact string match, **every label variant needs its own dictionary row** — "Export Excel" / "Export to Excel" / "Download Excel", "New Customer" / "Add Customer" / "Create Customer", "Search..." / "Search…". Unifying labels directly shrinks the phrase tables and removes untranslated stragglers. Coverage by area cannot be measured by `t()` count (ERP pages have 2 files with `t()` yet are covered by the literal tables); strings built by concatenation or template literals (`"Archive " + center.name + "?"`, `CostCenters.tsx:152`; all `window.confirm` texts; dynamic `title={…}`) are **not** translatable by the literal mechanism — unverified how many, but the 14 native confirms certainly are not. Shell chrome is partly literal English (ErpShell.tsx:83-94 view-only banner, PosShell nav labels, AppTopBar.tsx:107 search hint). RTL handling (`isRtl`/`dir`) appears in only 17 files.

### 3.12 Page frame / tabs / table primitives (context for the above)
| Primitive | Files |
|---|---|
| `PageHeader` | 153 (erp 84, fac 58, pos 6, prop 3, pay 1; **retail 0, sp 0, settings 0**) |
| `ErpPage` | 2 |
| `PageShell` | 4 |
| raw `<h1>` | 80 (fac 31, erp 22, ret 6, pos 6, sp 6) |
| `components/operations/operations-screen` | **0 importers — dead** |
| `components/financial/financial-screen` | **0 importers — dead** |
| `ui/workflow-dialog` | **0 importers — dead** |
| `ui/workspace-layout` | 5 |
| `ui/factory-mobile` | 10 |
| `ErpListTable` / `ErpListFilters` | 13 / 5 (erp only) |
| shadcn `<Table>` / raw `<table>` | 218 / 163 |
| `DataTableToolbar` / `TableViewOptions` | 8 / 2 |
| `Tabs` / `PillTabButton` | 43 / 14 (pill = factory 12) |
| raw `<button>` | 256 files / 486 occ vs `Button` 790 files |
| Create-action verb (first word of standalone JSX label) | "Add …" 69, "New …" 26, "Create …" 19 — e.g. New/Add/Create Customer 2/2/1, New/Create Employee 2/1, Add/New/Create Worker 1/1/1, New/Create Proforma 3/5 |

---

## Inconsistency findings

1. **PosShell is outside the shared shell system.** Own sidebar and top bar, hard-coded accent, no `PhoneSheetDialogs`/`AppModeProvider`/viewport hooks/notifications/read-only gate. `app/PosShell.tsx:121-352` vs `app/PropertiesShell.tsx:55-87`. Standard: `AppTopBar` + sidebar primitives + a `MODULE_ACCENT.pos` token; keep the POS nav list. M, medium risk (POS is touch-first; test full-height routes).
2. **Phone navigation differs per company type.** Bottom nav + "More" sheet only in ErpShell (`ErpShell.tsx:133-146`, `AppTopBar` `simplifyMobileNavigation`); Factory/Properties/POS use the sidebar sheet. Standard: one phone pattern for all shells. M.
3. **Hub URL key `?tab` vs `?section`.** `factory/FactoryPartiesHub.tsx:30` (`section`) vs `PartiesHub.tsx` (`tab`); `lib/parent-routes.ts:9` vs `:21` mix both inside factory. Settings hubs use un-linkable `useState` (`settings/SessionsHub.tsx`, `Settings.tsx:90`). Standard: `?tab` everywhere, accept `?section` as legacy alias. S–M, low risk.
4. **Three tab looks.** Default `Tabs` (InventoryHub.tsx:40), inline blue re-skin (`FactoryPartiesHub.tsx:68-80`, `FactoryDaybook.tsx:112-125`, `TrackingHub.tsx` TabsList), `PillTabButton` (`FactoryLoadingsHub.tsx:80-106`, `FactoryInvoicing`, `FactoryPayrollHub`). Standard per docs/universal-responsive-pill-tabs.md; remove per-page class overrides. M.
5. **Hub header presence is random.** ERP hubs render no header (child page supplies PH); TrackingHub/FactoryPartiesHub render a gradient hero + PH and the child renders another title (`FactoryCustomers.tsx:386` `<h1>` under `FactoryPartiesHub` PH "Parties"); FactoryLoadingsHub uses `<h1 class="text-base">` (l.70). Standard: hub owns the single PH; children take `embedded`. M.
6. **Canonical export menu adopted by 5 files, none outside ERP** (§3.5). Daybook (`Daybook.tsx:662`) vs FactoryDaybook hand-built dropdown (`FactoryDaybook.tsx:74-95`) is the clearest pair. L.
7. **Same export action, 5 labels and 5 icons** (§3.5): "Export Excel" 12 / "Excel" 7 / "Download Excel" 3 / "Export to Excel" 1; icon `Download` / `FileDown` / `FileSpreadsheet` / `Sheet` / `FileText`. E.g. `CombinedInventory.tsx:427` "Export Excel" and `:511` "Export" in the same file. S per page once ERM is the control.
8. **Export filenames: 4 casing styles, mostly undated, 3 date-stamp methods** (§3.5). `daybook/exportDaybook.ts:32` (`erpReportFileName`) vs `factory/daybook/factoryDaybookExports.ts:49` (`FactoryDaybook_…`) vs `FactoryCustomers.tsx:284` (`factory-customers.csv`) vs `CombinedInventory.tsx:361` (`combined_inventory.xlsx`). Standard: `erpReportFileName(label, ext)` everywhere (Company_Report_YYYY-MM-DD). S, mechanical.
9. **Print: 4 mechanisms.** `react-to-print` 10 files, `window.print()` 18, `document.write` pop-ups 18 (13 factory), html2canvas (`TransporterStatement.tsx:249`). Standard: RTP + `ErpReportPrintFooter` for documents; print CSS for reports. L.
10. **Customer create verb + duplicated form.** "New Customer" (`Customers.tsx:352`, `pos/POSCustomers.tsx:129`) vs "Add Customer" (`factory/FactoryCustomers.tsx:417`); the ERP and POS create dialogs are copy-pasted. Repo-wide Add 69 / New 26 / Create 19. Standard: "New <Entity>" for header create buttons, "Add" for adding rows to a document. S.
11. **Statements: date range by `PeriodFilter` in ERP (`accounts/AccountStatementView.tsx:502`) vs native date pair in `TransporterStatement.tsx:458,469`, `factory/FactoryCustomerStatement.tsx:504,514`, `factory/FactoryTransporters.tsx:143,255`.** Repo-wide PeriodFilter 26 files (22 ERP) vs native date 186 files. M.
12. **Dashboards: 6 pages, 5 KPI-card implementations, 2 raw `<h1>` headers** (§2.1). `retail/RetailDashboard.tsx:111,307`, `sp/SpOverview.tsx:125`, `dashboard/components/DashboardKPICard.tsx:10`. M.
13. **Loading convention split by module:** factory spinner-first (`Loader2` in 122 factory files), ERP skeleton-first; KPI cards show the string "Loading..." as their value (`Dashboard.tsx:180`, `properties/PropertiesDashboard.tsx:284`). Standard: skeleton for first load, spinner only inside buttons. L.
14. **Three `EmptyState` exports** (`ui/page-state`, `ui/display-state`, `ui/empty-state`) — §3.3. S.
15. **Confirm: 58 hand-built AlertDialogs + 14 `window.confirm`** vs the shared stack (§3.1). S (native) / M (AlertDialog).
16. **Money formatting split:** ERP → `formatAmount` (90 files); factory → 74 local formatters + 130 files with `toLocaleString` + `$` literals (45 files). `factory/factory-suppliers/*` alone: `toFixed` ×31, `toLocaleString` ×15. L.
17. **Search box:** `SearchField` 15 files vs 137 ad-hoc; within one family `FactoryPriceList.tsx:340` uses it, `pos/pospricelist/PriceListToolbar.tsx:167` does not. M.
18. **Back behaviour:** ERP history-first vs Factory/Properties parent-first for the *same shared pages*; Esc-back missing in POS/retail/properties/SP/settings; 10 files call `window.history.back()` directly; 37 files pass their own `onBack`. Standard: `PageHeader` back only, one strategy. M, medium risk (user habits).
19. **Wrapper policy:** Properties adds 5-line pass-through files for shared pages (`PropertiesAccounts`, `PropertiesDaybook`, `PropertiesVouchers`, `PropertiesVoucherDetail`, `PropertiesVoucherEdit`, `PropertiesLedgerMonthly`, `PropertiesLedgerVouchers`, `PropertiesSettings`), Factory does it for some (`FactoryVouchers`, `FactoryAccounts`) and routes others directly (`FactoryRoutes.tsx:327-328`), POS routes directly. Rental pages have 3×3 thirteen-to-sixteen-line wrappers (`pages/erp/ErpRental*.tsx`, `factory/FactoryRental*.tsx`, `properties/PropertiesRental*.tsx`). Standard: route the shared component directly with props. S.
20. **`RetailNav` single-link nav** on 5 pages (2 retired). Remove or fold into sidebar. S.

## Duplicates / dead candidates

| Item | Evidence | Suggestion |
|---|---|---|
| `components/operations/operations-screen.tsx`, `components/financial/financial-screen.tsx` | 0 importers (listed in the brief as canonical) | adopt or delete — currently dead |
| `ui/date-picker-input.tsx`, `ui/workflow-dialog.tsx`, `ui/pagination.tsx` | 0 importers | delete or adopt |
| `lib/containerExportEnhancements.ts` | 0 static importers (unverified dynamic) | verify, delete |
| `components/LoadingSkeleton.tsx` | 1 importer | merge into `page-state` |
| `ui/display-state.tsx`, `ui/empty-state.tsx` | 3 importers each | merge into `page-state` |
| `hooks/useDebouncedValue.ts` | 2 importers; duplicate of `use-debounce` | delete |
| `components/ConfirmationDialog.tsx#ConfirmationDialog` | 3 payroll users | replace with `ConfirmDialog`; keep `DeleteConfirmDialog` |
| `components/StatCard` wrappers `KPICard`, `FactoryKpiCard` | 2 + 1 users | collapse into `StatCard` tone prop |
| `pages/ContainersPage.tsx` (5 lines) | alias of `Containers` | import `Containers` directly |
| `pages/factory/FactoryContainersHub.tsx`, `FactoryFinancialHub.tsx`, `FactoryRawMaterialsHub.tsx` | 14 / 5 / 5 lines, not hubs | rename or inline |
| `pages/Accounts.tsx` → `AccountsLegacy.tsx`; `Analytics.tsx` → `AnalyticsLegacy.tsx`; `SalesReport.tsx` → `SalesReportLegacy.tsx` | "Legacy" is the live implementation | rename (drop "Legacy") |
| `pages/GITMockup.tsx` + `pages/git-mockup/` (3.8k lines) | live "GIT Tracking" tab (`TrackingHub.tsx:9,73`) | rename (not a mockup) |
| `pages/factory/FactoryLocationInventoryMockup.tsx` (661) | routed `/factory/location-inventory-mockup` (`FactoryRoutes.tsx:207`) | remove route/file if not used by owner |
| `FactoryStockAllocationV2.tsx` (479), `V3` (512), `V5` (793) | `/factory/stock-allocation`, `-v3`, `-v5` all routed (`FactoryRoutes.tsx:282-286`) | `/factory/stock-allocation` still serves V2 (`lazyPages.ts:198`), V3 and V5 also routed — three generations live; keep V5, retire V2/V3 |
| `pages/Dashboard.tsx` `isFactoryMode` branch vs `factory/FactoryDashboard.tsx` | both titled "Factory Dashboard" | one of them is redundant |
| `properties/PropertiesDashboard.tsx` | fork of `Dashboard.tsx` | merge with config |
| `retail/RetailQuickAdd.tsx`, `retail/RetailStockOperations.tsx` | routes redirect away (`AppRoutes.tsx:49-52`) | dead pages (unverified other entry points) |
| `Customers.tsx` / `pos/POSCustomers.tsx` create dialog | duplicated form | extract `CustomerFormDialog` |
| `posWorkspaceClasses` (PosShell:50-69) / `factoryWorkspaceClasses` (FactoryShell:57-72) | near-identical lists | one shared constant / CSS layer |

## Quick wins (mechanical, low risk)
- Replace 14 `window.confirm` with `confirmAction()`.
- Delete `useDebouncedValue` (2 call sites), `ui/empty-state` + `ui/display-state` + `LoadingSkeleton` (7 call sites) in favour of `use-debounce` / `page-state`.
- Remove the 0-importer primitives or mark them adopted (5 files).
- Route export filenames through `erpReportFileName`; replace 43 manual `a.download` blocks with `downloadBlob`.
- Normalise export labels/icons to "Export" + `Download`, menu items "Excel" `FileSpreadsheet` / "CSV" / "PDF" / "Print" `Printer`; "Download Template" everywhere (20 sites).
- Normalise create verb ("New <Entity>") and search placeholder ellipsis.
- `?section` → `?tab` in 5 factory hubs (+ `parent-routes.ts`, keep alias).
- Drop pass-through wrapper pages; rename `*Legacy` / `GITMockup`; remove `RetailNav`.
- Replace 10 ad-hoc "Page x of y" pagers with `ErpListPagination`.
- Give PosShell the missing shared hooks (`PhoneSheetDialogs`, `AppModeProvider mode="pos"`, viewport hooks) without touching its look.

## Bigger refactors
1. **`HubPage` component** (config-driven tabs, `?tab`, single header, `RestrictedTabsState`) — replaces ~15 hub files.
2. **Export/print unification** — move `ErpReportExportMenu`/`erpReportExports` to a neutral name, add PDF + server-endpoint option kinds, one print helper; migrate the 100+ exporting files module by module (factory first: 8 manual CSVs, 13 pop-up prints).
3. **`ImportWizard`** — template/upload/preview/commit/result for the 7 import flows.
4. **`StatementFrame`** — the six statements.
5. **`CustomersDirectory` / `PriceListWorkspace` / read-only `ContainersOtw`** shared components with per-company config.
6. **Formatting codemod** — 141 local formatters + ad-hoc `toLocaleString`/`toFixed`/`toLocaleDateString` → `formatAmount`/`formatNumber`/`useDateFormat`.
7. **State primitives rollout** — `page-state` for 153 literal empty messages and 126 "Loading…" texts; skeleton-first rule.
8. **Date-range rollout** — `PeriodFilter` into factory/POS/properties reports (186 files with native date inputs; ranges are the subset to convert).
9. **Shell convergence** — PosShell onto `AppTopBar` + sidebar primitives; one phone navigation pattern; one Back strategy.
10. **StatusBadge + StatCard adoption** — 47 local status maps, ~50 local stat cards.
