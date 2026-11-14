# Universal Excel Export — Phase 8 specialized workbooks

**Branch:** `feature/universal-excel-export-system`  
**PR:** [#3204](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/pull/3204) (draft; do not merge).  
**Scope:** multi-sheet, linked/formula-based, hierarchical, import-compatible, printable and large exports.

## Core design

`shared/universal-excel/specializedWorkbookStyle.ts` provides a deliberately nonstructural design bridge:

- Sets consistent Dakzo Systems workbook creator and unobtrusive print header on **selected visible report tabs** only.
- Existing print headers/footers, formulas and cached values, sheets and order, merged ranges, data validations, protection, auto-filter, frozen panes, hidden support sheets, print title rows, charts and historical numeric types are unchanged.
- Optional **validated** branding of an existing report header; never insert or move rows.
- Enforces exact sheet-name/order for fixed-schema workbooks, with prevalidation before any mutations.
- `import-template` sheets receive **no sheet mutations** (only workbook creator); explicit formatting requests on an import template fail.
- `formula-support` sheets remain hidden/protected and untouched.
- This adapter adds no per-row/per-cell styling on large workbooks; raw dataset tabs remain machine-readable at row 1. It does not replace the shared Phase 2–4 report engine.

## Specialized exports covered

| Export | Layout contract |
| --- | --- |
| Factory Monthly Production Matrix | Four sheets in exact order: `Monthly Production`, `Worker Breakdown`, `Daily Summary`, `Bale References`. Month columns, frozen A–C/row 6, numerical HYPERLINK formulas, cached totals, color-coded monthly highs/lows and drilldown references unchanged |
| SP Sales Form V2 | Three sheets exactly: hidden `Costing` and `Sales`, protected visible `ENTRY`; recalculation, formula references, fixed cash/payment rows and error scanner unchanged |
| Legacy SP Sales Form | Existing source XLSX template unchanged at worksheet level; keep its formula checks and template re-read; brand metadata only |
| Stock Transfer Order Truck Trip | Keep source-location groups, subtotals, no-cost/cost views, print dimensions and original filenames |
| WhatsApp no-cost Truck Trip/Approved Orders | Keep all prices absent, approved batch references, grouped quantities and formula-injection protection |
| Container export-all | One sheet per container with PO/offload sections in their existing relative positions; no inserted report rows or changed supplier/account fields |
| Canonical Factory Invoice | Keep snapshot totals, invoice number, cost visibility, HMD logo, destination/charges, localized Arabic/French/English headers and print dimensions; print branding only |
| Factory loading-session report | Single existing `Session` tab, same scanned and missing bale sections |
| Factory loading report | Existing `Summary`, `Loaded Bales`, `Remaining Bales` worksheet order, grouped quantities and weights |
| Factory customer proforma | Existing `Proforma Invoice` print layout and price authorization |
| Item Market Analysis | Dynamic company breakdown, overview and history worksheets preserve native totals and selected company/date filters |
| HMD Bale Order Sheets | Priced/no-price customer-editable `Make Your Order` templates retain row positions, formulas, widths and importer-facing headers; no worksheet-level restyling |
| Full Company Export | Both buffered `buildCompanyWorkbook` and memory-conscious `streamCompanyWorkbookDirect`. Only `SUMMARY` print brand and workbook metadata are changed; raw tabs retain row 1, late-sparse columns, 30,000-row chunks, hidden empty sheets and existing import/backup semantics |

## Invariants / scope exclusions

- All Phase 8 exports are **read-only**: never create accounting vouchers, change stock, ledger, customer, supplier or supplier-partner balances, reprice bales or mutate databases.
- Do not convert fixed invoice/account numbers, barcodes, references or long historical rates to floating-point values. Do not change calculations, dynamic columns, aliases or normalized destination-specific prices.
- HMD source branding, company logos and previously authorized commercial invoice data stay intact within canonical/customer-facing documents; new Dakzo branding is metadata and print presentation, not content rewriting.
- Any Excel workbook whose first row or fixed coordinate is consumed by an importer remains import-compatible and is not converted to a report table.
- Server export buffering continues through existing `writeWorkbook` or service routes; avoid the known broken ExcelJS direct response stream.
- Large backup snapshots retain their chunking strategy and existing memory limits; no extra whole-workbook copy is constructed for styling.
- Worksheet-level colors and exceptions were intentionally preserved where they encode discrepancies, missing bales, permission-hidden cost or accounting DR/CR signs.

## Verification

Added `tests/universal-excel-specialized.test.ts`: expected sheets/ordering, hidden formula support and editable ENTRY, true formulas and cached results, print/header preservation, strict import position, 30k+ rows without all-cell styling, sectioned per-container sheets, fail-closed invalid directives.

Existing relevant tests:
- `client/src/pages/factory/monthlyProductionExcelExport.test.ts` — production formulas/drilldowns and source totals.
- `tests/export-excel-workbook-behavior.test.ts` and `tests/export-excel-sheets.test.ts` — dataset coverage, large exports and late-sparse keys.
- `tests/stock-transfer-order-wa-phase5-workbook.test.ts` — no-cost columns and stored totals.
- `tests/ui/order-workbook-exports-behavior.test.ts` — sale/customer bale order and grouped truck-trip layouts.
- `tests/factory-invoice-document-rendering.test.ts` — canonical invoice numeric and localized rendered output.
- `tests/excel-export-v2.test.ts` — DB-backed SP sales form integration (requires a provisioned test database; not a pure workbook test).

Required release gates: TypeScript, frontend/backend Excel tests, lint, build, doc index, role/cost audit, full-company import round-trips, SP formula validation with database fixtures, and current-main integration. **No SQL, merge or Render deploy** in Phase 8.

## Observed branch validation — 2026-11-14

The [temporary Phase 8 validation run #43572242826](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/actions/runs/43572242826) completed successfully against the Phase 8 source changes.

- TypeScript: `npm run check` **passed**.
- Core specialized and existing workbook Vitest: **83 tests passed** across 10 suites, including source production-matrix drilldowns, stock-transfer no-cost, canonical invoice, full-company backup and existing universal engine/financial safeguards.
- Frontend workbook Vitest: **21 tests passed** across three suites (customer bale order sheets, truck trips and ERP financial adapters).
- Changed-source Prettier validation **passed**.
- Lint **passed** on **4,504 files**, with zero errors and zero warnings.
- Production build **passed**.
- Documentation index **passed**.

The initial attempt found three null-versus-undefined expectations in new print-header assertions; the assertions were corrected to reflect ExcelJS's actual absent-header representation. No Excel formulas or values failed. The branch-only write-enabled validation workflow was removed after the successful run.

### Production signoff still outstanding

The successful focused tests verify source-level workbook behavior, not live dataset parity. The older `main` divergence, PR localization/translation audit, DB-backed SP Sales Form V2 and production import round-trips, full PR CI, and hidden-cost/user-role testing still require integration before merging to production.

**Phase 8 specialized workbook implementation and focused validation complete. No SQL, merge or deployment.**
