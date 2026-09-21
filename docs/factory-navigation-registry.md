# Factory Navigation Registry

Status: Phase 1 audit baseline

This document is the authoritative inventory for Factory Mode navigation. It records the current route, canonical destination, intended parent, query-state policy, Escape behavior, and migration status without changing runtime behavior.

## Navigation contract

1. Top-level Factory pages do not leave Factory Mode when Escape is pressed.
2. Escape closes the nearest active UI layer first: popover, menu, dialog, drawer, inline detail, then child page.
3. Child pages return to a deterministic parent route rather than relying only on browser history.
4. Hub tab and section changes should eventually replace browser history unless they represent a meaningful drill-down.
5. Detail-page navigation should push browser history.
6. Parent destinations must preserve the exact hub section or tab where practical.
7. Legacy aliases should redirect once to a canonical route and must not form redirect chains.
8. Unsaved forms must intercept Back and Escape before navigation.

## Canonical top-level pages

| Area | Canonical route | State key | Parent | Current status |
|---|---|---|---|---|
| Overview | `/factory/production-report` | `tab` | none | canonical |
| Stock Entry | `/factory/stock-entry` | component state | none | canonical |
| Raw Materials | `/factory/raw-materials` | `section` | none | canonical hub |
| Waste Dispatch | `/factory/waste-dispatch` | component state | none | canonical |
| Bale Explorer | `/factory/bales-hub` | `tab` or `section` | none | canonical hub |
| Factory POS | `/factory/pos` | component state | none | canonical |
| Invoicing | `/factory/invoicing` | `tab` | none | canonical hub |
| Location Inventory | `/factory/location-inventory` | filters/query | none | canonical |
| Containers | `/factory/containers-hub` | `section` | none | canonical hub |
| Stock Allocation | `/factory/stock-allocation-v5` | filters/query | none | canonical version |
| Sheets & Sacks | `/factory/sheets-sacks` | component state | none | canonical |
| Daybook | `/factory/daybook` | filters/query | none | canonical |
| Parties | `/factory/parties` | `section` | none | canonical hub |
| Contacts | `/factory/contacts` | component state | none | canonical |
| Payroll & Benefits | `/factory/payroll-hub` | `section`, `tab` | none | canonical hub |
| Accounts | `/factory/accounts` | filters/query | none | canonical |
| Vouchers | `/factory/vouchers` | filters/query | none | canonical |
| Analytics | `/factory/analytics` | component state | none | canonical but overlaps intelligence |
| Rentals - Shops | `/factory/rental/shops` | component state | none | canonical |
| Rentals - Warehouses | `/factory/rental/warehouses` | component state | none | canonical |
| Rentals - Payments | `/factory/rental/payments` | component state | none | canonical |
| Supplier Intelligence | `/factory/intelligence/supplier-hub` | `section` | none | canonical hub |
| Financial Intelligence | `/factory/intelligence/financial-hub` | `section` | none | canonical hub |
| Production Intelligence | `/factory/intelligence/production-hub` | `section` | none | canonical hub |
| Factory Dashboard | `/factory/intelligence/dashboard` | component state | none | canonical |
| KPIs | `/factory/intelligence/kpis` | component state | none | canonical |
| Alerts | `/factory/intelligence/alerts` | component state | none | canonical |
| Settings | `/factory/settings` | tab/section | none | canonical admin page |

## Detail and workflow routes

| Current route | Canonical parent | Intended exact return | Escape status | Audit result |
|---|---|---|---|---|
| `/factory/containers/new` | Containers | `/factory/containers-hub?section=containers` | mapped | correct |
| `/factory/raw-stock/opening-balance/:id/edit` | Raw Materials | `/factory/raw-materials?section=opening-balances` | partially mapped | parent exists but section is not preserved |
| `/factory/raw-stock/recalculate` | Raw Materials | `/factory/raw-materials?section=recalculation` | unmapped centrally | fix in later phase |
| `/factory/raw-stock` | Raw Materials | `/factory/raw-materials?section=stock` | unmapped centrally | fix in later phase |
| `/factory/stock-query/:id` | Stock Query | `/factory/stock-query` | mapped | correct but origin context is not preserved |
| `/factory/bale-product-history/:productId/:locationId` | Location Inventory | `/factory/location-inventory` | mapped | correct basic parent |
| `/factory/bale-product-history/:productId/:locationId/:year` | Product history | base product/location route | mapped | correct |
| `/factory/bale-product-history/:productId/:locationId/:year/:month` | Product history | base product/location route | mapped | correct |
| `/factory/bale-product-history/:productId/:locationId/:year/all` | Product history | base product/location route | mapped | correct |
| `/factory/sales/new` | Invoicing | `/factory/invoicing?tab=invoices` | unresolved | add deterministic parent |
| `/factory/sales/invoices/:id` | Invoicing | `/factory/invoicing?tab=invoices` | mapped | correct |
| `/factory/sales/pending-invoices/:id/verify` | Invoicing | `/factory/invoicing?tab=invoices` | mapped | correct |
| `/factory/invoices/:id/loading-scan` | Invoice detail | `/factory/sales/invoices/:id` | mapped | correct |
| `/factory/sales/proformas/:id/add-line` | Invoicing | `/factory/invoicing?tab=proformas` | partially mapped | tab is not preserved |
| `/factory/dispatch-batches/:id` | Dispatch Batches | `/factory/dispatch-batches` | mapped | correct |
| `/factory/dispatch-batches/:batchId/rides/:rideId/scan` | Dispatch detail | `/factory/dispatch-batches/:batchId` | mapped | correct |
| `/factory/customers/:id` | Parties | `/factory/parties?section=customers` | mapped | correct |
| supplier detail routes | Parties | `/factory/parties?section=suppliers` | inconsistent | inventory exact routes in Phase 2 implementation work |
| `/factory/employees/:id` | Payroll Hub | `/factory/payroll-hub?section=employees` | mapped | correct |
| `/factory/workers/:id` | Payroll Hub | `/factory/payroll-hub?section=workers` | mapped | correct |
| `/factory/ledger-monthly/:accountId` | Accounts | `/factory/accounts` | mapped | correct |
| `/factory/ledger-vouchers/:accountId/:year/:month` | Monthly Ledger | `/factory/ledger-monthly/:accountId` | mapped | correct |
| `/factory/voucher-detail/:voucherId` | Vouchers | `/factory/vouchers` | mapped | correct basic parent; filters are not preserved |
| `/factory/vouchers/:id/edit` | Vouchers | `/factory/vouchers` | mapped | correct basic parent; filters are not preserved |
| `/factory/net-position-details` | Financial Intelligence | `/factory/intelligence/financial-hub?section=net-position` | partially mapped | section is not preserved |
| `/factory/financial-snapshot` | Financial Intelligence | `/factory/intelligence/financial-hub?section=financial-snapshot` | currently maps to Analytics | destination should be normalized |
| `/factory/import-cycle-diagnostics` | Settings | `/factory/settings` | mapped | correct basic parent |
| `/factory/inventory-repair` | Settings | `/factory/settings` | unresolved | add deterministic parent |
| `/factory/orphaned-records` | Settings | `/factory/settings` | unresolved | add deterministic parent |
| `/factory/deleted-items` | Settings | `/factory/settings` | unresolved | add deterministic parent |
| `/factory/company-data-reset` | Settings | `/factory/settings` | unresolved | add deterministic parent |

## Legacy aliases and redirects

| Legacy route | Current target | Canonical target | Finding |
|---|---|---|---|
| `/factory/finance` | `/factory/workers` | `/factory/payroll-hub?section=workers` | redirect chain; replace with direct target |
| `/factory/suppliers` | `/factory/parties?section=suppliers` | same | correct |
| `/factory/containers` | `/factory/containers-hub?section=containers` | same | correct |
| `/factory/pressing` | `/factory/stock-entry` | same | correct |
| `/factory/finalize` | `/factory/stock-entry` | same | correct |
| `/factory/stock-otw` | `/factory/containers-hub` | `/factory/containers-hub?section=otw` or canonical default | section intent should be explicit |
| `/factory/production-summary` | Production Intelligence section | same | correct |
| `/factory/customers` | `/factory/parties?section=customers` | same | correct |
| `/factory/employees` | `/factory/payroll-hub?section=employees` | same | correct |
| `/factory/workers` | `/factory/payroll-hub?section=workers` | same | correct |
| `/factory/worker-payroll` | `/factory/workers?tab=payroll` | `/factory/payroll-hub?section=workers&tab=payroll` | redirect chain and tab-loss risk |
| `/factory/supplier-report` | Supplier Intelligence report section | same | correct |
| `/factory/supplier-statement` | Supplier Intelligence statement section | same | correct |
| `/factory/users` | `/factory/settings` | same | correct |
| `/factory/intelligence/profitability` | Financial Intelligence profitability section | same | correct |
| `/factory/intelligence/supplier-scores` | Supplier Intelligence scores section | same | correct |
| `/factory/intelligence/mix-optimizer` | Production Intelligence mix optimizer section | same | correct |
| `/factory/intelligence/cashflow` | Financial Intelligence cashflow section | same | correct |
| `/factory/intelligence/waste` | Production Intelligence waste section | same | correct |
| `/factory/bale-ledger` | `/factory/production-report?tab=product-comparison` | same | legacy route redirected to Product Comparison |
| `/factory/net-profit-analytics` | Financial Intelligence net-profit section | same | correct |
| `/factory/net-position` | Financial Intelligence net-position section | same | correct |

## Duplicate or overlapping destinations

1. `Factory Analytics` and `Financial Intelligence` both expose financial analysis concepts. Later phases should preserve permissions while assigning each detail page one canonical parent.
2. Three stock allocation routes remain active: base, V3, and V5. V5 is the sidebar destination and should be treated as canonical. Older versions remain compatibility routes until confirmed safe to retire.
3. Raw materials are split between `/factory/raw-materials`, `/factory/raw-stock`, and `/factory/raw-stock/recalculate`. These should remain separate components but share one hub hierarchy.
4. Bale functions are split across Bale Explorer, Bale History, Bale Products, Barcode Lookup, Location Inventory, and product-history routes. Their parent should be selected by explicit origin context rather than guessing from browser history.
5. Invoicing, loadings, proformas, dispatch batches, and loading scans form one workflow but currently expose several top-level routes.

## Query and history policy for later phases

| Navigation action | Browser history policy |
|---|---|
| Switch tab in same hub | replace |
| Switch section in same hub | replace |
| Change filter, sort, or pagination | replace unless explicitly shareable as a workflow step |
| Open detail record | push |
| Open creation workflow | push |
| Open edit workflow | push |
| Close dialog or drawer | no route change unless the drawer is route-addressable |
| Return from detail with Back button | deterministic parent with preserved context |
| Press Escape on detail | same deterministic parent as Back button |
| Follow legacy alias | replace |

## Escape priority

1. Open command palette, dropdown, popover, listbox, menu, dialog, or alert dialog handles Escape itself.
2. Focused input, textarea, select, or editable area loses focus on first Escape.
3. Open drawer or sheet closes.
4. Inline selected record or expanded row clears.
5. Child route navigates to its registered parent.
6. Top-level route performs no navigation.

## Phase 1 findings

- The shared Escape hook is already dialog-aware and input-aware.
- The central parent-route helper exists but covers only a subset of Factory child routes.
- Sidebar navigation, route declarations, and parent mappings are maintained independently.
- Query-string tab and section state is not governed by one history policy.
- Several valid mappings omit the exact section or tab.
- Two redirect chains should be removed first: Factory Finance and Worker Payroll.
- Accounts and Vouchers currently provide the clearest parent hierarchy and should be used as the implementation model.

## Implementation order after Phase 1

1. Introduce typed Factory route metadata or an equivalent single registry.
2. Update hub tab/section navigation to follow the replace/push policy.
3. Complete deterministic Escape parents and close-layer priority.
4. Normalize legacy redirects and page Back buttons.
5. Run complete navigation regression coverage.
