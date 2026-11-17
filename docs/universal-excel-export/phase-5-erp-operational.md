# Universal Excel Export — Phase 5: ERP Operational Export Migration

**Branch:** feature/universal-excel-export-system  
**Scope:** ERP/POS operational report buttons migrated to the Phase 2–4 workbook engine; all work remains on the existing branch, not main.  
**Date:** 2026-11-13  
**Status:** Source implementation committed. Dedicated regression tests written. Full build/test execution must be verified by CI or a runnable checkout before production approval.

## Migrated export actions

| Existing action | Source | Mode and invariant |
|---|---|---|
| Stock Items list | client/src/pages/stockitems/useStockItems.ts | Dakzo report; complete filtered stock dataset; dynamic per-location price columns; real numeric cost/price values; hide price/cost columns when role access hides stock rates |
| Stock Items Sales History | client/src/pages/stockitems/useStockItems.ts | Dakzo report; preserve item-group separators, labels and filename |
| Containers list | client/src/pages/containers/useContainerImportExport.ts | Dakzo report; same 5 source columns and filename |
| OTW Containers | client/src/pages/containers/useContainerImportExport.ts | **Import-template layout**, exact first-row headers, all 15 source fields and filename; no inserted title |
| SP + ERP combined Containers | client/src/pages/containers/ContainerSpView.tsx | Dakzo single-summary and optional two-sheet full detail, retaining per-item recorded charges and invoice total |
| POS location inventory | client/src/pages/pos/hooks/usePosInvoiceActions.ts | Dakzo report; native quantities/money; financial columns omitted for non-privileged active roles |
| POS sale summary | client/src/pages/pos/hooks/usePosInvoiceActions.ts | Dakzo report; existing #/Item/Qty/Rate/Amount and filename |
| POS sale details | client/src/pages/pos/hooks/usePosInvoiceActions.ts | Dakzo report; existing sale line metrics; cost-derived P/L columns only for privileged active roles |
| POS price-list export | client/src/pages/pos/pospricelist/usePosPriceListModel.ts | Dakzo report in single-location mode; **first-row, re-importable** in all-locations mode; price-list import template/download logic remains unchanged |
| Combined Inventory | client/src/pages/CombinedInventory.tsx | Dakzo report; retrieves all inventory pages explicitly before export rather than the page's 100-row preview; validates pagination count, errors and company context; retains group/search filters |
| ERP Daybook summary + detailed | client/src/pages/daybook/exportDaybook.ts | Opt-in Dakzo reports; same file/sheet names and export row contents |
| Supplier Ledger | client/src/pages/Suppliers.tsx | Opt-in Dakzo report; existing export permission gate and ledger values, same filename |
| Detailed Sales Report | client/src/pages/salesreportlegacy/exportExcel.ts | Dakzo report; 14 columns, numeric USD values and original percentage scale; red negative/green positive P/L cells maintained |
| Stock In & Sales summary | client/src/pages/StockInSalesReport.tsx | Dakzo report; original grouped period rows, columns and summary values |
| Stock Flow detail | client/src/pages/StockInSalesReportDetail.tsx | Dakzo four-sheet export: Summary, Container Stock In, Stock Adjustments, Sales; authoritative summary and aggregated details; explicitly fails instead of saving truncated responses |

## Shared adapter and authorization changes

- client/src/lib/operationalExcelExport.ts offers opt-in exportOperationalWorkbook with explicit ordered per-sheet columns and existing client browser download pipeline.
- columnsFromOperationalRows scans the **full row set**, not row one, for late optional fields. It only receives rows the page has already authorized/assembled, and never fetches raw company records.
- The shared engine gained an explicit \`auto\` value type, retaining number/boolean/date types from existing operational rows while apostrophe-escaping formula-like text. It rejects unsupported object cell values and nonfinite numbers.
- client/src/erp-core/erpReportExports.ts gained a \`universalDesign\` flag for migrated Daybook and Supplier Ledger actions. All other users keep the original helper behavior, including first-row headers and empty report handling.
- POS financial export columns are gated on the current session role (Admin, Owner or Developer), the \`posViewOnly\` flag and \`hiddenErpCostFields\`. The helper does not replace API-side access enforcement.
- Filters, filenames and worksheet names remain the existing values wherever applicable; the display-title/metadata rows are added only to **report** mode.

### Pagination guard for Combined Inventory

The visible Combined Inventory page intentionally uses \`/api/inventory?page=1&pageSize=100\`. Phase 5's export fetches pages 1 through the reported last page, compares declared \`total\`/\`totalPages\` across pages, verifies collected item count, refuses incomplete OTW details, and then reapplies the current search/group filters to the full combined dataset. On a partial/moving data source the user sees a failure message instead of a silently incomplete report. No change to the normal UI pagination.

## Not changed — contracts protected for later phases

- **Import templates**: PO Import, Container Import, POS Price List Import, Stock Item Import, alias updates and barcode inputs. These parsers depend on first-row/absolute coordinates.
- **Server's per-container "export-all" workbook**: this is a bespoke hierarchical workbook with one worksheet per container, PO/offload section rows and accounting values. It retains its original builder until the specialized-workbook Phase 8, rather than replacing absolute row positions with report-table styling.
- **Stock Query**: the ERP Stock Query page is a search/detail page without a direct Excel export action.
- **Specialized financial/print workbooks**: Stock Transfer Orders, Item Market Analysis (custom overview and company breakdown), POS invoices, product/bale order forms, matrix report and Factory financial statements have custom formula, print and data dependency contracts and remain for Phases 6–8.
- **Factory operational exports**: Phase 6 intentionally owns press/scanner/bale/dispatch/factory-only actions.
- **Accounting/rent/Net Position/FX reports**: Phase 7 owns financial-report migration.

This is **not** a claim that every exporter in the repository has switched. Phase 5 covers the identified ordinary ERP operational buttons; specialized workbooks remain deliberately outside the table-report transformation.

## Validation suite and deployment gate

Tests added:
- \`tests/ui/universal-excel-operational.test.ts\`: operational schema union, native values, protected import-row headers, 4-sheet workbook order, empty exports, strict key checking, active-role POS financial restrictions.
- Existing \`tests/universal-excel-engine.test.ts\`, \`tests/universal-excel-design.test.ts\` and \`tests/universal-excel-dynamic-columns.test.ts\` cover workbook building, themes, dynamic columns and protection contracts.
- Existing \`tests/export-excel-sheets.test.ts\` verifies the late-field fix in full-company backups.

Required execution before calling this production-verified:

~~~bash
npm run check
npx vitest run tests/universal-excel-engine.test.ts tests/universal-excel-design.test.ts tests/universal-excel-dynamic-columns.test.ts tests/export-excel-sheets.test.ts
npx vitest run --config vitest.config.frontend.ts tests/ui/universal-excel-operational.test.ts
npm run build
~~~

Also manually compare baseline vs migrated XLSX using Excel on filtered, non-admin and large-data companies. In particular verify that hidden prices remain absent, POS export permissions match the active role, CSV and import round trips remain compatible, and multi-currency profit percentages are numerically unchanged.

**No SQL migrations, financial voucher updates, merge into main or Render deployment in Phase 5.** The branch may require synchronization with main and tests may reveal follow-up corrections.
