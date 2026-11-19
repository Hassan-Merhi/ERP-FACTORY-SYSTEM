# UI Unification — Close-out of phases 1–4

**Date:** 2026-11-17; second close-out 2026-11-18. **Scope:** every numbered finding (and every dead-code
candidate) in the nine audit reports in
[`../archive/ui-unification-audit-2026-11-13/`](../archive/ui-unification-audit-2026-11-13/)
that belongs to phase 1 (shared foundations), 2 (broken and misleading
things), 3 (dead code) or 4 (export and print). Findings that belong to
phases 5–10 (headers, tabs, wording, filters, tables, states, formatting,
convergence, guard rails) are tracked in [plan.md](plan.md) and are not
repeated here.

Status values:

- **Done** — fixed before this close-out (phase and log entry named).
- **Fixed now** — fixed in the first close-out (2026-11-17).
- **Close-out 2** — fixed in the second close-out (2026-11-18).
- **Kept** — deliberately left as it is, with the reason.
- **Open** — still open; the reason it was not done here is given.
- **Owner** — needs an owner decision; listed again at the end.

Report numbers: 1 ERP finance, 2 ERP stock, 3 vouchers/payroll, 4 Factory
production, 5 Factory sales, 6 Factory people/finance, 7 POS/Retail,
8 Properties/SP/Settings, 9 cross-company. `D:` rows are items from a
report's "Duplicates / dead candidates" list (unnumbered in the report).

## Summary

94 rows. A row whose status reads "Done / Open" or "Fixed now (16) / Open (5)"
is counted under its first status; the second column counts every row in
which that status appears at all. Counts as of the second close-out
(2026-11-18).

| Status | Rows (first status) | Rows mentioning it |
|---|---|---|
| Done (earlier phases and owner decision 13) | 56 | 56 |
| Fixed now (first close-out) | 10 | 11 |
| Close-out 2 | 5 | 8 |
| Kept | 21 | 24 |
| Open | 2 | 10 |
| Owner | 0 | 0 |

The two rows still open first are kept open on purpose: 5/3 (the styled V5
allocation workbook needs a styling-parity check) and 7/9 (one receipt source
needs the server PDF).

## Findings

| Report | Finding | Short description | Phase | Status | Where fixed / why kept |
|---|---|---|---|---|---|
| 1 | 1 | `FinancialScreen*` primitives have no consumer | 3 | Kept | `components/financial/financial-screen.tsx` is still read by `scripts/verify-program7d-accessibility-responsive.mjs` (pinned); phase 3 log |
| 1 | 2 | Back navigation four ways; `window.location.href` back on Stock & Sales Report | 2 | Done / Fixed now | Report back fixed in phase 2; the "Back to report" button on Stock Flow Details (no period) still reloaded the page — now `navigate()` (`StockInSalesReportDetail.tsx`). The remaining `onBack={() => window.history.back()}` overrides work (history-first back) and belong to phase 5's back strategy |
| 1 | 4 | Eight export implementations, labels, file names | 4 | Done | Phase 4 migration (`ReportExportMenu`, `exportFileName`, `downloadFromUrl`); the supplier-profit-check `xlsx-js-style` import is frozen by the phase 10 ratchet |
| 1 | 5 | ~20 ERP report pages with no export (Analytics hub, Transaction Journal, ledgers, comparisons, Optional Vouchers, Customers, 10 `/accounting/*` pages) | 4 | Fixed now (Ledger Vouchers) / Close-out 2 / Open | Ledger Vouchers gained Excel in the first close-out. Close-out 2: nine `/accounting/*` workpapers (open items, cash & bank, multi-currency, ERP inventory, Factory production, rentals, consolidation, history, fiscal review), Analytics account and expense sections, both comparison pages (the Stock & Sales comparison loads every item and only pages on screen, so it is exportable). Open: Accounting rollout (release checklist, not a report), Analytics Sales / Container / Net Profit drill-down panels, Transaction Journal, Optional Vouchers, Supplier Profit Review, Ledger Monthly Summary, Customers (paged). See "Exports added in close-out 2" |
| 1 | 11 | `window.confirm` in Cost Centers / automation rules | 2 | Done | Phase 2 (all native confirms → `confirmAction`); ratchet count 0 |
| 2 | 5 | Nine export implementations; `window.print()` labelled "Export PDF" | 4 | Done | Migrated in phase 4. Container detail "Export PDF" item relies on `lib/containerExportEnhancements` overriding `window.print`; owner decision 10 keeps it labelled "Export PDF" |
| 2 | 6 | Export file names follow no convention | 4 | Done | `exportFileName` everywhere (phase 4) |
| 2 | 7 | ~20 stock/list pages with no export | 4 | Fixed now (16) / Open (5) | Added: Stock Transfers, Opening/Closing Stock Summary and Detail, Stock Item Monthly Summary, Stock Item Vouchers, Location Monthly Summary, Location Vouchers, Stock Item Detail, Offload Item Search, Offload Detail, Bale Ledger, Deleted Items, Company Transfer history, Suppliers list. Open: Stock Query (server-paged), Orphaned Records, Import Cycle Diagnostics, Inventory Repair, POS Item Replacement (repair-tool working sets, not reports) |
| 2 | 14 | "Add" button that opens PO import (ContainerToolbar) | 2 | Close-out 2 | Relabelled **Import PO** (what it does; the "Add <thing>" standard is for creating a record) in `containers/ContainerToolbar.tsx` and the Supplier Partner list (`ContainerSpView.tsx`); test id `button-add-container` kept |
| 2 | 15 | Back navigation shapes | 2 | Done | Phase 5 folded hand-built back buttons into `PageHeader` |
| 2 | D | `ContainerDetailSpView` unreachable | 3 | Fixed now | Deleted; the `isSupplierPartner` branch in `ContainerDetail.tsx` could never run (every route passes `forceErp` or a non-SP company) and no test pinned it |
| 2 | D | `MixBatches` / `BatchDetail` have no route | 3 | Kept | Still preloaded by `lib/offlinePrep.ts` and rendered by wave-4 page-mount tests; `BatchDetail` helpers imported by `rawstockrecalculate/utils.ts` |
| 2 | D | Stale redirects `/combined-inventory`, `/location-summary` | 2 | Fixed now | `/location-summary` → `/stock?tab=query` (the `tab=summary` never existed); `/combined-inventory` → `/inventory?tab=on-the-way` (where the combined view lives) for users with Stock OTW, unchanged fallbacks otherwise (`routes/ErpRoutes.tsx`) |
| 2 | D | `/mock-*` routes, `GITMockup` name | 3 | Kept | Live GIT Tracking tab; renaming is a phase 5 naming task, routes are linked |
| 2 | D | Unused lazy exports in `lazyPages.ts` | 3 | Kept | Several are still imported by tests and offline preloading; removing them is not risk-free for a close-out |
| 3 | 1 | Two voucher edit UIs | 2 | Done | Phase 9a removed `/vouchers/:id/edit` (owner decision 5) |
| 3 | 4 | Print on one voucher type, export missing on two | 4 | Done / Open | Phase 9e put every voucher form on `VoucherActionBar`; Credit Note export and `VoucherDetail` print are still open (need a voucher print template — server work) |
| 3 | 11 | `window.confirm` in FX wallet / journal model | 2 | Done | Phase 2 |
| 3 | 21 | Payroll export/print four mechanisms | 4 | Done / Kept | Factory payroll moved to `downloadFromUrl` (phase 4); ERP run-payroll `xlsx-js-style` workbook kept (styled payslip layout), frozen by the raw-export ratchet |
| 3 | D | `components/VoucherEditDialog` never opens | 3 | Done | Phase 3 |
| 3 | D | `voucher-edit/*EditForm.tsx` duplicates | 3 | Done | Phase 9a |
| 3 | D | `ERPRunPayrollView` step-1 branch never renders | 3 | Close-out 2 | `ERPRunPayroll` renders `CompactRunPayrollSelection` whenever the Run tab is on step 1, so the view's step-1 branch (worker cards, `renderGroup`) could never mount. Pinned first by `tests/ui/erp-run-payroll-screen.test.tsx` (selection → preview → back, history rows and actions, tab switching), then removed with its unused imports |
| 3 | D | "Bulk Advance" and "Add Advance" open the same dialog | 2 | Fixed now | The duplicate "Bulk Advance" button in ERP `payroll/AdvancesTab.tsx` (which opened the single-worker dialog) removed; Factory's real bulk-advance dialog is unchanged |
| 3 | D | `AddWorkerDeductionDialog` vs `WorkerDeductionDialog` | 3 | Kept | Both are reachable from different screens; merging is a refactor, not dead code |
| 3 | D | Folder-name twins, thin wrappers | 3 | Kept | Renames only; out of close-out scope |
| 4 | 11 | Seven export implementations | 4 | Done | Phase 4 |
| 4 | 12 | Export label/icon/variant drift | 4 | Done | Phase 4 (`ExportButton`/`ReportExportMenu`) |
| 4 | 13 | "Export CSV" that writes xlsx (Wipers Re-entry) | 2 | Done | Phase 2 |
| 4 | 14 | File-name conventions | 4 | Done | Phase 4 |
| 4 | 15 | ~15 Factory reports with no export | 4 | Fixed now (16) / Open (2) | Added: Factory KPIs, Production Summary, Factory Waste, Production Overview tab, Monthly production by worker, Product Comparison, Pressing worker totals, Pressing hourly targets, Sheets & Sacks movement log, Factory Stock Item Detail, In-stock bale list, Bale product history (year, month, all months), Raw Stock table, Stock Query "Inventory in Hand". Open: Stock Entry History (infinite server paging), monthly-production bale drill-down (server-paged), Dispatch History already had export |
| 4 | 16 | Print implemented four ways; popup print repeated | 4 | Close-out 2 / Kept | New `lib/printDocument.ts` (open, write, wait for load, print; standard "Pop-up blocked" toast) now used by every report and statement pop-up with identical HTML: ERP payroll run print, ERP bulk bonus print, rental ledger print, Factory attendance print, Employees/Workers statement and roster print (`printPeopleTable`), attendance sheet print, waste disposal record. Kept on their own windows: label and barcode layouts (bale labels, stock-entry A4/sticker, remove-from-stock, relabelling, reprint labels, location reprint, bales history labels, wipers labels, barcode manager) and the superseded `WasteDispatch.tsx` / unreachable `stockentryhistory/reportsLegacy.ts` |
| 4 | 24 | Three unconfirmed deletes | 2 | Done | Phase 2 |
| 4 | 34 | Scanner list exports differ | 4 | Done | Phase 4 standardised labels; scanner screens keep their per-screen exports |
| 4 | 30 | Quantity/weight formatters re-declared (`formatKg` ×2, `fmtKg`, `kg`, ContainerPlanner `formatQty` ×5) | 1 | Fixed now | New `formatQuantity`, `formatKg`, `formatCount` in `lib/formatNumber.ts`; moved: Pressing worker totals and hourly targets, monthly drill-down, Raw Stock KPI cards, Mix Batch list and WhatsApp preview, Pending Loadings, five Container Planner panels |
| 4 | 29 | Bale status colour maps | 1 | Done | Phase 8 (`StatusBadge` kinds) |
| 4 | D | `WasteDispatch.tsx` superseded | 3 | Kept | Still lazy-exported, preloaded by `offlinePrep` and rendered by route-guard and wave-4 tests |
| 4 | D | `FactoryLocationInventoryMockup` | 3 | Done | Removed before this close-out |
| 4 | D | Unused lazy exports | 3 | Kept | As report 2 |
| 5 | 1 | Invoice export five ways | 4 | Done | Phase 4 (`downloadFromUrl`); the bilingual menu without group headings was answered by owner decision 12 (fine as is) |
| 5 | 2 | Four download transports | 4 | Done | Phase 4 |
| 5 | 3 | V5 allocation export uses `xlsx-js-style` | 4 | Open | Kept open on purpose: the styled allocation workbook needs a styling-parity check before it moves to `excelHelper`; frozen by the raw-export ratchet |
| 5 | 4 | File naming | 4 | Done | Phase 4 |
| 5 | 5 | Export/print labels per document | 4 | Done | Phase 4 |
| 5 | 6 | PDF/print three ways; ProformaCard offline falls back to print dialog | 4 | Done | Owner decision 11: ProformaCard and the customer statement show "PDF needs a connection" when offline instead of the print dialog (phase 6) |
| 5 | 7 | Lists with no export (Invoices, Containers, Shipping, Tracking, Pending Loadings, sale returns, Transporters) | 4 | Close-out 2 | Excel added to all seven: Invoices (filtered orders, column-picker columns), Factory Containers list, Shipping Containers (active list, every filtered row; the Done section stays server-paged), Container Tracking, Pending Loadings, sale-returns history, Transporters list. The Invoices list loads every order for its customer filter, so no new endpoint was needed |
| 5 | 14 | `window.confirm` in dispatch finance | 2 | Done | Phase 2 |
| 5 | D | `FactoryPendingInvoices.tsx` unrouted | 3 | Kept | Preloaded by `offlinePrep` and rendered by three wave-4 test suites |
| 5 | D | `FactoryLoadingDispatchAllocation.tsx` | 3 | Done | Phase 3 |
| 5 | D | V2/V3 allocation; V2 keyboard shortcut | 2/3 | Done | Phase 2 (Alt+S → V5), phase 9a removal |
| 5 | D | Dispatch Batches vs Loading Dispatch | 3 | Done | Owner decision 3, phase 9a |
| 6 | 2 | Export/print seven ways; "Export PDF" that prints (attendance) | 4 | Done | Phase 4; attendance item now reads "Print Results" |
| 6 | 3 | Statements and lists with no export | 4 | Done (people) / Close-out 2 / Open | Phase 9c added Employees/Workers statement and roster exports. Close-out 2: Parties supplier statement, Supplier hub statement, broker statement, insurance member statement, supplier scoreboard, Brokers & Suppliers directory, insurance members, contacts, worker bonuses, worker advances, repayments, deductions, employee advances. Open: Net Position details and Financial Snapshot (card layouts of user-arranged account groups, not tables) |
| 6 | 6 | Wrong employee back link (`?tab=` vs `?section=`) | 2 | Done | Phase 2 |
| 6 | 9 | `window.confirm` (customer statement, FX wallet card) | 2 | Done | Phase 2 |
| 6 | 18 | In-app navigation by reload / new window | 2 | Done / Kept | Factory Settings reloads fixed in phase 2. Net Position ledger links and the insurance expense link still open in a new tab on purpose (they keep the report open beside the ledger) |
| 6 | D | `FactoryNetPosition.tsx` unrouted | 3 | Kept | Pinned by three root tests (`factory-net-position-*`) |
| 6 | D | Empty `import {} from …` leftovers | 3 | Fixed now | Removed from FactoryAdvancesTab, ProductionComparison, FactoryStatusBuilder, AddAgentDialog, transactionjournal utils and two property-rental dialogs (god-file caps lowered to the new sizes) |
| 6 | D | Folder splits, lazy-export names | 3 | Kept | Renames only |
| 7 | 7 | Six export mechanisms | 4 | Done | Phase 4; POS `exceljs` frozen by ratchet |
| 7 | 8 | POS/Retail lists with no export | 4 | Done (Daybook, Customers, Stock count, Variant reports) / Close-out 2 / Open | Close-out 2: POS containers OTW (visible columns), transfer orders, Retail dashboard (seven tables as sheets). Open: Retail inventory (server-paged) and Retail sales history (a search capped at 50 server results) |
| 7 | 9 | Four print engines; `InvoiceTemplate` legacy | 4 | Open | Kept open on purpose: one receipt source needs the server PDF on the WhatsApp/daybook paths — server work |
| 7 | 11 | "Print" and "Save PDF" same handler | 2 | Done | Phase 2 |
| 7 | 16 | Native confirm guarding retail posting | 2 | Done | Phase 2 |
| 7 | 24 | `RetailNav` points to a non-POS route | 2 | Kept | `/retail/inventory` is matched by `routes/AppRoutes.tsx` before the POS routes and works for retail users |
| 7 | D | Retail dead pages (~1,800 lines) | 3 | Done | Phase 3 |
| 7 | D | `goldenCoastPos.ts` | 3 | Kept | Pinned by `tests/ui/golden-coast-pos-contract.test.ts` |
| 7 | D | `POSDashboard` orphan, `POSSettings` vs `MySettings` | 3 | Done | Owner decision 13 (2026-11-18): both pages and their lazy imports removed (with the dashboard's state and dialog modules); `/pos-dashboard` redirects to the POS sale screen (`/pos`) and `/pos-settings` to My Settings (`/my-settings`), which the POS sidebar and Command Palette now open. Server routes, data and the `pos.role-workspace` catalog paths kept |
| 7 | D | `InvoiceTemplate.tsx` | 3 | Kept | Still imported by six files (see 7/9) |
| 8 | 3 | Payments Log has no export | 4 | Done | Phase 9f |
| 8 | 4 | Payments Log button missing on warehouses | 2 | Done | Phase 2 |
| 8 | 5 | Shops tab shows warehouse wording | 2 | Done | Phase 2 |
| 8 | 18 | Alias delete unconfirmed | 2 | Done | Phase 2; page retired in 9a |
| 8 | 19 | SP report exports bypass helpers | 4 | Done | Phase 4 (`downloadFromUrl`, `ExportButton`) |
| 8 | 30 | Native confirm in Settings | 2 | Done | Phase 2 |
| 8 | 34 | Settings export path, Edit/Audit log and Login History without export | 4 | Done / Open | Account export migrated in phase 4; audit and login-history lists are server-paged (open) |
| 8 | D | `PageVisibilityTree.tsx` no importer | 3 | Kept | Pinned by `tests/ui/page-visibility-tree-factory.test.tsx` |
| 8 | D | `WatchUserDialog` component never rendered | 3 | Kept | Module still supplies `getPageLabel` to two live components and is pinned by three suites |
| 8 | D | Settings Delete User mutation/dialog that can never open | 3 | Fixed now | Removed from `pages/Settings.tsx` (state, mutation, dialog and their imports) |
| 8 | D | Split shims, Properties wrappers, lazy rental exports | 3 | Kept | Thin pass-throughs, harmless; renames |
| 8 | D | `PropertiesDashboard` compatibility route | 3 | Done | Owner decision 13 (2026-11-18): the page, its section/state modules and `propertiesdashboard/` removed; `/properties/dashboard` redirects to the Properties home (`/properties/daybook`). The hidden navigation entry and the `properties.dashboard` catalog id stay so stored permissions and old bookmarks keep working; server routes and data kept |
| 9 | 3 | `?tab` vs `?section` | 1 | Done | Phase 1 fallback + phase 5 |
| 9 | 6 | Export menu adopted by 5 files | 1/4 | Done | `ReportExportMenu` for every company type (phase 1/4); now 80+ files |
| 9 | 7 | Same export action, five labels/icons | 4 | Done | Phase 4 |
| 9 | 8 | File-name casing | 4 | Done | Phase 4 |
| 9 | 9 | Print four mechanisms | 4 | Close-out 2 / Open | Report and statement pop-ups share `printDocument` (see 4/16); receipts remain open as 7/9 |
| 9 | 15 | Hand-built confirms + `window.confirm` | 2 | Done | Phase 2 (native) and phase 6 (AlertDialog deletes) |
| 9 | 16 | Money/qty formatting split; add `formatQuantity`/`formatWeight` | 1 | Fixed now | `formatQuantity` / `formatKg` / `formatCount` added (see 4/30); money is phase 8 |
| 9 | D | `operations-screen`, `financial-screen` | 3 | Kept | Pinned by `scripts/verify-program7d-accessibility-responsive.mjs` |
| 9 | D | `date-picker-input` | 3 | Done | Removed earlier |
| 9 | D | `workflow-dialog`, `ui/pagination` | 3 | Kept | Pinned by tests/scripts listed in phase 3 |
| 9 | D | `lib/containerExportEnhancements.ts` | 3 | Kept | Owner decision 10: the container detail item that saves a PDF is labelled "Export PDF"; the module stays |
| 9 | D | `useDebouncedValue` duplicate | 3 | Kept | Two live importers (paginated Daybook and GIT lists) |
| 9 | D | V2/V3 allocation | 3 | Done | Phase 9a |
| 9 | D | Retail dead pages | 3 | Done | Phase 3 |

## Exports added in the first close-out

All use the new shared `components/export/RowsExportMenu` (a `ReportExportMenu`
with one **Export Excel** item, built through `exportOperationalWorkbook` and
named by `exportFileName`). Each writes exactly the rows and columns the page
shows under its current filters (including total rows, hidden-cost columns and
column-picker choices), uses only data the page already loaded, and is hidden
for users who may not export Excel: the same check the Suppliers export uses
(`useCan(resource, "export", { featureKey: "exp_excel" })`).

| Page | Formats |
|---|---|
| Stock Transfers | Excel |
| Opening Stock Summary, Opening Stock group detail | Excel |
| Closing Stock Summary, Closing Stock group detail | Excel |
| Stock Item Monthly Summary, Stock Item Vouchers | Excel |
| Location Monthly Summary (Item Monthly Summary / Stock Movement), Location Vouchers | Excel (POS users get quantities only, as on screen) |
| Stock Item Detail (purchases, sales, locations) | Excel, three sheets |
| Offload Item Search, Offload Detail (stock items) | Excel |
| Bale Production Ledger | Excel, one sheet per section |
| Deleted Items | Excel |
| Company Transfer history | Excel |
| Suppliers list | Excel |
| Ledger Vouchers | Excel |
| Factory KPIs (open tab) | Excel |
| Production Summary (batch utilisation, raw stock) | Excel, two sheets |
| Factory Waste | Excel |
| Production Overview tab (products, mix batches) | Excel, two sheets |
| Monthly production by worker | Excel |
| Product Comparison | Excel |
| Pressing worker totals, Pressing hourly targets | Excel |
| Sheets & Sacks movement log | Excel |
| Factory Stock Item Detail | Excel, four sheets |
| In-stock bale list | Excel |
| Bale product history (year, month, all months) | Excel |
| Raw Stock table | Excel |
| Factory Stock Query — Inventory in Hand | Excel |

PDF was not added: none of the comparable pages offers a client PDF for these
tables; their PDFs are server documents.

## Exports added in close-out 2

Same component and rules as above (`RowsExportMenu`, `useCanExportExcel`,
only data the page already has, no new endpoints). Grouped lists (Factory
Invoices, Factory Containers, Pending Loadings) export every filtered row in
screen order, whether or not its group is expanded; Analytics exports the
rows its tree shows, so only expanded groups list their children. Client-paged
lists (Shipping Containers, Contacts, Stock & Sales item comparison) export
every filtered row, not just the page on screen.

| Page | Sheets |
|---|---|
| Factory Invoices | Orders (visible columns) |
| Factory Containers list | Containers |
| Shipping Containers | Active containers (visible columns) |
| Container Tracking | Containers |
| Pending Loadings | Loadings |
| Finalized sale returns | Return history |
| Transporters | Transporters |
| Parties supplier statement | Statement (with net balance rows) |
| Supplier hub statement | One sheet per currency, Commission Earned |
| Broker statement | Containers (with total row), Payments (with total row) |
| Insurance member statement | Entries |
| Supplier Scoreboard | Rankings |
| Brokers & Suppliers directory | Suppliers |
| Insurance members | Members |
| Contacts | Contacts (visible columns) |
| Worker bonuses, worker advances, repayments, deductions, employee advances | One sheet each |
| `/accounting/open-items` | Rental dues or posted documents |
| `/accounting/cash-bank` | Statement movements, posted voucher movements |
| `/accounting/monetary-fx` | Exchange rates, cash and bank valuation, realized FX |
| `/accounting/erp-inventory` | Source documents |
| `/accounting/factory-production` | Control accounts, plus the open invoices or containers section |
| `/accounting/rentals` | Contract months, payment allocations (when shown), deposit evidence, property expenses |
| `/accounting/consolidation` | The open tab: pairs, trial balance, transfers or eliminations |
| `/accounting/history` | The open section: trial balance, posting chronology or reconciliation evidence |
| `/accounting/fiscal-review` | The open tab: reviewed closes or audit trail |
| Analytics (Assets, Liabilities, Cash, Loans / Banks, All / Direct / Indirect Expenses) | The account table with its total |
| Company sales comparison | Items by company |
| Stock & Sales comparison | Overall comparison, period comparison, items (chosen metric) |
| POS Containers OTW | Containers (visible columns) |
| POS transfer orders | Orders |
| Retail dashboard | Seven sheets: best-selling products, brands, sizes, sales by location, low stock, out of stock, slow moving |

## Exports not added

| Page | Reason |
|---|---|
| Stock Query | Rows are server-paged; the full filtered set is not loaded |
| Stock Entry History | Infinite server paging |
| Monthly production bale drill-down | Server-paged |
| Audit log, Login History | Server-paged |
| Retail inventory | Server-paged |
| Retail sales history | A search that returns at most 50 server results; the full set is not loaded |
| Shipping Containers "Done" section | Server-paged (the active list above it is exported) |
| Orphaned Records, Import Cycle Diagnostics, Inventory Repair, POS Item Replacement | Repair tools whose tables are working sets for a repair action, not reports |
| `/accounting/rollout` | Release checklist (schema and review status), not a report |
| Transporter statement, Customer statement, Employees/Workers statements | Already have an export |
| Analytics Sales, Container Report and Net Profit sections | Nested drill-down panels with their own per-row actions; still open |
| Factory Net Position details, Financial Snapshot | Card layouts of user-arranged account groups, not tables; still open |
| Transaction Journal, Optional Vouchers, Supplier Profit Review, Ledger Monthly Summary, Customers | Report-1 pages outside this round's list; Customers is paged |

## Needs the owner

None. Owner decision 13 (2026-11-18) answered the last two items: the orphan
POS dashboard, the POS settings page (7/D) and the legacy Properties dashboard
(8/D) are retired, with their routes kept as redirects. Owner decision 12
answered the Factory bilingual invoice menu (5/1).
