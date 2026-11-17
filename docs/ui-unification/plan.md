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
| 1 | Shared foundations | `ReportExportMenu` for all company types, `exportFileName`, `downloadFromUrl`, `?tab` + `?section` fallback in `useHubQueryState`, shared quantity/weight format helper, bale/voucher status colour map | In progress (export pieces done) |
| 2 | Broken and misleading things | Wrong back links, missing Payments Log button, mislabelled export/print buttons, unconfirmed deletes, every `window.confirm`, wrong Shops wording, dead buttons, stale shortcuts and redirects | In progress |
| 3 | Dead code | Unrouted pages, superseded versions, dead dialogs, unused `lazyPages` exports, unused primitives | In progress (unreferenced code removed; routed legacy pages wait on owner decisions) |
| 4 | Export and print | Every existing export moved to the standard menu, labels, icon, filename and download helper; exports added to list/report pages that have none | In progress (existing exports migrated; missing exports not yet added) |
| 5 | Headers, hubs and tabs | `PageHeader` everywhere, double titles removed, all hubs on default pill tabs with URL state, tab labels match page titles and sidebar labels | Done (Daybook tab state moves with phase 9) |
| 6 | Actions and wording | Create/save/delete/refresh labels and icons, toast titles, one confirm pattern replacing hand-built `AlertDialog` deletes | Not started |
| 7 | Filters, tables and states | `SearchField`, `PeriodFilter`, shadcn `Select`, shared states and `PaginationBar` on every list page | Done (7a, 7b, 7c) |
| 8 | Formatting and status colours | Local formatters and hard-coded `$` replaced; local status maps replaced by `StatusBadge` | Done |
| 9 | Cross-company convergence | Factory and POS Daybook onto the ERP Daybook frame; rental pages on one header and one navigation model; Settings on one save model; voucher forms on one action bar, save label and shortcut set; ERP payroll tabs URL-backed | Not started |
| 10 | Guard rails | Lint/audit ratchets so new code cannot reintroduce `window.confirm`, raw export code, bare `<h1>` page titles or a hub tab held only in component state | Not started |

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

### Follow-ups found during phase 4

- `lib/containerExportEnhancements.ts` replaces `window.print` on `/containers/:id`, so that page's "Print" item saves a no-cost PDF first. Decide whether it should be labelled "Export PDF" or stop overriding print.
- ProformaCard and the customer statement fall back to the print dialog for "Export PDF" when offline.
- `usePosPriceListModel.exportToExcel` has no `catch`, so a failed export shows no message; payroll bulk-bonus print does nothing when pop-ups are blocked.
- The Factory bilingual invoice menu lost its English / Arabic group headings (the language is now in each item's label).
- Direct `exceljs` / `xlsx-js-style` imports remain in POS and the V5 allocation export (styling parity to be checked before moving them to `excelHelper`).

### Follow-ups found during phase 5

- Factory Others keeps its own `useSearch` effect for sidebar navigation; it is now redundant with the hook and can be removed.
- ERP and Factory Daybook tabs (Transactions / Edits & Activity) are still component state; they move to `?tab` with the Daybook convergence in phase 9.
- Settings sections that hold their own forms still use three save models (phase 9).
