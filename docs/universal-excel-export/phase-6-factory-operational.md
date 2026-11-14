# Universal Excel — Phase 6 Factory Operational Workbooks

**Branch:** `feature/universal-excel-export-system`
**PR:** [#3204](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/pull/3204) (draft; no merge).
**Scope:** Factory-only operational Excel exports, including inventory, production, pressing, attendance and dispatch.
**Status:** Source migration committed. Full CI, i18n and permission verification are release gates.

## Full universal engine migrations

- **Pressing Machine Reports** — `pressing-scanner/pressingReportClient.ts`: visible columns in original order; condensed and detailed sheets; all pages fetched with the original `asOf` snapshot and 30,000-row guard; original totals and date/time displayed in Beirut. Currency numeric types and formula-safe names handled centrally.
- **Daily Scan** — `DailyScan.tsx`: scanned before missing, reference/article text including leading zeros, worker, dates, time, numeric KG and scanned count footer.
- **Workers Salaries** — `factoryworkers/useFactoryWorkersModel.tsx`: every filtered worker and the original salary/due fields, with due-today fetched freshly, unavailable values left blank, original totals preserved.
- **Stock Allocation V5** — `factorystockallocationv5/useFactoryStockAllocationV5Model.tsx`: uses complete filtered pagination from the existing exporter, same six columns and sum totals; available-balance red/green status highlighting retained.
- **Wipers Re-entry** — `wipersreentry/exportWorkbook.ts`: created-bale list, references, product, article code, numeric weight and entry date.
- **Raw Production Daily Report** — `server/routes/factory/bale-exports/daily-report.ts`: server-generated workbook, current company and date filters, total KG and explicit permission-gated Cost/KG column. PDF path untouched.

## Nonstructural Dakzo branding on special-purpose workbooks

`shared/universal-excel/factoryOperationalStyle.ts` styles existing headers and prints the brand without inserting any rows, renaming tabs, changing cell values/formulas/links, resetting filters, reshaping merged cells, or touching red/green data fills. It is applied to:

- Factory **Bales export** and **Stock Register + Summary** (`server/routes/factory/bales/balesExportRoutes.ts`).
- **All-location** and **single-location** Stock Inventory (the two server location-inventory export routes, including Wipers & Garbage and Bale Details).
- **Ground Scan** / reconciliation summary plus optional missing/extra bales; red/amber exception headings preserved.
- **Attendance** weekly blank/results and range by Active/Inactive workers; preserve Arabic/English headers and printable row layout; status marks and totals unaffected.
- **Weekly Production Targets**, **Bonus History** and **Weekly Bonus Payments**; formula/linked-worker calculations and voucher/payroll evidence unchanged.
- **Loading Dispatch** trip report, scans, article comparison, discrepancies, audit trail and closure history; no dispatch or account writes.
- **Weekly Factory Bale Production Report**; each dated group is still a self-contained worksheet section.
- **Factory Price List** import/download template; row-1 headers, read-only IDs, editable columns and layout remain intact.
- **Raw Material Historical Mix Cost Analysis** data sheets; Dashboard formulas, source/FX costs, month relationships and cards are untouched.

## Explicitly protected / excluded

These remain their own import template, invoice layout or specialized contract (future Phase 7/8 scope where appropriate):
- Factory container import templates, additional-item templates, bale import and relabel templates, PO and proforma import templates, factory worker import templates, Sheets & Sacks import/output templates.
- Customer invoices, order loading Excel, dispatch trip posted vouchers, and raw factory accounting/Daybook/customer statement ledgers.
- Full Monthly Production Matrix with drilldown formulas and exact worksheet structures.
- Source files with no export action or only PDF/CSV outputs.
- Factories' actual stock, worker, attendance, production, accounting, vouchers, and SQL records are not modified.

## Essential verification

Focused tests: `tests/universal-excel-factory-operational.test.ts` covers every metadata/header contract, formulas and reopenable XLSX, import row-1 compatibility, hidden-cost columns, and status colors.

Required checks before merge:
```sh
npm run check
npx vitest run tests/universal-excel-factory-operational.test.ts tests/universal-excel-engine.test.ts tests/universal-excel-design.test.ts tests/universal-excel-dynamic-columns.test.ts
npm run lint
npm run build
```

Manual acceptance: pressing export >250 rows + asOf consistency; date-filtered Factory Bales and Stock Register, cost hidden vs authorized; both inventory route modes; worker due-today snapshot; negative available allocation; attendance Arabic/English results and range; dispatch trip with wrong/missing/duplicate scans; bonus totals and historical sources.

**No TablePlus SQL, database migration, merge to main or Render deployment was required or performed for Phase 6.** Existing PR/CI findings from earlier phases, particularly localization and stale main, must still be resolved before production.
