# Universal Excel Export — Phase 3: Dakzo Report Design

**Branch:** feature/universal-excel-export-system  
**Status:** Implemented as an **opt-in report theme**; existing page exports are not migrated in Phase 3.  
**Scope:** Presentation code, tests and documentation only. No database writes, SQL, merge or Render deploy.

## What Phase 3 delivers

A single, reusable presentation layer for ERP, Factory and Properties report workbooks:

- **Dakzo Systems** text branding, without requiring an external font or logo asset.
- Consistent title strip on row 1, company / currency / export date on row 2, filter summary on row 3, optional brand caption on row 4, table header on row 5.
- Theme-based header background, readable contrasting text, Aptos typography, standard column widths and numeric/date alignment.
- Zebra row shading on small/medium reports, uniformly disabled for files with over 3,000 detail rows to avoid expensive per-cell styling on large exports.
- Precomputed group subtotals and report-wide totals with distinct colors and top borders; the engine **never recalculates** cost, debit/credit, exchange rates or voucher amounts.
- Real typed Excel number/date values; fixed table headers, filters, frozen rows and multi-sheet ordering from Phase 2 are preserved.
- A4 print layout with landscape for 9+ columns, repeatable report/table headers, fit-to-width settings, margins, print area and page number footer.
- A **neutral slate preset** alongside the default Dakzo palette.
- Optional per-workbook brand name, RRGGBB accent, branding visibility, alternating-row policy and print setting, with validation and high-contrast foreground selection.

## Implementation

| File | What changed |
|---|---|
| shared/universal-excel/design.ts | New theme presets, validated design overrides, contrast helper, group/total styling, print layout |
| shared/universal-excel/engine.ts | Report-mode integration with design tokens, metadata brand row, header alignment, selective zebra stripes and print settings |
| tests/universal-excel-design.test.ts | Theme, workbook roundtrip, grouping, totals, print, large export, injection and import/custom safety regression tests |

**Design defaults:**

| Element | Value |
|---|---|
| Brand | DAKZO SYSTEMS |
| Primary/title/header | #183153 |
| Text on primary | Auto-selected high contrast (white on default navy) |
| Alternating data row | #F4F7FB |
| Subtotal band | #EAF1FA |
| Grand total | #DCE8F8 |
| Standard number format | #,##0.### |
| Money | #,##0.00 (without an imposed currency symbol) |
| Date | DD/MM/YYYY unless workbook specifies MM/DD/YYYY |
| Report header | Row 5 by default, unchanged from Phase 2 |
| Printing | A4, portrait up to 8 columns; landscape from 9 columns; repeat headers |
| Large report threshold | >3,000 detail rows: no per-row zebra fills, preserving memory |

The workbook's optional \`currencyCode\` is displayed in metadata. Money format does **not** silently append \`$\` or assume that all companies use one currency. Page-specific number formats always take precedence.

## Strict compatibility boundaries

**Import-template mode** deliberately bypasses Dakzo report metadata, branded row 4, zebra shading, print-area setup, and custom accent settings. It retains the exact row/column coordinates required by the importer (e.g., first-row \`article_code\`/\`qty\` and \`Container Items\` headers in \`A3:D3\`). Header colors from the existing Phase 2 path are unchanged.

**Custom sheet mode** is never restyled: canonical invoices, SP sales forms, production matrices, dispatch manifests and other special layouts keep their own builders and print configuration until they are individually reviewed in the later phases.

**Cost security** is not altered by visual settings. Page/endpoint data adapters remain responsible for company scope, permission checks and selecting hidden fields.

**Export integrity** is not altered: layout changes cannot reorder rows, add fake totals, change formula results or calculate financial values. All report colors are pure presentation only.

**Large-file behavior** retains the existing ExcelJS writeBuffer compatibility and heavy-export coordinator. The new design avoids adding per-cell zebra fills for sheets with more than 3,000 detail rows.

## Opt-in API

~~~ts
import type { UniversalExcelWorkbookSpec } from "@shared/universal-excel/engine";

const spec: UniversalExcelWorkbookSpec = {
  schemaVersion: 1,
  mode: "report",
  title: "Stock Items",
  companyName: company.name,
  currencyCode: "USD",
  exportedAt: new Date(),
  dateFormat: "dd/mm/yyyy",
  appearance: {
    preset: "dakzo",
    brandName: "DAKZO SYSTEMS",
    // Optional: accentColor: "#183153",
    alternateRows: true,
    printLayout: true,
  },
  sheets: [{
    kind: "table",
    name: "Inventory",
    columns: [
      { key: "article", header: "Article Code", type: "text", required: true },
      { key: "qty", header: "Quantity", type: "integer" },
      { key: "price", header: "Price", type: "money" },
    ],
    rows: authorizedFullyFetchedStockItems,
  }],
};
~~~

Use the Phase 2 client/server adapters to write it. The source example is illustrative, not a new production page.

## Verification

Automated regression tests were committed in \`tests/universal-excel-design.test.ts\` for:

1. Default Dakzo + slate colors and contrast; color and brand-name validation.
2. Workbook XLSX serialization and reload, title, company, brand and exact report header row.
3. Consistent zebra fills on small reports and distinct subtotal/grand total styling.
4. Correct XLSX numeric types, formats and precomputed totals.
5. A4 print setup, repeated table headers, sheet print area, page numbering and wide-sheet landscape.
6. Workbook options to change branding, accent, zebra style and print settings.
7. Sanitization of Excel header/footer control characters.
8. No per-row zebra style on large report exports.
9. Strict import-template format unchanged; no decorative metadata rows.
10. Custom invoice/matrix worksheets retain original formulas and layout.

**Execution limitation:** This connection supports GitHub reads/commits and source inspection but does not provide a runnable full repository checkout or ExcelJS/Vitest dependencies. The tests are **written, not confirmed passing**; do not describe a typecheck or test run as successful until CI or a full local environment executes it.

Required next validation from a checkout:

~~~bash
npm run check
npx vitest run tests/universal-excel-engine.test.ts tests/universal-excel-design.test.ts
npm run build
~~~

## Phase 4 handoff

Integrate dynamic column schemas, schema discovery and per-report declarations using this presentation system, then migrate real export buttons in Phases 5–8.

**Phase 3 is implemented in the feature branch, but it is not deployed or universally active on ERP pages until those later migrations.**
