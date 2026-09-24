# ERP Mobile Program

Reference for the ERP phone experience: the shared contracts every ERP screen
uses on phones, how they are verified, and the program's phase status. Factory,
Properties, Supplier Partner and POS shells are out of scope until every ERP
phase is certified.

## Phase status

| Phase | Scope | Status | PR |
| --- | --- | --- | --- |
| 1 | Mobile shell and navigation simplification | Complete | #1681, #1711 |
| 2 | Standard mobile page header | Complete | #1718 |
| 3 | Mobile filter sheet | Complete | Phase 3 PR |
| 4 | Mobile cards instead of desktop tables | Complete | Phase 4 PR |
| 5 | Mobile forms and dialogs | Complete | Phase 5 PR |
| 6 | Simplify dense ERP screens | Complete | Phase 6 PR |
| 7 | Mobile actions and touch behaviour | Complete | Phase 7 PR |
| 8 | Mobile typography and information density | Pending | — |
| 9 | ERP route-by-route certification | Pending | — |
| 10 | Mobile polish and final certification | Pending | — |

## Shared contracts

### Page header (`client/src/components/PageHeader.tsx`)

Every ERP page title is rendered by `PageHeader`. Pages do not wrap it in their
own title/action flex rows, render a second Back button, or place icons and
actions beside it.

| Prop | Purpose |
| --- | --- |
| `title`, `icon` | Page title with an optional inline icon. |
| `subtitle` | Explanatory copy. Hidden on ERP phones, shown from `sm`. |
| `meta` | Contextual line (record, period, company, status badges). Visible at every width. |
| `children` | Page actions. Permission-gated actions render `false`; the action row only renders when an action is visible. |
| `backTarget` | Deterministic Back destination (history-first in ERP). |
| `onBack` | Page-specific Back behaviour that replaces the shared handler (tab or query restoration, full reloads). |
| `backButtonTestId` | Keeps a legacy page's Back test id stable. |

ERP layout:

- **Phones:** a lone Back control sits inline before the title; actions wrap
  into evenly filled rows under the title and keep their full labels.
- **`sm` and up:** navigation sits on its own row, and the title and actions
  share a row with actions aligned to the end (unchanged desktop layout).
- **Factory, Properties and POS:** these modes keep the established header
  layout (`data-erp-mobile-header` is absent).
- **Print:** shared navigation and header actions are hidden.

Pages that intentionally keep a panel-owned heading instead of a page header:

| Route | Reason |
| --- | --- |
| `/agents` | Master/detail ledger tool; the Phase 1 master/detail phone layout is keyed to its root element. |
| `/chat` | Messaging workspace with a fixed-height conversation layout. |
| `/spreadsheet` (open workbook) | Full-bleed editor toolbar; the library view uses `PageHeader`. |

### Dialogs and forms (`client/src/erp-mobile-operations.css`)

- On ERP phones every `DialogContent` / `AlertDialogContent` opens as a bottom sheet: full
  width, anchored above the home indicator, rounded on top, and at most the visual viewport
  high.
- The action row stays pinned while the form scrolls. Action rows are `DialogFooter` /
  `AlertDialogFooter`, plus the button-only row that closes a dialog form or sits last in a
  dialog. A two-action row shows Cancel and the primary action side by side.
- Page forms stretch their closing submit row across the width.
- Checkboxes, radios and switches keep their visual size with an invisible 44px touch
  extension. The Phase 1 44px button floor had turned them into large tiles.
- Tablet and desktop keep the centred modal and existing form layouts.

### Record tables as phone cards (`client/src/components/ui/mobile-card-table.ts`)

Record tables opt in with `<Table mobileLayout="cards">`. Raw `<table>` markup opts in with
`useMobileCardTable()` by spreading its `tableProps`. On ERP-mode phones each body row
becomes a card, and tablet/desktop keep the table.

- Labels come from the column headers. Grouped headers (`rowSpan`/`colSpan`) combine, for
  example "Inwards · Qty".
- The first record cell becomes the card title. A checkbox-only cell becomes a leading
  selector, and an unlabelled cell holding only controls becomes the action row.
- Unlabelled decoration (row chevrons) is hidden. A cell spanning every column (empty and
  loading states) fills the card.
- Pages override the automatic role or label with `data-mobile-cell="title|field|hidden|actions"`
  and `data-label`.
- Fields sit two per row, label over value. Cells hidden on phones by `hidden sm:table-cell`
  are shown again inside cards, where there is room for them.
- Sticky headers, totals and frozen columns are released inside the card stack. Bounded row
  rendering is disabled on phones, because cards have variable heights.
- In Arabic the cards follow the page direction, while numbers keep their LTR isolation.

Matrix tables whose columns must stay side by side keep horizontal scroll. This covers
company and period comparisons, financial statements and editable grids (Phase 5).

`npm run fixture:erp-mobile-program` seeds the certification company through the
application API with stock items, customers, suppliers, containers and journal vouchers, so
that list and card screens render real rows. It is safe to rerun and must never be pointed at
production.

### Filters (`client/src/components/ui/erp-mobile-filters.tsx`)

Filter-heavy ERP screens wrap their filter bar in `ErpMobileFilters`.
`useErpPhoneLayout()` (`client/src/hooks/use-erp-phone-layout.ts`) selects the
phone model: portrait phones under `sm`, and short coarse-pointer landscape
phones, matching `erp-mobile-operations.css`.

- **Tablet and desktop:** the page's own filter bar renders unchanged
  (`children("inline")`), with no extra context requirements.
- **Phones:** a `role="search"` row shows the `primary` control (for example the
  period) on its own row, the `quick` controls (usually search), and a
  **Filters** trigger with the active-filter count. The remaining filters open in
  a bottom sheet (`children("sheet")`) with **Clear filters** and **Apply**.
- Controls keep their live bindings to page state, so query parameters, API
  requests, date handling and permissions are unchanged. **Apply** just returns
  to the results.
- `ErpFilterSheet` is exported for pages that already own a Filters toggle
  (GIT containers).
- Sheet strings use `mobileFilters.*` translation keys. Sheet titles are
  translated through `sharedInterfaceTranslations`.

## Verification

`scripts/verify-erp-mobile-program.mjs` signs in once, switches to the ERP
fixture company and visits every ERP route at each viewport and language. It
records document overflow, visible header count, raw `<h1>` titles,
header title/action collisions, off-screen header controls, elements escaping
the viewport, wide phone tables, filter areas that consume the phone screen,
small touch targets and console errors.

```bash
ERP_SMOKE_USERNAME=... ERP_SMOKE_PASSWORD=... \
  node scripts/verify-erp-mobile-program.mjs \
  --viewports=phone-320,phone-360,phone-393,phone-412,phone-landscape,tablet-768,desktop-1440 \
  --languages=en,fr,ar --screenshots
```

Viewports: 320×640, 360×780, 393×852, 412×915, 852×393 (landscape phone),
768×1024 (tablet) and 1440×900 (desktop).

## Phase 2 — Standard mobile page header

Delivered:

- `PageHeader` ERP grid layout (inline phone Back, wrapped phone actions,
  unchanged `sm`+ layout), `meta`, `onBack`, `backButtonTestId`, an accessible
  Back label, an action row that only renders for visible actions, and print
  suppression of header controls.
- Factory/Properties/POS headers restored to their pre-program layout.
- Legacy title/action wrappers, separately rendered icons and page-owned Back
  buttons migrated to the shared contract on: Accounts, Analytics, Bale Ledger,
  Barcode Manager, Chatbot Settings, Closing Stock Detail, Combined Inventory
  (duplicate header removed), Company Data Reset, Conflict Center, Container
  Detail, Container Verification, Deleted Items, Edit Supplier, Import Cycle
  Diagnostics, Import Stock Items, Intercompany Links/Requests, Inventory Repair,
  Ledger Monthly Summary, Ledger Vouchers, Live Sheets, Location Inventory,
  Location Monthly Summary, Location Vouchers, Net Position Details, Net Profit
  Report, Notification Settings, Offload Detail, Offload Item Search, Opening
  Stock Detail, Optional Vouchers, Orphaned Records, PO Import, POS Import,
  Price List, Purchase Order Edit, Sales Report, Sales Report Comparison, Sales
  Details, Settings, Sold Containers, Spreadsheets, Stock In & Sales
  (report/comparison/details), Stock Item Detail/History/Vouchers, Stock OTW,
  Stock Query, Stock Items, Stock Transfer Order, Supplier Profit Check,
  Supplier Proformas, Test Data Import, Tracking, All Daybook, Voucher Detail,
  Voucher Edit, Vouchers, AI Command Center.
- The Tracking hub tabs scroll horizontally instead of overflowing on phones.
- The Import Stock Items Back control now targets `/create` (it pointed at the
  unrouted `/accounting-create`).

## Phase 3 — Mobile filter sheet

Delivered:

- `ErpMobileFilters` / `ErpFilterSheet` and `useErpPhoneLayout` (see Shared
  contracts), with unit coverage.
- Phone filter sheets on Daybook, All Daybook (transaction journal), GIT
  containers (Tracking), Transporter statement, Stock items, Sales report, Sales
  report comparison, Stock in & sales report, Net profit report and Optional
  vouchers. Stock in & sales comparison uses a two-column phone grid instead
  of a sheet, because its bar holds only two controls.
- Remaining phone screens with several inline controls are data-entry forms
  (Create, POS import, Settings, test data import), covered by Phase 5.

## Phase 4 — Mobile cards instead of desktop tables

Delivered:

- `Table mobileLayout="cards"` and `useMobileCardTable()` (see Shared contracts), with
  unit coverage.
- Cards replace desktop tables on: containers on the way (Tracking, Dashboard, Containers
  OTW), Ledger vouchers, Price list, Sales report, Stock in & sales report and details,
  Location vouchers, Location/stock monthly summary, Location summary, Location inventory,
  Combined stock, stock movement dialogs, All Daybook voucher panels, Daybook voucher
  entries, Customer invoice detail, Supplier detail, Sales report items, Bale ledger, Payroll
  advances, Stock report panel, Container detail, Agent statement, Mix batches, Production
  bales and Batch detail.
- The Accounts list uses a fixed phone layout, so long names clamp and balances stay visible.
  Its edit control is visible on touch devices.
- Fixed: Location/stock monthly summary crashed for items without movements.
- The certification fixture (`fixture:erp-mobile-program`).

## Phase 5 — Mobile forms and dialogs

Delivered:

- Bottom-sheet dialogs and alert dialogs, with pinned actions, on ERP phones (see Shared
  contracts). `AlertDialogContent` / `AlertDialogFooter` now expose `data-slot` hooks.
- Page forms get full-width submit rows. Checkbox/radio/switch sizing is fixed, with 44px
  hit areas kept.
- The voucher entry forms already had a dedicated phone design (tap-to-select rows and a
  sticky totals bar); they were verified unchanged.

## Phase 6 — Simplify dense ERP screens

Delivered:

- Containers on the way (Tracking, Dashboard, Containers OTW), phones:
  - the company scope is two equal segments;
  - the summary cards sit in a two-column grid with truncating labels;
  - the toolbar is a full-width search row, then Filters/Columns, then Track All/Actions.

  The first container card is now visible above the fold.
- Payroll: the four section tabs scroll horizontally on phones. The labels used to overlap
  inside equal-width grid columns.
- GIT tracking tabs (Detail, Truck/Location, Agent/Duty, Summary, Port report, WhatsApp):
  on phones the company mode selector is a two-column segment without the decorative
  label, and the Detail search gets its own full-width row.

## Phase 7 — Mobile actions and touch behaviour

Delivered:

- The floating "My notes" button, which covered page content above the bottom navigation,
  is hidden on ERP phones. The workspace "⋯" sheet offers **My notes** instead, only while
  the notes panel is enabled for the user (`user-notes:open` event).
- Hover-revealed row actions (`opacity-0` + `group-hover`) are visible on every ERP route
  on touch devices. Phase 1 had covered five routes explicitly.
- Activity by Company (Financial overview) no longer nests day-navigation buttons inside a
  `<button>`. The header is a keyboard-accessible `role="button"` with `aria-expanded`.
- Certification found no touch targets under 24px on any phone route. The Phase 1 44px floor
  holds, and Phase 5 restored checkbox/radio/switch visuals while keeping 44px hit areas.

