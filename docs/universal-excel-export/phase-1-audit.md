# Universal Excel Export — Phase 1: Source audit and migration contracts

**Status:** CODE-LEVEL AUDIT COMPLETE — documentation only.  
**Date:** 2026-11-13  
**Repository:** `Hassan-Merhi/ERP-FACTORY-SYSTEM`  
**Working branch:** `feature/universal-excel-export-system`  
**Main/deployment:** no merge or deploy in this phase.  
**Audit approach:** indexed GitHub code-search signals plus direct inspection of 45 selected implementation, importer, testing, and historical-audit files.

## 1. Inventory scope

Source discovery returned **225 distinct non-test, non-i18n client/server candidate files**, of which **130** have a stronger Excel-writing/building signal and **95** have only a related signal. Breakdown by area: erp 73; factory 104; finance 12; infrastructure 16; pos-retail 19; properties 1.

See [`export-source-inventory.json`](./export-source-inventory.json) for **every candidate path**, evidence-search terms, discovery classification, and the 45 source paths inspected directly. An indexed search match is not proof of a working export; this inventory is a migration checklist rather than a claim that every listed file is an exporter. Paths referenced through service-call indirection may have escaped search: Phase 2 must preserve that discovery limitation and add ownership tags at each migration.

### Current implementation families

1. **Client helper-backed**: `client/src/lib/excelHelper.ts` provides `utils.json_to_sheet`, `utils.book_append_sheet`, `writeFile`, and spreadsheet read support. This is used by stock, containers, vouchers, POS and many imports.
2. **Client direct ExcelJS**: manually constructed worksheets, merged cells, totals, formulas, print layouts, styling and custom sheet arrangements, including monthly production and Stock OTW.
3. **Server direct ExcelJS**: invoices, statements, dispatch, payroll, factory/location stock, net position, and more, commonly returned through buffered HTTP workbook responses.
4. **Existing report helper**: `client/src/erp-core/erpReportExports.ts` already standardizes some simple XLSX and CSV reports and formula-like CSV text escaping. Reuse its behavior; do not create a competing standard.
5. **Data/backups**: `server/services/export-excel/workbook.ts` and related sheet helpers output many schema-level sheets; maintain their machine-readable structure, independent of visual report presentation.
6. **Import/templates**: several download buttons create Excel files specifically for parser consumption. These are **not** freeform branded reports.

## 2. Representative export-contract matrix

These are **directly inspected** critical flows or their called helper. Exact per-route output rows need snapshot fixtures in later implementation phases.

| Flow | Source | Current format/columns | Must preserve | Treatment |
|---|---|---|---|---|
| **ERP stock items** | [`client/src/pages/stockitems/useStockItems.ts`](../../client/src/pages/stockitems/useStockItems.ts) | Code, Name, Barcode, Alias Codes, UOM, Stock Group, Grade, Category, Default Selling Price, Cost Dubai, per-location `Price - <location>`, Active | Dynamic location columns, complete filtered pagination, alias codes; exported money is currently formatted text | standard-table with dynamic columns |
| **ERP stock items complete dataset** | [`client/src/pages/stockitems/stockItemsExport.ts`](../../client/src/pages/stockitems/stockItemsExport.ts) | Paged retrieval of all filtered stock items; fail on incomplete response | Must not export only visible page or silently skip rows | data-loader, not a workbook |
| **Containers and OTW** | [`client/src/pages/containers/useContainerImportExport.ts`](../../client/src/pages/containers/useContainerImportExport.ts) | Containers: number/supplier/status/amount/import date; OTW: 15 fields including ETA, fees, border/offload dates, agent and document receipt | Two schemas. Container import template starts at row 1; retain its aliases | standard-tables + strict import template |
| **POS inventory and sale** | [`client/src/pages/pos/hooks/usePosInvoiceActions.ts`](../../client/src/pages/pos/hooks/usePosInvoiceActions.ts) | Inventory: code/name/UOM/qty/rate/value/group; POS Summary: #/Item/Qty/Rate/Amount; Detailed: code/qty/rate/P&L | Keep admin cost permissions and numeric amounts; do not treat a current on-screen sale as historical transactions | standard-table with authorization |
| **Factory stock OTW** | [`client/src/pages/stockotw/exportStockOtwExcel.ts`](../../client/src/pages/stockotw/exportStockOtwExcel.ts) | Item Name, Grade, Category, Container #, Supplier, Quantity, Rate, Total Cost | Title/meta rows 1–6, heading row 7, hierarchical item-summary+container detail rows, totals, freeze 7 | grouped-report |
| **Factory daybook** | [`client/src/pages/factory/daybook/factoryDaybookExports.ts`](../../client/src/pages/factory/daybook/factoryDaybookExports.ts) | Summary: Date/Type/Description/Currency/Amount/FX Rate/Amount USD/Optional; Detailed adds Account Name/Debit/Credit | Summary single sheet, detailed groups by transaction type; preserve per-voucher expansion and rows | multi-sheet accounting |
| **ERP agent account statement** | [`client/src/pages/agents/agentStatementExcel.ts`](../../client/src/pages/agents/agentStatementExcel.ts) | Ledger/Type/Debit/Credit/Running Balance/Date/Notes plus optional FX Rate column | Opening balance row and optional FX note; preserve exact balances and distinction of user-formatted money | financial statement |
| **Monthly production matrix** | [`client/src/pages/factory/monthlyProductionExcelExport.ts`](../../client/src/pages/factory/monthlyProductionExcelExport.ts) | Product/category/article, dynamic month columns, totals and bale drilldowns | Period-specific months, highest/lowest highlighting, validation of bale counts, formulas, print layout and drilldown hyperlinks | specialized workbook |
| **Factory location inventory** | [`server/routes/factory/stock/locationInventoryExportRoutes.ts`](../../server/routes/factory/stock/locationInventoryExportRoutes.ts) | Stock Summary; Wipers & Garbage; Bale Details; Garbage & Wiper Details | Conditional cost columns based on server visibility, numeric weights and totals, one sheet per category | multi-sheet cost-sensitive |
| **Factory customer statement** | [`server/routes/factory/customers-core/statement-excel.ts`](../../server/routes/factory/customers-core/statement-excel.ts) | Date/Type/Container/Destination/Dr/Cr/Note plus opening balance, B/F and period summary | HMD branding/logo, charge-side accounting, precision, currency/date semantics | financial statement |
| **Properties rental statement** | [`server/routes/rental/units-contracts/statement-export.ts`](../../server/routes/rental/units-contracts/statement-export.ts) | Property/unit/contract and monthly ledger/payment sections | Page/print layout, prepaid/credit/payment timing and company isolation | financial statement |
| **Loading dispatch reports** | [`server/routes/factory/customer-orders/loadingDispatchReportRoutes.ts`](../../server/routes/factory/customer-orders/loadingDispatchReportRoutes.ts) | Overall report or per-trip manifest (possibly historical closure) | Server generated based on authenticated factory access and loading/trip scope; do not alter amounts or historical snapshot | specialized report |
| **Factory canonical invoice** | [`server/routes/factory/customer-orders/orderExcelExportRoutes.ts`](../../server/routes/factory/customer-orders/orderExcelExportRoutes.ts) | Canonical invoice document with opt-out of charges and hide-selling pricing decision | Two legacy URLs same implementation, audit logging and workbook shared with document service | financial/canonical document |
| **Finalized sale return match preview** | [`client/src/pages/factory/finalizedSaleReturnMatchWorkbook.ts`](../../client/src/pages/factory/finalizedSaleReturnMatchWorkbook.ts) | Matched Bales; Unmatched - Review; Quantity Summary. Ref Number/Article Number/Bale Name/Qty/Match Status/Invoice Number/Container Number/Customer/Details | Excel injection guard on text, leading zero codes, match status and preview-only warning; no voucher mutation | specialized preview workbook |
| **Factory supplier return template** | [`client/src/pages/factory/FactorySupplierReturns.tsx`](../../client/src/pages/factory/FactorySupplierReturns.tsx) | First-sheet headers article_code and qty; accepts aliases such as articlecode/code/itemcode/barcode and qty/quantity/bales | Parser accepts 1–1000 rows and up to 3 qty decimals. Do not move headers below row 1 | strict import template |
| **Agreed price template** | [`client/src/pages/factory/factorycustomerstatement/statementHelpers.ts`](../../client/src/pages/factory/factorycustomerstatement/statementHelpers.ts) | Price List sheet row 1: article_code, price | Keep first sheet, exact header aliases and numeric price; optional second Instructions sheet | strict import template |
| **Finalized return import template** | [`client/src/pages/factory/FinalizedSaleReturnImport.tsx`](../../client/src/pages/factory/FinalizedSaleReturnImport.tsx) | Returns sheet row 1: Ref Code | Allows one-column/headerless alternative; first-sheet read must remain usable | strict import template |
| **Container ETA update** | [`server/routes/git/gitImportRoutes.ts`](../../server/routes/git/gitImportRoutes.ts) | ETA Update: Container # and New ETA | Keep first-row headers and linked importer; must not insert branded rows in data sheet | strict import template |
| **Bale relabel import** | [`client/src/pages/factory/factorybalerelabeling/utils.tsx`](../../client/src/pages/factory/factorybalerelabeling/utils.tsx) | Bale References: current_reference_code | Alternative aliases recognized. Format independent from branded reports | strict import template |
| **No-cost container items** | [`client/src/lib/excelHelper.ts`](../../client/src/lib/excelHelper.ts) | Sheet named Container Items; A3:D3 exact NO / BARCODE / DESCRIPTION / Q'TY | Parser identifies A3:D3 and special TOTAL Q'TY footer. Absolute coordinates cannot change | protected schema |
| **Stock transfer order** | [`client/src/pages/stock-transfer-order/exportStockTransferOrderWorkbook.ts`](../../client/src/pages/stock-transfer-order/exportStockTransferOrderWorkbook.ts) | Truck Trip, destination, date, conditional cost columns, totals | Print-ready merged cells/section rows, optional prices and exact subtotal/grand total | specialized document |
| **SP sales form** | [`server/services/spSalesFormExportV2.ts`](../../server/services/spSalesFormExportV2.ts) | Three-sheet form with formula/calculation/error scans | Exact worksheet ordering, calculation result integrity, no formula errors | specialized workbook |
| **Full company dataset export** | [`server/services/export-excel/workbook.ts`](../../server/services/export-excel/workbook.ts) | Company information, accounting, vouchers, suppliers, customers, payroll, factory, shipments and more across sheets | Schema-level export, not same as visual operational reports; preserve machine-readable worksheet names | backup/data workbook |
| **Full export sheet helper** | [`server/services/export-excel/sheet-helpers.ts`](../../server/services/export-excel/sheet-helpers.ts) | Auto keys from first 200 sample rows; 30000-row sheet chunks; empty sheets hidden | Risk: keys appearing after row 200 not exported; column-level formatting necessary for large data volumes | infrastructure, high priority |
| **ExcelJS compatibility and streaming** | [`server/excelHelper.ts`](../../server/excelHelper.ts) | writeBuffer under global export slot, HTTP content headers | ExcelJS 3.x write(stream) historically corrupt; never bypass coordinator or buffer-handling bridge | infrastructure |

## 3. Import/template compatibility contracts — hard stop rules

**Do not automatically place a branded title in row 1 of an importer-facing worksheet.** Report styling must not break parser assumptions. For strict imports, use a separate visible `Read Me` worksheet only if the importer selects the data sheet by name; otherwise keep the expected first worksheet and optionally append Instructions after it.

- Supplier return: first selected worksheet, row-1 `article_code`/`qty`; alias matching and quantity validation; sample rows in downloaded template.
- Agreed prices: first sheet `Price List` with row-1 `article_code`/`price`; a separate Instructions sheet is already supported.
- Finalized returns: first sheet `Returns`, `Ref Code` in row 1, with headerless single-column fallback support.
- ERP container import: `Container #` first-row contract, alias handling and other importer fields; audit both the client template and `server/routes/git/gitImportRoutes.ts`.
- ETA bulk update: `Container #` and `New ETA`, row 1.
- Bale relabel: `current_reference_code` and existing alias recognition.
- No-cost container items: `Container Items` worksheet with **A3:D3** precisely `NO`, `BARCODE`, `DESCRIPTION`, `Q'TY`; a `TOTAL Q'TY` footer has special treatment.
- Factor in future factory import formats/aliases from the import modules, not just export buttons. Tests `tests/xlsx-import.test.ts`, `tests/ui/excel-roundtrip-behavior.test.ts`, and `tests/import-regression.test.ts` are regression gates.

**Import/export distinction:** The new default report template can have a title, metadata rows and optional summary. Strict import templates keep the data sheet at required absolute positions, with separate presentation-only sheets or limited header styling. The two modes must be explicitly declared; never infer from filename alone.

## 4. Data integrity, security and formatting risks

| Priority | Verified source-level observation | Required migration guard |
|---|---|---|
| Critical | `server/services/export-excel/sheet-helpers.ts` collects keys from only the first 200 data rows. | Declare schema columns, or derive a complete deterministic key union with bounded memory; never omit a late-appearing field. |
| Critical | Several importers assume first worksheet or row/header positions, while report exports can have merged title rows. | Schema mode: fixed import coordinates; report mode: branded title layout. Explicit roundtrip tests. |
| Critical | Sensitive cost and selling values are conditionally hidden by `server/helpers/exportVisibility.ts` and factory-specific guards. | Enforce selected-company and cost visibility server-side for server-generated exports; client buttons must not be the security boundary. |
| High | `server/excelHelper.ts` documents broken ExcelJS 3.x stream writes; `server/exportBufferBridge.mjs` and global export coordination already mitigate memory and corrupted downloads. | Keep the safe writeBuffer/coordinator pipeline and attachment bridge; verify valid ZIP/XLSX signatures and downloaded content. |
| High | `client/src/pages/stockitems/useStockItems.ts` calls `formatAmount` before exporting prices; agent statements export formatted running balances. | Separate raw numbers from formatted display values so Excel can calculate, except where external import contracts require text. |
| High | Factory Daybook detailed export fetches voucher lines per entry and groups by transaction type; summary has fewer columns. | Preserve both export commands, voucher completeness and multiple sheets. No silent summary fallback changes. |
| High | Monthly production matrix validates underlying bale count reconciliation and produces variable month columns with drilldown references. | Treat as a specialized builder; preserve calculations, links, formulas, print setup, and status exclusions. |
| High | Multi-sheet preview of finalized sale returns escapes formula-like user text and protects leading zeros in references. | Centralize escape-text sanitization for data cells while preserving barcode/article codes as text. |
| High | Stock Items exports use a complete filtered multi-page fetch and fail if incomplete. | Standard export data adapter must request all pages and fail closed on partial data. |
| Medium | Date strings vary (`en-GB`, `en-CA`, user preferences), and some cells are actual Dates. | Canonical date values and configurable display format; never change importer date interpretation or fiscal periods. |
| Medium | Worksheet names, order, subtotal groupings, optional FX columns, signed Dr/Cr and invoice calculations carry report meaning. | Use per-report shape contracts; visual changes must not alter values, ordering or exported semantics. |
| Medium | `server/services/export-excel/sheet-helpers.ts` uses 30,000-row chunks and column-level number formats, intentionally avoiding per-cell fills on large sheets. | Maintain chunking and scalable styles; never load all filtered pages into separate duplicate arrays where avoidable. |
| Medium | Dispatch and invoice exports include cost controls, historical revisions and audit logging. | Preserve auth checks, source snapshots, audit logs and all current endpoint URLs. |
| Medium | Net Position, Net Profit, accounting statements and Properties rents can include cross-currency and prepaid/payment timing. | Never recalculate amounts in the presentation engine; use authoritative page/business logic. |

### Authorization boundary

`requireAuth` alone does not demonstrate complete export permission enforcement. Existing code uses `getExportPriceVisibility`, `authorizeFactoryPageAccess`, `getFactoryAccessState`, and per-company scope. Phase 2/5–8 must verify the **effective** permissions on every migrated endpoint including role changes, company isolation and hidden cost fields. This is an audit requirement, **not** a claim of an exploitable vulnerability in a particular route.

### Security and precision policy

Text identifiers (barcode/ref/article/PO numbers) must remain strings to keep leading zeros and resist formula injection. Costs, quantities, exchange rates, Dr/Cr values and currency totals must remain numeric where the consuming workflow permits. Reconciliation must compare numeric results to current exports in the same company and filters. Only valid numeric formulas should be executable; external/user-controlled strings must be escaped as text.

## 5. Proposed shared-engine boundaries (Phase 2 acceptance criteria)

- A versioned **column schema** with `key`, `header`, `valueType`, `required`, `width`, `permissionTag`, `numberFormat`, `aggregate`, and optional dynamic-column generator; dynamic columns get deterministic order.
- A **report presentation mode** for normal flat data tables; a **grouped/specialized builder** for statements, matrices, manifests, invoices, payroll and audit forms; an **import-compatibility mode** that preserves exact data cell coordinates and headers.
- A **workbook metadata context** with company, source page, export timestamp and date format, active filters, currency, authorized report flags and feature identifier. Do not mix this metadata into canonical data rows.
- A **data adapter** that retrieves the whole server-filtered dataset, validates completion and preserves authoritative totals, sheet order and external file naming where it is consumed downstream.
- **Server and client usage adapters** over the existing ExcelJS helper/coordinator. Retain current safe write and ZIP validation behavior; avoid a second heavy workbook allocation.
- **Admin presentation controls** (later phase): changing themes cannot change fields, permissions, data, formulas or strict import templates. Database storage decisions deferred to Phase 9.
- Migration must be **incremental and reversible** per export ID, not global runtime monkey-patching. Existing endpoints and download actions remain intact.

## 6. Proposed rollout groupings

1. **Pilot:** Stock Items, Containers/OTW, Factory Stock OTW; these exercise simple tables, dynamic location price columns and grouped items.
2. **ERP/POS:** sales/POS, Stock Query, supplier reports, vouchers, customer statements and ERP operational exports.
3. **Factory:** production, bales, stock allocation, scanner, attendance, loadings, dispatch trip manifests and factory inventory.
4. **Finance/Properties:** Daybook, Agent/Customer/Supplier statements, Net Position, Net Profit, rental/tenant statements, FX and balance sheets.
5. **Specialized and protected:** SP Sales Form, Monthly Production, customer invoices, shipment forms, match previews, exports used as imports, full-company dataset and scheduled ZIP/WhatsApp attachments.

## 7. Tests and release gates (to implement from Phase 2 onward)

- XLSX validity: write, reload, worksheet count/names/ordering, workbook property persistence, no 0-byte downloads.
- Exact schemas: import templates preserve first-sheet and absolute header coordinates; test with real importer parsers.
- Dynamic columns: add a location, new month, optional FX, new cost visibility and a late-sparse row field after row 200.
- Rows/completeness: nonempty, empty, one-page, multiple-page, filtered, concurrent updates and incomplete pagination.
- Precision/formulas: totals, sub/totals, numeric type, negative Cr/Dr, exchange rates, dates, shared formulas, named references and drilldowns.
- Privileges: Admin, Developer, Owner, Manager, POS, View Only, hidden-cost roles, cross-company leakage and 403 handling.
- Hierarchical workbook: grouped Stock OTW, loading/dispatch, tenant/statement B/F rows, monthly matrix, summarized quantity sheets and frozen headers.
- Large exports: concurrent downloads, queue timeouts, bytes/ZIP length, memory ceilings, browser disconnect cleanup, attachments and scheduled exports.
- Filename and user-visible download behavior; validate Excel opening, print pages and locale-specific date display.
- Existing regression suites to consult: `tests/excel-helper.test.ts`, `tests/excel-export.test.ts`, `tests/xlsx-export.test.ts`, `tests/xlsx-import.test.ts`, `tests/location-inventory-export-exact.test.ts`, `tests/ui/excel-roundtrip-behavior.test.ts`, `tests/ui/container-export-enhancements-behavior.test.ts`, and `tests/net-position-excel.test.ts`.

## 8. Phase 1 completion checklist and limits

- [x] Working branch created (same branch intended for phases 2–10).
- [x] Source-discovery inventory and candidate classifications recorded as JSON.
- [x] Direct source inspection of a representative set of export builders, routes, importers, helpers, tests and historical engineering audits.
- [x] Page/report contract matrix, dynamic field rules, financial/cost controls and strict import signatures documented.
- [x] Rollout sequencing and Phase 2 acceptance contract documented.
- [x] Only documentation added to branch — **no export logic, database schema, SQL or production data changed**.
- [ ] Live UI/database export sampling and byte-for-byte baseline fixtures — deliberately reserved for implementation/testing phases; unavailable from read-only repository inspection.
- [ ] Verify each indexed candidate is an actual active export and locate indirect call sites during its migration — candidate inventory is intentionally over-inclusive to avoid missed work.

**Phase 1 is complete as a source-code audit and compatibility plan, not as a live production certification.** Do not merge or deploy the audit alone. Proceed to Phase 2 on `feature/universal-excel-export-system`, enforcing the contracts above.
