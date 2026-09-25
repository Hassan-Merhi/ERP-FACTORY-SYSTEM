# ERP Mode Navigation Registry

Status: Phase 1 authoritative mapping for the ERP navigation audit.

This registry defines canonical ERP routes, their owning hub or parent page, intended Escape and visible Back behavior, browser-history rules, access handling, and compatibility redirects. It is the source of truth for Phases 2–5.

## Navigation contract

1. Dialogs, popovers, drawers, menus, and other overlays close before page navigation.
2. Escape from an editable control blurs or exits that editor before page navigation.
3. A page-level Escape action and a visible Back button must resolve to the same registered parent.
4. Hub tab changes update the URL with history replacement, not a new browser-history entry.
5. Real page transitions use normal history pushes.
6. Direct-opened or refreshed detail pages return to their deterministic registered parent rather than relying only on `history.back()`.
7. Compatibility and legacy routes redirect with replacement so old bookmarks continue working without adding history noise.
8. Restricted routes redirect with replacement to the safe ERP fallback, `/tracking`.
9. Query strings and hashes are ignored when resolving a route’s parent.
10. No navigation change may alter permissions, APIs, accounting, inventory, costing, or business behavior.

## ERP shell and top-level destinations

| Route | Purpose | Canonical parent / Escape / Back | Access / notes |
|---|---|---|---|
| `/` | ERP home | none | Admin/Developer renders Containers OTW; other users redirect to `/tracking` |
| `/tracking` | Tracking Hub | none | Safe fallback; intended ERP root for restricted users |
| `/financial-overview` | Dashboard | `/tracking` | Sidebar-pinned dashboard |
| `/my-settings` | Personal settings | previous meaningful ERP route, fallback `/tracking` | Always accessible |
| `/chat` | ERP chat | `/tracking` | Non-POS ERP route; sidebar visibility currently Developer-only |
| unknown route | Not Found | `/tracking` | Must not create redirect loops |

## Pinned and primary sidebar routes

| Sidebar item | Canonical route | Parent / Escape / Back |
|---|---|---|
| Tracking | `/tracking` | none |
| Dashboard | `/financial-overview` | `/tracking` |
| Agent Ledger | `/agents` | `/tracking` |
| Daybook | `/daybook` | `/tracking` |
| All Daybook | `/transaction-journal` | `/daybook` |
| Vouchers | `/vouchers` | `/tracking` |
| Inventory | `/inventory` | `/tracking` |
| Stock | `/stock` | `/inventory` |
| Optional Vouchers | `/optional-vouchers` | `/vouchers` |
| Profit Check | `/supplier-profit-check` | `/parties?tab=suppliers` |
| POS | `/pos` | `/tracking` |
| Sales Tools | `/sales-tools` | `/tracking` |
| Accounts | `/accounts` | `/tracking` |
| Account Groups | `/account-groups` | `/accounts` |
| Parties | `/parties` | `/tracking` |
| Payroll | `/payroll` | `/accounts` |
| Company Transfer | `/company-transfer` | `/accounts` |
| Sales Report | `/sales-report` | `/tracking` |
| Stock In & Sales | `/stock-in-sales-report` | `/sales-report` |
| Item Market Analysis | `/item-market-analysis` | `/sales-report` |
| Analytics | `/analytics` | `/financial-overview` |
| Net Profit Report | `/net-profit-report` | `/financial-overview` |
| Shops | `/erp/rental/shops` | `/tracking` |
| Create | `/create` | `/tracking` |
| Spreadsheet | `/spreadsheet` | `/tracking` |
| Live Sheets | `/live-sheets` | `/tracking` |

## Hub and tab routes

Hub tabs must be URL-backed, validated, synchronized with `popstate`, and changed with history replacement.

### Tracking Hub

| Canonical route | Owner | Intended behavior |
|---|---|---|
| `/tracking` plus supported query state | Tracking Hub | Hub root; tab changes replace URL |

### Inventory Hub

| Route | Canonical owner | Legacy / compatibility behavior |
|---|---|---|
| `/inventory` | Inventory Hub default tab | Canonical hub |
| `/inventory?tab=by-location` | Inventory Hub, location inventory | `/location-inventory` redirects here with replace |
| `/inventory?tab=on-the-way` | Inventory Hub, stock OTW | `/stock-otw` redirects here with replace |
| `/inventory?tab=combined` | Inventory Hub, combined inventory | `/combined-inventory` redirects here with replace |

### Stock Hub

| Route | Canonical owner | Legacy / compatibility behavior |
|---|---|---|
| `/stock` | Stock Hub default tab | Canonical hub |
| `/stock?tab=items` | Stock items | `/stock-items` redirects here with replace |
| `/stock?tab=query` | Stock query | `/stock-query` redirects here with replace |
| `/stock?tab=offload` | Offload item search | `/offload-item-search` redirects here with replace |

`/location-summary` currently redirects to `/stock-query?tab=summary`, which then redirects to `/stock?tab=query`; Phase 4 must collapse this chain to the actual canonical Stock Hub destination while preserving the intended summary state.

### Parties Hub

| Route | Canonical owner | Legacy / compatibility behavior |
|---|---|---|
| `/parties` | Parties Hub default valid tab | Canonical hub |
| `/parties?tab=suppliers` | Suppliers | `/suppliers` redirects here with replace |
| `/parties?tab=customers` | Customers | `/customers` redirects here with replace |

### Sales Tools Hub

| Route | Canonical owner | Legacy / compatibility behavior |
|---|---|---|
| `/sales-tools` | Sales Tools default tab | Canonical hub |
| `/sales-tools?tab=transfers` | Stock transfers | `/stock-transfers` redirects here with replace |
| `/sales-tools?tab=daybook` | POS daybook | `/pos-daybook` redirects here with replace |
| `/sales-tools?tab=pricelist` | Price list | `/pos-price-list` and `/price-list` redirect here with replace |

## POS routes

| Route | Purpose | Parent / Escape / Back |
|---|---|---|
| `/pos` | ERP-mode POS | `/tracking` |
| `/pos/edit/:id` | Edit POS voucher | `/pos` |
| `/pos-import` | POS import | `/pos` |

The legacy POS-user `/pos` to `/` redirect must use replacement and remain separate from ERP-mode POS behavior.

## Container and purchasing hierarchy

| Route | Purpose | Parent / Escape / Back |
|---|---|---|
| `/containers` | Container list | `/tracking` |
| `/containers/:id` | Container detail | `/containers` |
| `/containers/:containerId/verification` | Container verification | `/containers/:containerId` |
| `/offloads/:id` | Offload detail | `/containers` |
| `/purchase-orders/:id/edit` | Purchase-order edit | `/containers` |
| `/containers-otw` | Admin/Developer Containers OTW | `/tracking` |
| `/mock-containers-otw` | Admin/Developer mock route | `/tracking` |
| `/sold-containers` | Legacy sold-container route | replace to `/containers` |

## Accounts and ledger hierarchy

| Route | Purpose | Parent / Escape / Back |
|---|---|---|
| `/accounts` | Accounts | `/tracking` |
| `/ledger-monthly/:accountId` | Account monthly summary | `/accounts` |
| `/ledger-vouchers/:accountId/:year/:month` | Monthly vouchers | `/ledger-monthly/:accountId` |
| `/account-groups` | Account groups | `/accounts` |
| `/account-transfer` | Account transfer | `/accounts` |
| `/account-migration` | Account migration | `/settings` |
| `/balance-repair` | Balance repair | `/settings` |
| `/net-position-details` | Net-position details | `/settings` |

## Parties, suppliers, and customers

| Route | Purpose | Parent / Escape / Back |
|---|---|---|
| `/parties` | Parties Hub | `/tracking` |
| `/suppliers/:id/edit` | Edit supplier | `/parties?tab=suppliers` |
| `/suppliers/:supplierId/proformas` | Supplier proformas | `/parties?tab=suppliers` |
| `/supplier-profit-check` | Supplier profit check | `/parties?tab=suppliers` |

Supplier and customer legacy list routes resolve to their exact Parties tab, not merely `/parties`.

## Voucher, daybook, and creation hierarchy

| Route | Purpose | Parent / Escape / Back |
|---|---|---|
| `/vouchers` | Voucher list | `/tracking` |
| `/voucher-detail/:voucherId` | Voucher detail | `/vouchers` |
| `/vouchers/:id/edit` | Edit voucher | `/vouchers` |
| `/optional-vouchers` | Optional vouchers | `/vouchers` |
| `/daybook` | Daybook | `/tracking` |
| `/transaction-journal` | All Daybook | `/daybook` |
| `/create` | Create accounting transaction | `/tracking` |

When a creation or edit page has an explicit source route in its URL or state, Phase 4 may preserve that meaningful source; refreshed pages must still fall back to the deterministic parent above.

## Stock and inventory detail hierarchy

| Route | Purpose | Parent / Escape / Back |
|---|---|---|
| `/stock-query/:id` | Stock-query item detail | `/stock?tab=query` |
| `/stock-items/:id/history` | Stock-item history | `/stock?tab=items` |
| `/stock-items/:id/history/:year/:month` | Stock-item monthly vouchers | `/stock-items/:id/history` |
| `/stock-items/:stockItemId/monthly-summary` | Stock location monthly summary | `/inventory?tab=by-location` |
| `/locations/:locationId/stock-items/:stockItemId/history` | Location stock history | `/inventory?tab=by-location` |
| `/locations/:locationId/stock-items/:stockItemId/vouchers/:year/:month` | Location monthly vouchers | `/locations/:locationId/stock-items/:stockItemId/history` |
| `/stock-transfer-order` | Transfer-order workflow | `/sales-tools?tab=transfers` |
| `/import-stock-items` | Stock import | `/stock?tab=items` |
| `/inventory-repair` | Inventory repair | `/settings` |
| `/barcode-manager` | Barcode manager | `/stock?tab=items` |
| `/bale-ledger` | Bale ledger | `/stock` |

## Sales reports and analytics

| Route | Purpose | Parent / Escape / Back |
|---|---|---|
| `/sales-report` | Sales report | `/tracking` |
| `/sales-report/detail` | Sales report detail | `/sales-report` |
| `/sales-report/comparison` | Sales comparison | `/sales-report` |
| `/stock-in-sales-report` | Stock-in and sales report | `/sales-report` |
| `/analytics` | Analytics | `/financial-overview` |
| `/net-profit-report` | Developer net-profit report | `/financial-overview` |

## Opening and closing stock

| Route | Purpose | Parent / Escape / Back |
|---|---|---|
| `/opening-stock` | Opening-stock summary | `/inventory` |
| `/opening-stock/:groupId` | Opening-stock group detail | `/opening-stock` |
| `/closing-stock-summary` | Closing-stock summary | `/inventory` |
| `/closing-stock/:groupId` | Closing-stock group detail | `/closing-stock-summary` |

## Rentals

| Route | Purpose | Parent / Escape / Back |
|---|---|---|
| `/erp/rental/shops` | Rental shops | `/tracking` |
| `/erp/rental/warehouses` | Rental warehouses | `/erp/rental/shops` |
| `/erp/rental/payments` | Rental payments | `/erp/rental/shops` |

Phase 2/4 should determine whether rentals should become URL-backed tabs under one canonical rental hub; until then the three routes remain valid standalone routes.

## Supplier Partner

These routes appear only for `supplier_partner` companies in the sidebar.

| Route | Purpose | Parent / Escape / Back |
|---|---|---|
| `/sp/reports` | SP reports | `/tracking` |
| `/sp/opening-stock` | SP opening stock | `/sp/reports` |
| `/sp/aliases` | SP aliases | `/sp/reports` |
| `/sp/setup` | SP setup | `/sp/reports` |
| `/sp/gc-migration` | GC migration | `/sp/setup` |
| `/sp/migration` | Legacy migration path | replace to the canonical migration experience; current implementation renders the same component |

## Settings, repair, migration, and internal tools

| Route | Purpose | Parent / Escape / Back |
|---|---|---|
| `/settings` | ERP settings | `/tracking` |
| `/intercompany-links` | Intercompany links | `/settings` |
| `/intercompany-requests` | Intercompany requests | `/tracking` |
| `/orphaned-records` | Orphaned records | `/settings` |
| `/deleted-items` | Deleted items | `/settings` |
| `/chatbot-settings` | Chatbot settings | `/settings` |
| `/notification-settings` | Notification settings | `/settings` |
| `/test-data-import` | Test-data import | `/settings` |
| `/import-cycle-diagnostics` | Import diagnostics | `/settings` |
| `/inventory-repair` | Inventory repair | `/settings` |
| `/balance-repair` | Balance repair | `/settings` |
| `/net-position-details` | Net-position details | `/settings` |
| `/company-data-reset` | Company reset | `/settings` |
| `/account-migration` | Account migration | `/settings` |
| `/account-transfer` | Account transfer | `/accounts` |
| `/conflicts` | Conflict center | `/settings` |
| `/po-import` | Purchase-order import | `/containers` |
| `/ai-validation` | AI validation | `/ai-command-center` |
| `/ai-command-center` | AI command center | `/tracking` |
| `/agents` | Agent ledger | `/tracking` |
| `/pos-import` | POS import | `/pos` |
| `/mock-git` | Internal mock | `/settings` |
| `/git` | Internal GIT view | `/settings` |

## Factory compatibility routes exposed in ERP route tree

| Legacy ERP route | Canonical destination |
|---|---|
| `/factory-production` | `/factory/raw-stock` |
| `/bales` | `/factory/raw-stock` |
| `/production-bales` | `/factory/stock-entry` |
| `/bale-products` | `/factory/bale-products` |

These redirects must use replacement and must continue to pass through Factory access guards.

## Current gaps identified in Phase 1

1. ERP parent mapping exists for several nested pages, but many standalone ERP tools still have no deterministic parent.
2. Compatibility redirects in `ErpRoutes` do not consistently specify replacement.
3. `/location-summary` creates a redirect chain through the legacy `/stock-query` path instead of resolving directly to a canonical Stock Hub state.
4. Hub query-state behavior must be audited individually for Tracking, Inventory, Stock, Parties, and Sales Tools.
5. `/transaction-journal` is presented as “All Daybook” but currently lacks an explicit registered parent in the shared parent-route utility.
6. POS edit, POS import, stock transfer order, barcode manager, import stock, rentals, Supplier Partner, and many admin tools require explicit parent mappings.
7. The sidebar, route guards, and route tree use overlapping but not identical access rules; later phases must preserve access behavior and change navigation only.
8. Legacy routes that render the same component rather than redirecting, such as `/sp/migration`, need a Phase 4 decision on one canonical URL.
9. Top-level pages need consistent fallback rules so Escape does not unexpectedly leave ERP Mode or revisit an alias.

## Phase boundaries

- Phase 1: this registry and route/sidebar inventory.
- Phase 2: standardize hub and tab URL/history behavior.
- Phase 3: standardize Escape priority and add missing ERP parent mappings.
- Phase 4: align visible Back controls, deep links, and redirects with this registry.
- Phase 5: regression verification across roles, direct links, refresh, Back/Forward, Escape, and responsive layouts.
