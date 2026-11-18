# UI Unification — Plan and Tracker

**Goal:** the same thing looks, is named, is placed and behaves the same on every
page and in every company type (ERP, Factory, Properties, Retail, Supplier
Partner, POS).

**Started:** 2026-11-13. **Scope rule:** presentation and interaction only.
Accounting, stock, permission and posting logic are not changed by this
program. Anything that needs a business decision is listed under
[Owner decisions](#owner-decisions) instead of being guessed.

The page-by-page audit this plan is built on is archived in
[`../archive/ui-unification-audit-2026-11-13/`](../archive/ui-unification-audit-2026-11-13/)
(nine reports, about 350 pages and tab panels, about 240 numbered findings).

## What the audit found

| Area | Pages / panels | Findings | Headline |
|---|---|---|---|
| ERP accounting, finance, reports | 44 | 19 | 8 export implementations; 12 `/accounting/*` pages with a bare `<h1>` |
| ERP stock, containers, suppliers, tools | ~70 | 18 | 11 export implementations; ~20 list pages with no export |
| Vouchers and payroll | ~30 | 30 | Two parallel voucher edit UIs; save label differs per voucher type |
| Factory production, bales, scanning | 53 | 36 | 7 export implementations; ~15 reports with no export; 5 status-badge colour maps |
| Factory sales, loading, dispatch | 29 | 23 | Invoice export built 5 ways; V2/V3/V5 allocation all routed |
| Factory people, parties, finance | 46 | 18 | Employees and Workers are parallel implementations; wrong back links |
| POS and Retail | 28 | 27 | No shared header in Retail; ~30 native selects; ~1,800 dead lines |
| Properties, Supplier Partner, Settings | 49 | 34 | One rental component renders three headers; three save models in Settings |
| Cross-company comparison | — | 12 | See the standards below |

Repo-wide counts (regex counts over `client/src`, tests excluded):

| Concern | On the shared standard | Hand-built |
|---|---|---|
| Export menu | 5 files | 67 direct Excel-helper calls, 14 raw `exceljs`, 12 manual CSV, 22 `window.open` |
| Confirm dialog | ~33 files | 58 hand-built `AlertDialog`, 14 native `window.confirm` calls |
| Search field | 15 files | 137 ad-hoc inputs |
| Date range | 26 files | 186 native date inputs |
| Loading / empty state | 20 files | 239 spinner files, 126 "Loading…" texts, 153 "No … found" literals |
| Number / money format | shared helpers in ~90 files | 141 files define a local formatter; `$` hard-coded in 86 |
| Status badge | 18 files | 47 local colour maps |
| Hub tab URL key | 16 use `?tab` | 5 use `?section`; settings hubs are not URL-backed |

## The standards

One decision per concern. New code follows these; migrations move existing
pages to them.

| Concern | Standard |
|---|---|
| Page frame | `PageHeader` (title, optional subtitle, back target, actions on the right) inside the shell's page padding. No bare `<h1>`, no bespoke gradient hero. A tab panel inside a hub does not repeat the hub's title. |
| Hub tabs | `Tabs` / `PillTabButton` from `components/ui/tabs` with the default styling, URL-backed with `useHubQueryState`. A hub's own tabs use the key `tab`. A hub whose panels are themselves tabbed pages (Factory Payroll, Parties, Supplier Intel, Production Intel; Settings) uses `section` for its level and clears `tab` when it changes, so `?section=workers&tab=payroll` opens both levels. While permissions load, a hub shows the loading skeleton and keeps the requested tab; with nothing permitted it shows `RestrictedTabsState`. |
| Export | One menu component (`ReportExportMenu`, the ERP export menu made available to every company type): button label **Export**, icon `Download`, items **Excel**, **CSV**, **PDF**, **Print**, in that order, only the ones the page supports. |
| Export files | `exportFileName(subject, { from, to })` → `subject-kebab-case_YYYY-MM-DD.ext` (or `_from_to` for a range). Server downloads go through one `downloadFromUrl` helper with a failure toast, never `window.open`. |
| Print | "Print" means the browser print dialog. "PDF" means a real PDF file. A button never says one and does the other. |
| Confirm | `confirmAction()` (the `ConfirmHost` promise API) for simple yes/no; `ConfirmDialog` when the dialog needs custom content. No `window.confirm`. Every delete is confirmed. |
| Action wording | **Add <thing>** to create a record, **Save** / **Saving…** on forms, **Update** when editing an existing voucher, **Delete**, **Refresh** (icon `RefreshCw`), **Export**, **Print**, **Clear filters**. Edit icon is `Pencil`. |
| Toasts | Sentence case. The title names the action ("Export failed"), never a bare "Error". |
| Tables | shadcn `Table` (or `ErpListTable` for standard lists). Numbers right-aligned with `tabular-nums`. Pagination through `PaginationBar`. |
| Filters | `SearchField` for search, `PeriodFilter` for date ranges, shadcn `Select` for dropdowns. |
| States | `LoadingState` / `EmptyState` / `ErrorState` from `components/ui/page-state`. Every query-backed page has an error branch. |
| Numbers | `formatAmount` / `formatMoneyDisplay` and one quantity/weight helper. No hard-coded `$`. |
| Status | `StatusBadge` with one colour meaning per status across the system. |

## Phases

Each phase is merged to `main` on its own after typecheck, lint, the frontend
test suite and a production build pass.

| # | Phase | What it delivers | Status |
|---|---|---|---|
| 0 | Audit and plan | This document and the archived audit | Done |
| 1 | Shared foundations | `ReportExportMenu` for all company types, `exportFileName`, `downloadFromUrl`, `?tab` + `?section` fallback in `useHubQueryState`, shared quantity/weight format helper, bale/voucher status colour map | Done — `formatQuantity` / `formatKg` / `formatCount` added in the close-out (see [closeout.md](closeout.md)) |
| 2 | Broken and misleading things | Wrong back links, missing Payments Log button, mislabelled export/print buttons, unconfirmed deletes, every `window.confirm`, wrong Shops wording, dead buttons, stale shortcuts and redirects | Done |
| 3 | Dead code | Unrouted pages, superseded versions, dead dialogs, unused `lazyPages` exports, unused primitives | Done (the dead Run Payroll step-1 branch removed in close-out 2) except modules still pinned by tests or verify scripts, and the routed POS dashboard / POS settings / Properties legacy dashboard (owner decisions; see [closeout.md](closeout.md)) |
| 4 | Export and print | Every existing export moved to the standard menu, labels, icon, filename and download helper; exports added to list/report pages that have none | Done: close-out 2 added Excel to the Factory sales lists and statements, the `/accounting/*` workpapers, Analytics account sections, both comparison pages and the POS/Retail lists, and moved every report and statement pop-up onto `lib/printDocument`. Left: server-paged lists (Stock Query, Stock Entry History, audit/login history, Retail inventory and sales history), repair tools, label/barcode print layouts (kept on purpose), the V5 allocation workbook styling (5/3) and the server receipt PDF (7/9) (see [closeout.md](closeout.md)) |
| 5 | Headers, hubs and tabs | `PageHeader` everywhere, double titles removed, all hubs on default pill tabs with URL state, tab labels match page titles and sidebar labels | Done (Daybook tab state moves with phase 9) |
| 6 | Actions and wording | Create/save/delete/refresh labels and icons, toast titles, one confirm pattern replacing hand-built `AlertDialog` deletes | Done |
| 7 | Filters, tables and states | `SearchField`, `PeriodFilter`, shadcn `Select`, shared states and `PaginationBar` on every list page | Done (7a, 7b, 7c) |
| 8 | Formatting and status colours | Local formatters and hard-coded `$` replaced; local status maps replaced by `StatusBadge` | Done |
| 9 | Cross-company convergence | Factory and POS Daybook onto the ERP Daybook frame; rental pages on one header and one navigation model; Settings on one save model; voucher forms on one action bar, save label and shortcut set; ERP payroll tabs URL-backed | Done (9a–9f) |
| 10 | Guard rails | Lint/audit ratchets so new code cannot reintroduce `window.confirm`, raw export code, bare `<h1>` page titles or a hub tab held only in component state | Done |

## Owner decisions

Answered by the owner on 2026-11-16.

| # | Question | Decision | Where it lands |
|---|---|---|---|
| 1 | Factory Employees vs Workers | Keep both; give them the same features (export, attendance print, detail tabs) | Phase 9 |
| 2 | POS vs Retail POS | Keep two sale screens; make them share the cart, payment panel, buttons and layout. No full merge | Phase 9 |
| 3 | Dispatch Batches vs Loading Dispatch | Only Loading Dispatch (the Dispatch button on the container loading scan) is used. Retire Dispatch Batches; existing batch records stay readable wherever invoices and bale tracking link to them | Phase 9 |
| 4 | Stock Allocation V2 and V3 | Only V5 is used. Retire V2 and V3; old links redirect to V5 | Phase 9 |
| 5 | Two voucher edit screens | Keep the one the Daybook Edit button opens (`/vouchers?edit=`). Retire `/vouchers/:id/edit`; its links (Stock Item, Location Vouchers, Optional Vouchers) and the Factory/Properties equivalents move to the keeper first | Phase 9 |
| 6 | Supplier Partner Overview, Opening Stock, Aliases, Golden Coast | Remove completely, without breaking anything that still uses their data | Phase 9 |
| 7 | Payroll for Properties | Intended for now; may be added later | No change |
| 8 | POS shell | Move POS onto the shared shell | Phase 9 |
| 9 | Rental titles without "ERP —" / "Factory —" | Keep removed | Done |
| 10 | Container detail "Print" that saves a PDF | Relabel "Export PDF" | Phase 6 |
| 11 | "Export PDF" offline falls back to the print dialog | Show "PDF needs a connection" instead | Phase 6 |
| 12 | Factory bilingual invoice menu without group headings | Fine as is | Done |

## Progress log

| Date | Phase | Change |
|---|---|---|
| 2026-11-13 | 0 | Audit completed and archived; plan written |
| 2026-11-13 | 2 | All 14 native `window.confirm` calls replaced by `confirmAction`; confirmation added to four unconfirmed deletes (bale product image, label banner, loading priority, SP alias); Factory employee/worker back links fixed (`?section=`); Payments Log button added to Factory and ERP warehouse rentals; Shops tab no longer shows warehouse wording/icon; "Export CSV" (writes xlsx), two "Export PDF" (print dialog) and a duplicate "Save PDF" button corrected; full-page reload navigation replaced in Stock & Sales Report and Factory Settings; Merge Bale Products returns to Factory Settings; Alt+S opens Stock Allocation V5 |
| 2026-11-14 | 1 | `components/export/ReportExportMenu` (`ReportExportMenu`, `ExportButton`), `lib/exportFile` (`exportFileName`, `downloadFromUrl`); `confirmAction` gained a `details` list so confirmation sentences stay translatable |
| 2026-11-14 | 4 | Existing export/print controls migrated in ~110 files across every company type: ~85 buttons to `ExportButton`, 5 menus to `ReportExportMenu`, ~125 file names to `exportFileName`, ~33 `window.open`/anchor downloads to `downloadFromUrl` (failures now show a toast instead of downloading an error page), ~45 hand-built blob downloads to the shared helpers; labels that misstated the format corrected (Transporter Statement "Print / Export PDF" saves an image → "Export Image"; several "Print / Save PDF" that open the print dialog → "Print"; Mix Batches "Report" → "Export Excel") |
| 2026-11-14 | 3 | Removed code nothing could reach: the never-opened `components/VoucherEditDialog` and its three helper modules, four retail files with no importer (`RetailQuickAdd`, `RetailStockOperations`, `RetailImportDialog`, `RetailMovementHistory`), `FactoryLoadingDispatchAllocation`, `ContainerPlannerPhase1`, `ProductionTargetSummaryTiles`, `components/Can`. Kept: unreachable modules still pinned by source tests or verify scripts (production-bonus panels, `LedgerBalancePanel`, `SpContainerExcelImport`, `financial-screen`, `operations-screen`, `stockentryhistory/reports*`) |
| 2026-11-14 | 5 | Page headers: ~50 bare page titles and ~16 hand-built hero banners moved to `PageHeader` across ERP (13 accounting pages, Tracking Hub, GIT Containers, Stock Items, Location Inventory, Bale Products), Factory (hubs, invoicing, loading, allocation V5, payroll hub, raw stock), POS, Retail, Supplier Partner, Settings (now shown in every company type) and Vouchers (one header for ERP/Factory/Properties); 17 duplicate titles inside hub tabs removed (components also routed on their own take an `embedded` prop); Production Intel, Supplier Intel and Factory Import hubs gained a header; 15 hand-built back buttons folded into `PageHeader`; ERP/Factory rental titles drop the "ERP —" / "Factory —" prefix to match Properties. Kept: POS selling screens, scanner-station kiosk header, print layouts, the Location Inventory landing KPI hero, Properties rental hero (now fed the same title/subtitle/actions) |
| 2026-11-16 | 5 | Hubs and tabs: `useHubQueryState` follows in-app navigation (a sidebar or Command Palette link to another tab of the open hub now switches it); nine Factory hubs (Payroll, Workers, Employees, Parties, Supplier Intel, Production Intel, Invoicing, Loadings, Bale Explorer) wait for access before settling the URL, so deep links and back links no longer fall back to the first tab, and show the shared loading and translated "no tabs" states instead of nine English-only messages; Settings remembers its open section in `?section=` and its POS Setup, Sessions & Users, Files & Export and Export Center tabs in `?tab=`; hand-styled tab strips in Factory Parties (and its gradient banner), Factory Workers, Factory Daybook and Accounts moved to the default style; the Command Palette's Net Profit, Cash Flow and Profitability entries, which all opened the Net Position page, folded into one Net Position entry, and the unused `?section=` values on that page's and the Containers hub's links removed |
| 2026-11-17 | 7a | About 90 hand-built search boxes moved to `SearchField` and about 85 plain `<select>`s to the shared `Select` (empty-value options map back through a sentinel so stored state is unchanged); scanner inputs, popover comboboxes and test-driven selects left as they were |
| 2026-11-17 | 7b | Page and card-level loading text, "No … found/yet" messages and missing error branches on list and report pages moved to `LoadingState` / `EmptyState` / `ErrorState` (with Try again); about 85 pages that showed nothing or an empty list when their query failed now show an error |
| 2026-11-17 | 7c | Six hand-built pagers moved to `PaginationBar`; 19 hand-built From/To date pairs on list and report filters moved to `PeriodFilter`, which gained open-ended custom ranges ("Start date only" / "End date only") so no page loses one-sided filtering (owner decision 2026-11-17). Kept: the transaction journal pager (test-driven), Cost Center Reports' From/To (its reports need a bounded period), form date fields and export/action ranges |
| 2026-11-17 | 8 | Local status colour maps and pills on list, report and scanner pages moved to `StatusBadge` (new kinds for pressing, reservation, verification and in-transit/arrived/offloaded/closed states; every pill keeps its exact label); hand-built `$` strings moved to `formatMoneyDisplay` through a new `formatUsd` helper with the same decimals and separators, so no visible amount changes. Kept: chart colours, scanner row tints, export builders and amounts in translated sentences |
| 2026-11-17 | 9a | Retired screens the owner no longer uses (owner decisions 3–6). Stock Allocation V2 and V3 removed; their URLs open V5. Supplier Partner Overview, Opening Stock, Aliases and Golden Coast removed; their URLs open SP Reports, now the SP home (server routes and data kept; owner confirmed the sale-reversal, opening-stock, alias and Golden Coast settlement screens are not needed). The separate voucher edit page (`/vouchers/:id/edit` and its Factory and Properties copies) removed: Stock Item, Location Vouchers, Stock Movement, Stock Item Detail and Optional Vouchers links open the Daybook editor through `voucherEditPath` / `resolveVoucherEditDestination`, and old URLs look up the voucher type and forward there. Dispatch Batches list and the proforma card's "Create dispatch batch" button removed; `/factory/dispatch-batches` keeps its page key and landing role and now shows Container Loadings (the Dispatch button), only to users who may open Invoicing loadings and have neither dispatch tab hidden; batch detail and ride scan unchanged |
| 2026-11-17 | 9b | ERP, Factory and POS Daybooks render one shared frame (`components/daybook`: header with export menu, KPI strip, tabs, results shell, loading/error/empty states) and one filter bar (period with previous/next day and "-"/"+" keys, search, page dropdowns, chips, Reset Filters), each with its own data, columns and permissions; Daybook tabs live in `?tab=`; Factory and POS tables move to `ErpListTable` with pagination; POS gains an error state |
| 2026-11-17 | 9c | Factory Employees and Workers share one set of people components (hub tab strip, KPI cards, roster toolbar and filters, name/status cells, row actions, form dialog, detail info cards, attendance panel). Employees gain Excel/PDF export, filters, detail tabs (Profile, Statement, Advances, Attendance) and attendance print/Excel; Workers gain an Attendance detail tab; statements export on both; detail tabs live in `?tab=`. Gaps that need server work are listed below |
| 2026-11-17 | 9d | POS and Retail POS render shared sale parts (screen frame, header and submit button, checkout fields, cart grid, rows and totals) with their own pricing, tenders and posting (owner decision 2); POS runs inside the shared shell (top bar and sidebar parts) with its navigation, permissions, offline/sync, scanner and shift lock unchanged (owner decision 8) |
| 2026-11-17 | 9e | One `VoucherActionBar` (placement, button order, "Save Voucher" / "Update Voucher", Cancel when editing) and one shortcut hook (Ctrl/⌘+Enter saves, Esc cancels an edit) on every voucher form; Settings sections on one per-section Save model with an unsaved-changes bar (floating widgets, date format, POS receipt and company timezone moved off auto-save; instant toggles and actions kept); ERP payroll sections and tabs in `?section=`/`?tab=`; payroll "Error" toasts name the failed action |
| 2026-11-17 | 9f | Rental pages in ERP, Factory and Properties use one title source and one `PageHeader` layout; a shared Rentals hub tab row (Properties keeps `?tab=`, ERP and Factory tabs move between their existing guarded routes); the payments log gains an Excel export menu; rental lists use the shared states and `SearchField` |
| 2026-11-17 | 10 | `npm run audit:ui-unification` (scripts/audit-ui-unification-ratchet.mjs, baseline config/ui-unification-ratchet.json) runs in CI's repository audits: per-file ratchets on native confirms, raw export code outside the export helpers, bare page `<h1>`, hub tabs held only in component state and hand-built `$` amounts. Leftovers fixed: transaction journal pager on `PaginationBar`, the last local status colour maps on `StatusBadge`, about 40 two-decimal USD amounts with thousands separators, Factory Others' redundant `useSearch`, a failure toast on the POS price list export and a pop-up-blocked toast on payroll bulk-bonus print |
| 2026-11-17 | Close-out | Phases 1–4 checked finding by finding against the audit ([closeout.md](closeout.md): 94 rows). New shared `RowsExportMenu` (one Excel item through `exportOperationalWorkbook` and `exportFileName`, hidden without the `export` / `exp_excel` permission the Suppliers export uses) added to 33 list and report pages that had no export — ERP stock ledgers and summaries, Stock Transfers, Offload search/detail, Bale Ledger, Deleted Items, Company Transfer history, Suppliers, Ledger Vouchers; Factory KPIs, Production Summary/Overview, Waste, worker drill-down, Product Comparison, pressing totals and hourly targets, Sheets & Sacks log, stock item detail, in-stock bales, bale product history, raw stock and Stock Query inventory; each writes exactly the rows and columns on screen. Shared `formatQuantity` / `formatKg` / `formatCount` in `lib/formatNumber` replace twelve local kg/count formatters with identical output. Two stale redirects fixed (`/location-summary`, `/combined-inventory`), a full-page-reload back link and a duplicate "Bulk Advance" button that opened the single-advance dialog removed; dead code removed (unreachable `ContainerDetailSpView`, Settings' never-opened Delete User dialog, empty imports). Server-paged lists and items needing the owner are listed in closeout.md |
| 2026-11-18 | Close-out 2 | Shared `RowsExportMenu` Excel export (same `useCanExportExcel` check, exactly the rows and columns on screen, no new endpoints) added to about 40 more pages: Factory Invoices, Containers, Shipping, Container Tracking, Pending Loadings, sale-returns history and Transporters; supplier, broker and insurance statements, scoreboard, suppliers directory, insurance members, contacts, bonuses, advances, repayments and deductions; nine `/accounting/*` workpapers; Analytics account and expense sections; Company and Stock & Sales comparisons; POS containers OTW, transfer orders and the Retail dashboard. New `lib/printDocument` (open, write, wait for load, print, "Pop-up blocked" toast) now drives every report and statement pop-up with unchanged HTML; label and barcode layouts keep their own windows. Containers toolbar "Add" relabelled "Import PO"; the never-rendered Run Payroll step-1 branch removed after a behaviour test pinned the run/history screens. Left open on purpose: 5/3 (V5 export styling) and 7/9 (server receipt PDF); owner items: POS dashboard/settings and the Properties legacy dashboard |

### Follow-ups found during phase 4

- `lib/containerExportEnhancements.ts` replaces `window.print` on `/containers/:id`, so that page's "Print" item saves a no-cost PDF first. Decide whether it should be labelled "Export PDF" or stop overriding print.
- ProformaCard and the customer statement fall back to the print dialog for "Export PDF" when offline.
- Done (phase 10): `usePosPriceListModel.exportToExcel` has no `catch`, so a failed export shows no message; payroll bulk-bonus print does nothing when pop-ups are blocked. The export now shows the standard "Export failed" toast and the print shows the "Pop-up blocked" toast.
- The Factory bilingual invoice menu lost its English / Arabic group headings (the language is now in each item's label). Left as is: owner decision 12 ("Fine as is"), and `ReportExportMenu` has no group support.
- Direct `exceljs` / `xlsx-js-style` imports remain in POS and the V5 allocation export (styling parity to be checked before moving them to `excelHelper`). Since phase 10 these and every other raw export import are frozen per file by `npm run audit:ui-unification`.

### Follow-ups found during phase 5

- Done (phase 10): Factory Others keeps its own `useSearch` effect for sidebar navigation; it is now redundant with the hook and can be removed.
- ERP and Factory Daybook tabs (Transactions / Edits & Activity) are still component state; they move to `?tab` with the Daybook convergence in phase 9.
- Settings sections that hold their own forms still use three save models (phase 9).
