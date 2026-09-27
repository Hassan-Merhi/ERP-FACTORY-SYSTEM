# Factory Mode Mobile Audit — Status

Presentation-only work: no API, query-key, calculation, permission, mutation or schema changes. Desktop (≥ `sm`/`md`) keeps its tables and layouts; phones get cards, stacked forms and pinned workflow actions.

Rendered certification: `scripts/verify-factory-mobile-browser.mjs` (see `docs/mobile-tablet-web-regression.md`), run in the UI Quality → Mobile Responsiveness job at 320×568, 360×800, 390×844, touch landscape 844×390, tablet 768×1024 and desktop 1440×900 over 70 routes (canonical pages, every hub section, forms and admin tools) and 18 seeded detail/workflow routes. The Wave 4 smoke continues to protect the Factory floor screens.

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
| 1 Shell & sidebar | Done: drawer width/close/touch sizes, no hover-only reorder handle on touch, active link in view, safe areas via the shared bars. |
| 2 Data pattern | Done: `mobileLayout="cards"`, `ErpMobileRecordCard`, shared dialog/popover rules; multi-control filter bars use `ErpMobileFilters` (Daybook, Production Comparison) or an existing collapsible panel (Workers, OTW tracking). |
| 3 Top-level pages | Done: Contacts, Sheets & Sacks, Dashboard, KPIs, Alerts → cards; Daybook columns and filters reflowed; View Entry uses the shared phone sheet. |
| 4 Accounting | Done: statement phone header (title, balance, visible PDF/WhatsApp, the rest in the Actions menu), summary grid and transaction cards; monthly ledger cards and stacked summary. |
| 5 Sales / invoice / loading | Done: Invoice Create bale cards and finalize bar; Pending Invoice Verify action bar, popover clamp, proforma cards; Invoice Loading Scan cards and Complete/Cancel bar; Invoice Detail line cards; Proforma Add Line sticky header/search and safe-area bar. |
| 6 Dispatch | Done: batch list/detail tables and proforma dialogs → cards; scan screen regression-tested. |
| 7 People | Done: customer statement and price list, worker and employee detail with every tab, payroll batches → cards; stacked detail columns on phones. |
| 8 Rentals | Done: shops/warehouses cards and payments log cards in Factory; Properties Mode unchanged. |
| 9 Intelligence | Done: every hub section rendered; Production Comparison cards + Table view, tap-to-open worker breakdown, preset select below `xl`; Production Summary cards; Net Position amounts kept on one line; hover-only actions visible on touch. |
| 10 Forms & admin | Done: Container Create; Opening Balance edit, master-data create, settings, customer logos, label banners, chatbot/intel settings, conflicts, deleted items, diagnostics, inventory repair, data reset and raw-stock recalculation (tables → cards) rendered and reviewed. |
| 11 Detail routes | Done: stock query detail, bale product history (product, year, month), monthly ledger, ledger vouchers, voucher detail and edit, proforma add-line, container detail and OTW dialogs rendered with data. Voucher detail under `/factory` was broken for every voucher (route matched only the ERP path) and is fixed. |
| 12 Registry drift | Done: registry reconciled; `/factory/pos` recorded as retired. Guarded by `tests/ui/factory-mobile-route-registry.test.ts`. |
| 13 Browser coverage | Done: `scripts/verify-factory-mobile-browser.mjs` — 88 routes (canonical pages, every hub section, forms/admin tools, 18 seeded detail/workflow routes) × 6 viewports, with seeded data (`scripts/lib/factory-mobile-fixture.mjs`), a safe dialog per route (fits, scrolls, last action reachable, focused field visible, Escape closes without navigating) and Escape navigation rules. Runs in CI. |

## Known limits

- Stock Entry's "Bales ready for stock entry" table scrolls sideways in touch landscape (protected Factory floor screen, left as is; reported as a warning).
- The draggable notes button can overlap content in touch landscape; it stays user-movable and floats above workflow bars on portrait phones.
- The on-screen keyboard cannot be emulated headlessly; the regression checks that a focused dialog field is inside the visible viewport, and `useVisualViewportMetrics` lifts phone dialogs above the real keyboard.
- Restoring Factory POS would need a product decision plus a sidebar/access entry and a real route.
