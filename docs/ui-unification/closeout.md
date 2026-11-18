# UI Unification — Close-out of phases 1–4

**Date:** 2026-11-17. **Scope:** every numbered finding (and every dead-code
candidate) in the nine audit reports in
[`../archive/ui-unification-audit-2026-11-13/`](../archive/ui-unification-audit-2026-11-13/)
that belongs to phase 1 (shared foundations), 2 (broken and misleading
things), 3 (dead code) or 4 (export and print). Findings that belong to
phases 5–10 (headers, tabs, wording, filters, tables, states, formatting,
convergence, guard rails) are tracked in [plan.md](plan.md) and are not
repeated here.

Status values:

- **Done** — fixed before this close-out (phase and log entry named).
- **Fixed now** — fixed in this close-out.
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
which that status appears at all.

| Status | Rows (first status) | Rows mentioning it |
|---|---|---|
| Done (earlier phases) | 54 | 54 |
| Fixed now | 10 | 11 |
| Kept | 21 | 23 |
| Open | 7 | 14 |
| Owner | 2 | 3 |

## Findings

| Report | Finding | Short description | Phase | Status | Where fixed / why kept |
|---|---|---|---|---|---|
| 1 | 1 | `FinancialScreen*` primitives have no consumer | 3 | Kept | `components/financial/financial-screen.tsx` is still read by `scripts/verify-program7d-accessibility-responsive.mjs` (pinned); phase 3 log |
| 1 | 2 | Back navigation four ways; `window.location.href` back on Stock & Sales Report | 2 | Done / Fixed now | Report back fixed in phase 2; the "Back to report" button on Stock Flow Details (no period) still reloaded the page — now `navigate()` (`StockInSalesReportDetail.tsx`). The remaining `onBack={() => window.history.back()}` overrides work (history-first back) and belong to phase 5's back strategy |
| 1 | 4 | Eight export implementations, labels, file names | 4 | Done | Phase 4 migration (`ReportExportMenu`, `exportFileName`, `downloadFromUrl`); the supplier-profit-check `xlsx-js-style` import is frozen by the phase 10 ratchet |
| 1 | 5 | ~20 ERP report pages with no export (Analytics hub, Transaction Journal, ledgers, comparisons, Optional Vouchers, Customers, 10 `/accounting/*` pages) | 4 | Fixed now (Ledger Vouchers) / Open | Ledger Vouchers gained Excel. The rest are open: the 10 `/accounting/*` workpapers, Analytics and the two comparison pages each render several nested evidence tables whose "rows shown" need per-page design; Customers and Stock-in-Sales comparison are paged. See "Exports not added" |
| 1 | 11 | `window.confirm` in Cost Centers / automation rules | 2 | Done | Phase 2 (all native confirms → `confirmAction`); ratchet count 0 |
| 2 | 5 | Nine export implementations; `window.print()` labelled "Export PDF" | 4 | Done | Migrated in phase 4. Container detail "Export PDF" item relies on `lib/containerExportEnhancements` overriding `window.print`; owner decision 10 keeps it labelled "Export PDF" |
| 2 | 6 | Export file names follow no convention | 4 | Done | `exportFileName` everywhere (phase 4) |
| 2 | 7 | ~20 stock/list pages with no export | 4 | Fixed now (16) / Open (5) | Added: Stock Transfers, Opening/Closing Stock Summary and Detail, Stock Item Monthly Summary, Stock Item Vouchers, Location Monthly Summary, Location Vouchers, Stock Item Detail, Offload Item Search, Offload Detail, Bale Ledger, Deleted Items, Company Transfer history, Suppliers list. Open: Stock Query (server-paged), Orphaned Records, Import Cycle Diagnostics, Inventory Repair, POS Item Replacement (repair-tool working sets, not reports) |
| 2 | 14 | "Add" button that opens PO import (ContainerToolbar) | 2 | Open | Wording belongs to phase 6; the button's destination is the intended create path for containers (create = import a PO), so it is not broken |
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
| 3 | D | `ERPRunPayrollView` step-1 branch never renders | 3 | Open | The branch shares state with the History step; removing it needs a payroll behaviour test first |
| 3 | D | "Bulk Advance" and "Add Advance" open the same dialog | 2 | Fixed now | The duplicate "Bulk Advance" button in ERP `payroll/AdvancesTab.tsx` (which opened the single-worker dialog) removed; Factory's real bulk-advance dialog is unchanged |
| 3 | D | `AddWorkerDeductionDialog` vs `WorkerDeductionDialog` | 3 | Kept | Both are reachable from different screens; merging is a refactor, not dead code |
| 3 | D | Folder-name twins, thin wrappers | 3 | Kept | Renames only; out of close-out scope |
| 4 | 11 | Seven export implementations | 4 | Done | Phase 4 |
| 4 | 12 | Export label/icon/variant drift | 4 | Done | Phase 4 (`ExportButton`/`ReportExportMenu`) |
| 4 | 13 | "Export CSV" that writes xlsx (Wipers Re-entry) | 2 | Done | Phase 2 |
| 4 | 14 | File-name conventions | 4 | Done | Phase 4 |
| 4 | 15 | ~15 Factory reports with no export | 4 | Fixed now (16) / Open (2) | Added: Factory KPIs, Production Summary, Factory Waste, Production Overview tab, Monthly production by worker, Product Comparison, Pressing worker totals, Pressing hourly targets, Sheets & Sacks movement log, Factory Stock Item Detail, In-stock bale list, Bale product history (year, month, all months), Raw Stock table, Stock Query "Inventory in Hand". Open: Stock Entry History (infinite server paging), monthly-production bale drill-down (server-paged), Dispatch History already had export |
| 4 | 16 | Print implemented four ways; popup print repeated | 4 | Open | One `printDocument()` helper for the 19 `document.write` label/report pop-ups is a phase-4-sized refactor of business-critical label layouts; not done in a close-out |
| 4 | 24 | Three unconfirmed deletes | 2 | Done | Phase 2 |
| 4 | 34 | Scanner list exports differ | 4 | Done | Phase 4 standardised labels; scanner screens keep their per-screen exports |
| 4 | 30 | Quantity/weight formatters re-declared (`formatKg` ×2, `fmtKg`, `kg`, ContainerPlanner `formatQty` ×5) | 1 | Fixed now | New `formatQuantity`, `formatKg`, `formatCount` in `lib/formatNumber.ts`; moved: Pressing worker totals and hourly targets, monthly drill-down, Raw Stock KPI cards, Mix Batch list and WhatsApp preview, Pending Loadings, five Container Planner panels |
| 4 | 29 | Bale status colour maps | 1 | Done | Phase 8 (`StatusBadge` kinds) |
| 4 | D | `WasteDispatch.tsx` superseded | 3 | Kept | Still lazy-exported, preloaded by `offlinePrep` and rendered by route-guard and wave-4 tests |
| 4 | D | `FactoryLocationInventoryMockup` | 3 | Done | Removed before this close-out |
| 4 | D | Unused lazy exports | 3 | Kept | As report 2 |
| 5 | 1 | Invoice export five ways | 4 | Done / Owner | Phase 4 (`downloadFromUrl`); the bilingual menu without group headings is owner decision 12 (fine as is) |
| 5 | 2 | Four download transports | 4 | Done | Phase 4 |
| 5 | 3 | V5 allocation export uses `xlsx-js-style` | 4 | Open | Follow-up in plan (styling parity); frozen by ratchet |
| 5 | 4 | File naming | 4 | Done | Phase 4 |
| 5 | 5 | Export/print labels per document | 4 | Done | Phase 4 |
| 5 | 6 | PDF/print three ways; ProformaCard offline falls back to print dialog | 4 | Done | Owner decision 11: ProformaCard and the customer statement show "PDF needs a connection" when offline instead of the print dialog (phase 6) |
| 5 | 7 | Lists with no export (Invoices, Containers, Shipping, Tracking, Pending Loadings, sale returns, Transporters) | 4 | Open | Not in this close-out's named scope (report 2 and 4 pages); Invoices list is server-filtered per order with per-row server exports — needs a list endpoint export |
| 5 | 14 | `window.confirm` in dispatch finance | 2 | Done | Phase 2 |
| 5 | D | `FactoryPendingInvoices.tsx` unrouted | 3 | Kept | Preloaded by `offlinePrep` and rendered by three wave-4 test suites |
| 5 | D | `FactoryLoadingDispatchAllocation.tsx` | 3 | Done | Phase 3 |
| 5 | D | V2/V3 allocation; V2 keyboard shortcut | 2/3 | Done | Phase 2 (Alt+S → V5), phase 9a removal |
| 5 | D | Dispatch Batches vs Loading Dispatch | 3 | Done | Owner decision 3, phase 9a |
| 6 | 2 | Export/print seven ways; "Export PDF" that prints (attendance) | 4 | Done | Phase 4; attendance item now reads "Print Results" |
| 6 | 3 | Statements and lists with no export | 4 | Done (people) / Open | Phase 9c added Employees/Workers statement and roster exports. Supplier statements, broker statement, scoreboard, net position, insurance, contacts remain open (not in the named scope) |
| 6 | 6 | Wrong employee back link (`?tab=` vs `?section=`) | 2 | Done | Phase 2 |
| 6 | 9 | `window.confirm` (customer statement, FX wallet card) | 2 | Done | Phase 2 |
| 6 | 18 | In-app navigation by reload / new window | 2 | Done / Kept | Factory Settings reloads fixed in phase 2. Net Position ledger links and the insurance expense link still open in a new tab on purpose (they keep the report open beside the ledger) |
| 6 | D | `FactoryNetPosition.tsx` unrouted | 3 | Kept | Pinned by three root tests (`factory-net-position-*`) |
| 6 | D | Empty `import {} from …` leftovers | 3 | Fixed now | Removed from FactoryAdvancesTab, ProductionComparison, FactoryStatusBuilder, AddAgentDialog, transactionjournal utils and two property-rental dialogs (god-file caps lowered to the new sizes) |
| 6 | D | Folder splits, lazy-export names | 3 | Kept | Renames only |
| 7 | 7 | Six export mechanisms | 4 | Done | Phase 4; POS `exceljs` frozen by ratchet |
| 7 | 8 | POS/Retail lists with no export | 4 | Done (Daybook, Customers, Stock count, Variant reports) / Open | Container tracking, transfer orders, sales history, Retail inventory and dashboard tables open (not in the named scope; Retail inventory is server-paged) |
| 7 | 9 | Four print engines; `InvoiceTemplate` legacy | 4 | Open | One receipt source needs the server PDF on the WhatsApp/daybook paths — server work |
| 7 | 11 | "Print" and "Save PDF" same handler | 2 | Done | Phase 2 |
| 7 | 16 | Native confirm guarding retail posting | 2 | Done | Phase 2 |
| 7 | 24 | `RetailNav` points to a non-POS route | 2 | Kept | `/retail/inventory` is matched by `routes/AppRoutes.tsx` before the POS routes and works for retail users |
| 7 | D | Retail dead pages (~1,800 lines) | 3 | Done | Phase 3 |
| 7 | D | `goldenCoastPhase6Pos.ts` | 3 | Kept | Pinned by `tests/ui/golden-coast-pos-phase6-contract.test.ts` |
| 7 | D | `POSDashboard` orphan, `POSSettings` vs `MySettings` | 3 | Owner | Routed pages; retiring them is a product decision |
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
| 8 | D | `PropertiesDashboard` compatibility route | 3 | Owner | Kept on purpose per the Properties handoff; retire only on owner confirmation |
| 9 | 3 | `?tab` vs `?section` | 1 | Done | Phase 1 fallback + phase 5 |
| 9 | 6 | Export menu adopted by 5 files | 1/4 | Done | `ReportExportMenu` for every company type (phase 1/4); now 80+ files |
| 9 | 7 | Same export action, five labels/icons | 4 | Done | Phase 4 |
| 9 | 8 | File-name casing | 4 | Done | Phase 4 |
| 9 | 9 | Print four mechanisms | 4 | Open | As 4/16 and 7/9 |
| 9 | 15 | Hand-built confirms + `window.confirm` | 2 | Done | Phase 2 (native) and phase 6 (AlertDialog deletes) |
| 9 | 16 | Money/qty formatting split; add `formatQuantity`/`formatWeight` | 1 | Fixed now | `formatQuantity` / `formatKg` / `formatCount` added (see 4/30); money is phase 8 |
| 9 | D | `operations-screen`, `financial-screen` | 3 | Kept | Pinned by `scripts/verify-program7d-accessibility-responsive.mjs` |
| 9 | D | `date-picker-input` | 3 | Done | Removed earlier |
| 9 | D | `workflow-dialog`, `ui/pagination` | 3 | Kept | Pinned by tests/scripts listed in phase 3 |
| 9 | D | `lib/containerExportEnhancements.ts` | 3 | Kept | Owner decision 10: the container detail item that saves a PDF is labelled "Export PDF"; the module stays |
| 9 | D | `useDebouncedValue` duplicate | 3 | Kept | Two live importers (paginated Daybook and GIT lists) |
| 9 | D | V2/V3 allocation | 3 | Done | Phase 9a |
| 9 | D | Retail dead pages | 3 | Done | Phase 3 |

## Exports added in this close-out

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

## Exports not added

| Page | Reason |
|---|---|
| Stock Query | Rows are server-paged; the full filtered set is not loaded |
| Stock Entry History | Infinite server paging |
| Monthly production bale drill-down | Server-paged |
| Audit log, Login History | Server-paged |
| Retail inventory | Server-paged |
| Orphaned Records, Import Cycle Diagnostics, Inventory Repair, POS Item Replacement | Repair tools whose tables are working sets for a repair action, not reports |
| ERP `/accounting/*` workpapers, Analytics hub, Sales/Stock-in-Sales comparisons, Supplier Profit Review, Optional Vouchers, Customers, Ledger Monthly Summary, Transaction Journal | Outside the named scope of this close-out (report 1); each needs per-page column design, Customers and the stock comparison are paged |
| Factory sales lists (report 5/7), Factory statements (report 6/3), POS lists (report 7/8) | Outside the named scope; several need a server list export |

## Needs the owner

| Item | Question |
|---|---|
| `POSDashboard`, `POSSettings` vs `MySettings` (7/D) | Retire the orphan POS dashboard and the duplicate password page? |
| `PropertiesDashboard` compatibility route (8/D) | Retire the hidden legacy Properties dashboard? |
