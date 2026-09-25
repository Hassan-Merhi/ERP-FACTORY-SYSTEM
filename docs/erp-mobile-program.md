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
| 3 | Mobile filter sheet | Complete | #1784 |
| 4 | Mobile cards instead of desktop tables | Complete | #1790 |
| 5 | Mobile forms and dialogs | Complete | #1793 |
| 6 | Simplify dense ERP screens | Complete | #1797 |
| 7 | Mobile actions and touch behaviour | Complete | #1798 |
| 8 | Mobile typography and information density | Complete | #1799 |
| 9 | ERP route-by-route certification | Complete | #1800 |
| 10 | Mobile polish and final certification | Complete | Phase 10 PR |

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
| `/agents` | Master/detail ledger tool with a panel-owned heading. On phones it shows the agent list and the statement as separate screens (R2). |
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
- Page forms get full-width submit rows. Checkboxes, radios and switches keep a 44px box (the
  touch target the Mobile Wave 3 gate measures) and draw the familiar 20px box or 24px switch
  track inside it, instead of Phase 1's large bordered tile.
- Dialog styling keys off `html[data-app-shell="erp"]`, which `ErpShell` sets only while it is
  mounted (`useDocumentAppShell`): dialogs portal outside the shell and the stylesheet stays
  loaded after the user leaves ERP, so Factory, POS and Properties dialogs are unaffected.
- The voucher entry forms already had a dedicated phone design (tap-to-select rows and a
  sticky totals bar); they were verified unchanged.

## Phase 6 — Simplify dense ERP screens

Delivered:

- Containers on the way (Tracking, Dashboard, Containers OTW), narrow portrait phones
  (`max-sm:`; landscape phones keep the wrapping layout so the table stays reachable):
  - the company scope is two equal segments;
  - the summary cards sit in a two-column grid with truncating labels;
  - the toolbar is a full-width search row, then Filters/Columns, then Track All/Actions.

  The first container card is now visible above the fold.
- Payroll: the four section tabs scroll horizontally on phones. The labels used to overlap
  inside equal-width grid columns.
- GIT tracking tabs (Detail, Truck/Location, Agent/Duty, Summary, Port report, WhatsApp):
  on phones the company mode selector is a two-column segment without the decorative
  label (long labels wrap inside the column), and the Detail search gets its own full-width
  row.

## Phase 7 — Mobile actions and touch behaviour

Delivered:

- The floating "My notes" button, which covered page content above the bottom navigation,
  is hidden on ERP phones. The workspace "⋯" sheet offers **My notes** instead, only while
  the notes panel is enabled for the user (`user-notes:open` event). The hide rule is scoped to
  the ERP shell; other shells keep the button.
- Hover-revealed row actions (`opacity-0` + `group-hover`) are visible on every ERP route
  on touch devices. Phase 1 had covered five routes explicitly.
- Activity by Company (Financial overview) no longer nests day-navigation buttons inside a
  button. The header is a plain row: a native toggle button (icon, title, chevron,
  `aria-expanded`) with the KPI badges and day navigator as siblings
  (`CountryActivityKPI.test.tsx`).
- Certification found no touch targets under 24px on any phone route. The Phase 1 44px floor
  holds, and Phase 5 restored checkbox/radio/switch visuals while keeping 44px hit areas.

## Phase 8 — Mobile typography and information density

Delivered:

- Phone type floor: 9–10px utility text (badges, stat labels, Dr/Cr suffixes) renders at
  11px on ERP phones, and at 12px in Arabic. A rendered survey of every ERP route at 360px
  found no visible text under 11px afterwards.
- ERP rentals (warehouses/shops): the two-metric Outstanding/Credit card spans both phone
  columns (two of three on landscape phones) instead of clipping Credit. The page title, actions, stat labels and empty state
  are translated in French and Arabic; the empty state and Add button were split
  interpolations the literal translator could not match.
- Earlier phases carry the rest of the density work: compact headers (2), filter sheets (3),
  two-column card fields (4), bottom-sheet dialogs (5) and dense-screen layouts (6).

## Phase 9 — ERP route-by-route certification

Every ERP route in the certification harness was rendered at 320, 360, 393 and 412px portrait,
852×393 landscape, 768px tablet and 1440px desktop, in English, French and Arabic, against the
seeded certification company (`npm run fixture:erp-mobile-program`).

Findings fixed in this phase:

- Tablet (768px): a global `index.css` rule wraps every `.flex.gap-*` container at ≤768px. On
  column containers that sized children to their max-content width, so page headers and
  bodies ran past the workspace beside the sidebar (Daybook, Transaction journal, Stock items)
  and the sidebar footer links wrapped into a second column. ERP column containers (not those
  that become rows at `sm`/`md`) and explicit `flex-nowrap` rows stay single-line
  (`[data-erp-shell]`).
- Page header: the actions column shrinks to what the title leaves (12rem, or half a narrow
  header) and its buttons wrap, so actions never overlap the title (Price list at 768px).
- Top bar at 768–1023px: the account chip shows initials only, so the bar fits beside the
  sidebar.
- GIT tracking workbook: supplier group rows are keyed (React key warning).
- AI chatbot settings: the user access and file tables read as cards on phones.
- Hidden Radix selects are pinned only inside the ERP shell.

Certification result: 1,407 cases (67 routes × 7 viewports × English, French and Arabic),
0 failures and 0 warnings. The harness checks document overflow, header collisions and
off-screen header controls, elements escaping the viewport, wide phone tables, filter areas
that consume the phone screen, touch targets under 24px and console errors.

## Phase 10 — Mobile polish and final certification

Delivered:

- Location inventory: on ERP phones the root-level "Select Location" hint is hidden. It
  repeated the Locations heading directly below it. POS keeps its layout.
- Activity by Company: in Arabic, the collapsed chevron and the day navigator arrows mirror
  (`data-directional-icon`). The subtitle is translated into French and Arabic.

Final certification, on `main` with Phase 10 applied: 1,407 cases (67 routes × 7 viewports ×
English, French and Arabic), 0 failures and 0 warnings.

Known issues outside this program (unchanged by it, red on `main`): the Repository Audits
`applicationRoutes.ts` line cap, the CI-only frontend failures in `phase4-split-pages` and
`period-filter`, Backend / Database Tests, and the github-advanced-security setup step.


## Real-device remediation

A follow-up program for the screens that still felt desktop-first on real phones. Each phase
lands as its own commit; the status of every reported item is tracked at the end of this
section.

### R1 — Shared navigation and dialog foundations

- **One phone navigation model.** The bottom navigation keeps its four areas (Tracking,
  Inventory, Sales, Accounts). **More** now opens the grouped page menu
  (`ErpMobileNavSheet`): every other page the user may open, under section headings, with a
  page search that also matches the localised name. It closes after navigation and never
  repeats a bottom-navigation destination. The header sidebar toggle is hidden on phones (it
  opened the same pages in a second, desktop-style menu); the header "⋯" keeps account,
  language, theme and logout. Tablet and desktop keep the sidebar.
- The off-canvas sidebar (640–767px) no longer splits into two squeezed columns: the global
  `.flex.gap-*` wrap rule is released for `[data-slot="sidebar-content"]`.
- **Keyboard-safe dialogs.** `useVisualViewportMetrics` (mounted by `ErpShell`) publishes
  `--erp-visual-viewport-height` and `--erp-keyboard-inset`. Phone bottom-sheet dialogs and
  bottom sheets sit above the on-screen keyboard and cap their height to the visible viewport,
  so the pinned action row stays reachable while typing; the focused field is scrolled back
  into view when the keyboard opens. Column dialogs with their own scrolling body let that
  body shrink (`min-height: 0`), so the footer is never pushed out of the sheet.
- **Bespoke record cards.** `client/src/components/ui/erp-mobile-records.tsx` adds
  `ErpMobileRecordCard` (title, headline value, two-column fields, collapsible details,
  actions, tap-to-open), `ErpMobileRecordList`, `ErpMobileRecordGroup`,
  `ErpMobileSummaryGrid` (two-column KPIs) and `ErpMobileActionsMenu` (compact Actions
  overflow). They sit on the existing `ResponsiveDataList` primitives and are used where rows do
  not map onto `<Table mobileLayout="cards">`.

### R2 — Accounting and ledger phone workflows

- **Accounts statement.** Below `md` the statement table was hidden (`hidden md:block`) with no
  phone replacement, so a phone showed the KPIs and no transactions. `AccountStatementCards`
  renders the opening balance, one card per transaction (tap opens the voucher, as on desktop)
  and the period totals, paging long statements 100 cards at a time. On ERP phones the account
  header is compact (Back to accounts, name, closing balance) and WhatsApp, Excel, PDF
  (EN/FR/AR), Show Deleted and Delete Selected move into one Actions menu; KPIs use the
  two-column `ErpMobileSummaryGrid`. The page actions and tabs step aside while a statement is
  open. Figures come from the same props as the desktop table.
- **Agent Ledger.** Phones no longer stack a height-capped `w-72` list above the statement.
  State 1 is the full-width list (title, Add Account, search, agents); tapping an agent opens
  state 2, the statement with Back to agents, balance, period, KPIs, card rows and an Actions
  menu (Excel, Print). Desktop keeps the master/detail layout.
- **View Voucher (Daybook and All Daybook).** Every ERP phone dialog now pins its header and
  Close control while the body scrolls. Tables inside phone dialogs and sheets no longer cap
  their own height (Table's default `max-h-[70vh]` region), so there is a single scroll
  container. Daybook entry cards drop the empty Debit/Credit side and the duplicated narration.
  All Daybook's Close/Edit row is a `DialogFooter` (pinned), its ledger entries show Dr/Cr, and
  its item tables become cards.
- **Edit Voucher.** Daybook and All Daybook share `voucherEditPath`, so Edit opens the same
  editor from both (All Daybook used to land on the Daybook list via an ignored `voucherId`
  parameter). The editor itself is the voucher form covered by R3. Daybook's
  `VoucherEditDialog` is never opened by the page; it is unchanged.
- **Edits & Activity** (Daybook tab, and the Settings activity section that reuses it). Phones
  get the shared filter model (search visible, action/module/date filters in the filter sheet)
  and day-grouped activity cards (record, time, user, module, action, concise detail); tapping
  a card opens the existing detail sheet, whose field and entry grids now stack on phones.
  Factory keeps its layout.

### R3 — Voucher entry on phones (all seven types)

- **Voucher type selector.** The phone strip of seven pills showed three types; the rest were
  off-screen. Phones now get one full-width "Voucher type" control that opens a grouped sheet
  (Financial / Adjustments) of every type the user may use (`VoucherMobileTabs`, keeping the
  `tab-mobile-*` ids). Tablet and desktop keep the sidebar nav.
- **Pinned save bar.** `VoucherPhoneActionBar` sticks to the bottom of the workspace on ERP phones
  with the running totals, the validation state and Cancel | Save. Save calls each form's
  existing submit (or submits the enclosing form), so validation and posting are unchanged; the
  form's own Save row does not render on phones, so there is one Save. Cancel appears in edit
  mode and returns to where the voucher was opened from (`useVoucherEditCancel`).
  - Journal: Dr/Cr totals with Balanced / Off by; Save disabled while unbalanced (as on desktop).
  - Stock Transfer: items · qty · total, Save as Revision in edit mode.
  - Stock Adjustment: qty · total. The duplicate desktop totals row and the card-in-card padding
    are gone on phones, which also removes the page's horizontal overflow (378px at 360px).
  - Transfer Order: items · bales, Validate and Save as Revision, Process / Update Order.
  - Credit Note: items · refund, Create / Update Note (Cancel resets an edit); the cart table
    reads as cards and the item picker is bounded on phones.
  - Payment / Receipt keep their existing pinned action bar, now opaque and more compact on
    phones, with Cancel in edit mode.
- **Entry cards.** Journal entries are labelled "Entry N" with Remove beside the label, so the
  account field gets the full row. Journal and Stock Transfer header fields stack full width.
- **Portalled sheets no longer split into columns.** The global `.flex.gap-*` phone wrap rule
  also hit sheets and dialogs portalled outside the shell: the Payment/Receipt entry sheet
  rendered its account list as an off-screen second column. ERP sheets, dialogs and their
  column containers stay single-line.
- While a voucher save bar is on screen, `#main-content` reserves `scroll-padding-bottom`, so a
  focused field or tapped entry scrolls above the bar. The entry sheet caps its height to the
  visible viewport (keyboard) and keeps Done clear of the close control.
- Transfer Order inside the Vouchers page shows a section heading instead of a second page
  header; the standalone `/stock-transfer-order` page keeps its `PageHeader`.

### R4 — GIT tracking and Location Inventory

- **GIT Truck / Location.** Phones get one card per container (container #, supplier, status,
  truck/plate, location, agent, transporter) under the same shop → supplier grouping as the
  table. The desktop table and the WhatsApp image template are unchanged.
- **GIT Agent / Duty.** The agent open-container and in-transit tables opt into the shared card
  layout (`useMobileCardTable`) inside each agent section, so duty, cleared and remaining
  amounts, statuses, the prepaid / reorder controls and the account balance stay available
  without sideways scrolling. The balance cell is labelled "Balance".
- **GIT Detail.** The default workbook view already used cards; the Flat Table view now reads as
  cards on phones too (it was 1313px wide).
- **Shared card fixes.** Card rows ignore desktop row heights (`h-12` rows clipped the Stock Group
  Items cards to their title), and bare icon controls in a card's action row get a 40px hit
  area, laid out in a row.
- **Location → Stock Groups.** On phones: location name with one Actions menu (View All Stock
  Items, Show/Hide zero stock, Excel/PDF exports — the with-cost PDF only when cost is visible —
  and the location's rename, WhatsApp and delete actions); a two-column summary (Groups, Items,
  Qty, and Value only when cost is visible); full-width search and category filter; and one
  card per stock group (items, qty, and average rate/value when cost is visible) that opens the
  group, with its PDF export. The movement From/To filter sits on one row.
- **Stock Group Items / All Items.** Item cards now show the full record (name, code, category,
  quantity with unit, and rate/value when permitted); the name still opens the item history.
- **Translation fix.** A generated Arabic/French catalogue entry held an untranslated,
  truncated source template, so any "N items" text rendered raw template code in Arabic. It now
  maps to "{{0}} عنصر" / "{{0}} article(s)" (catalogue size unchanged).

### R5 — POS phone item sheet

- On phones (the POS mobile layout, used by the ERP and POS shells alike), tapping a search
  result opens `PosMobileItemSheet` instead of adding a line at once. The sheet shows the item
  name and code, available stock, the configured price and the last price it sold at, a
  quantity stepper, the selling price and the line total; **Add Item** puts the line in the
  cart, clears the search and returns focus to it so the next item can be scanned or typed.
  Nothing is posted until Checkout; cart cards keep quantity, price and delete editing.
- No second pricing path: `resolvePosItemRate` (last sold price, else configured price, then
  CFA conversion) is the one resolver for the grid and the sheet, and the sheet adds through
  the existing `selectItem`, which now accepts `{ quantity, rate }` overrides. A typed price
  converts back to USD exactly as editing the Rate cell does. Row placement for a repeated item
  is unchanged (a new line, as in the grid).
- The stock rule runs before the sheet opens (`ensureItemSellable`): an item that may not be
  sold (no stock, no negative-stock permission) shows the existing zero-stock alert instead.
- Desktop and tablet POS (the grid and inventory picker) are unchanged.
