# Factory Mode Mobile Audit — Status

Presentation-only work: no API, query-key, calculation, permission, mutation or schema changes. Desktop (≥ `sm`/`md`) keeps its tables and layouts; phones get cards, stacked forms and pinned workflow actions.

Rendered certification: `scripts/verify-factory-mobile-browser.mjs` (see `docs/mobile-tablet-web-regression.md`), run in the UI Quality → Mobile Responsiveness job at 320×568, 360×800, 390×844, touch landscape 844×390, tablet 768×1024 and desktop 1440×900 over 35 canonical routes and 8 seeded detail/workflow routes. The Wave 4 smoke continues to protect the Factory floor screens.

## Shared building blocks

| Piece | What it does |
|---|---|
| `<Table mobileLayout="cards">` | Restacks record tables as labelled cards on ERP **and Factory** phone layouts (`mobile-card-table.ts` / `mobile-card-table.css`). Labels come from the column headers; authors can mark cells `field`, `wide`, `title`, `actions`. One markup, one data model, no duplicated calculations. |
| `mobile-shell-dialogs.css` | ERP's phone dialog behaviour (bottom sheet within the visible viewport, sticky header/close, pinned footer, keyboard lift) now also applies in the Factory shell. |
| `factory-mobile-operations.css` | Factory-scoped: hover-revealed actions visible on touch, popovers clamped to the phone width, flex columns kept single-line on phones (the `index.css` wrap rule made page columns grow to their widest child and split the drawer), notes button lifted above workflow bars, sideways tab strips. |
| `FactoryMobileActionBar` + `FACTORY_MOBILE_ACTION_BAR_CLEARANCE` | Safe-area-aware bottom workflow bar on phones; clearance accounts for the two-row bar below 360px. |
| `Tabs` | Active tab kept in view inside sideways-scrolling tab strips. |
| Sidebar drawer | Width `min(18rem, 100vw − 1rem)`, closes as soon as a destination is chosen, 44px rows, drag handle hidden on touch, active link scrolled into view. |

## Phase status

| Phase | Status |
|---|---|
| 1 Shell & sidebar | Done (drawer width/close/touch sizes, hover-only reorder handle removed on touch, safe areas via the shared bars). |
| 2 Data pattern | Done via `mobileLayout="cards"`, `ErpMobileRecordCard`, shared dialog/popover rules. |
| 3 Top-level pages | Contacts, Sheets & Sacks, Dashboard, KPIs, Alerts → cards; Daybook columns and filters reflowed for phones; View Entry uses the shared phone sheet. |
| 4 Accounting | The shared account statement already had a phone header, summary grid and transaction cards; verified in Factory mode. |
| 5 Sales / invoice / loading | Invoice Create finalize bar; Pending Invoice Verify action bar, popover clamp, proforma cards; Invoice Loading Scan progress/bale cards and Complete/Cancel bar; Invoice Detail line cards; Proforma Add Line padding and safe area. |
| 6 Dispatch | Batch list and detail tables (rides, scans, proforma dialogs) → cards; scan screen regression-tested. |
| 7 People | Customer statement and price list → cards with a full-width note field and phone header; worker and employee detail (all tabs, payroll batches) → cards, stacked columns on phones. |
| 8 Rentals | Shops/Warehouses use the existing rental cards in Factory; payments log → cards. Properties Mode unchanged. |
| 9 Intelligence | Hubs use the shared scrolling tab strip; Production Comparison defaults to cards with a “Table view” toggle, tap-to-open worker breakdown, preset select below `xl`; hover-only actions visible on touch. |
| 10 Forms | Container Create stacks fields and charge lines, pinned Cancel/Create. |
| 11 Remaining routes | Covered by the rendered regression where the fixture has data; operational tables in stock query, bale product history, OTW/container lists, supplier and broker statements, admin tools opted into cards. |
| 12 Registry drift | `docs/factory-navigation-registry.md` reconciled; `/factory/pos` recorded as retired (live route redirects). Guarded by `tests/ui/factory-mobile-route-registry.test.ts`. |
| 13 Browser coverage | `scripts/verify-factory-mobile-browser.mjs`, wired into CI with seeded records. |

## Known follow-ups

- Tables that are empty in the CI fixture are not exercised with rows; `ERP_FACTORY_MOBILE_STRICT_TABLES=1` turns remaining sideways-scrolling tables into failures once richer seed data exists.
- Stock Entry's “Bales ready for stock entry” table scrolls sideways in touch landscape (protected Factory floor screen, left as is).
- The draggable notes button can overlap content in touch landscape; it stays user-movable.
- Restoring Factory POS would need a product decision plus a sidebar/access entry and a real route.
