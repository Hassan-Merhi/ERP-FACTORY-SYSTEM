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
| 4 | Mobile cards instead of desktop tables | Pending | — |
| 5 | Mobile forms and dialogs | Pending | — |
| 6 | Simplify dense ERP screens | Pending | — |
| 7 | Mobile actions and touch behaviour | Pending | — |
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

