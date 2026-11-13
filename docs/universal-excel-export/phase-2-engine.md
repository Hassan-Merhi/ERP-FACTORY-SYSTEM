# Universal Excel Export — Phase 2: Shared Engine

**Branch:** feature/universal-excel-export-system  
**Status:** Shared engine and adapters implemented (opt-in; not rolled out to existing report pages)  
**Scope:** Source changes only, no SQL, no merge, no Render deployment.

## Delivered components

| File | Responsibility |
|---|---|
| shared/universal-excel/engine.ts | Versioned schema, workbook builder, metadata, fixed-position import header, dynamic columns, grouping, formulas, column-visibility tags and custom builders |
| shared/universal-excel/filename.ts | Safe XLSX filenames for client/server downloads |
| client/src/lib/universalExcelExport.ts | Lazy client adapter using the existing ExcelJS-aware browser writeFile path |
| server/services/universalExcelExport.ts | HTTP download and buffer attachment adapters using the existing heavy-export coordinator / writeBuffer pipeline |
| tests/universal-excel-engine.test.ts | XLSX serialization/roundtrip, types, formulas, permissions, late dynamic fields, grouping, fixed import coordinates and invalid schema tests |

The shared engine does not replace the existing client/src/lib/excelHelper.ts, client/src/erp-core/erpReportExports.ts, server/excelHelper.ts or exportBufferBridge.mjs. It provides a safe, opt-in upper layer. Later phases migrate individual page handlers gradually, preserving current output until each is verified.

## API model

The entry point is buildUniversalExcelWorkbook(spec), returning an ExcelJS workbook and a result summary of columns/sheets/row counts. The caller then writes via an existing adapter, never raw ExcelJS stream writes.

- schemaVersion: 1 is required. Future incompatible updates must advance this contract.
- mode: report creates a branded title/metadata block with header row 5 by default. import-template never inserts report metadata; its default header is row 1 and it supports an explicit headerRow plus preceding rows for positional formats.
- sheets: ordered table, grouped or custom definitions; worksheet names and ordering are never silently changed.
- columns: exact key, header, optional type/width/numFmt/permissionTag. Additional dynamicColumns are appended in their supplied order. discoverColumns is an explicit authorization-conscious allowlist scanned across ALL rows, including late sparse fields.
- strictColumns: defaults true to reject unrecognized data keys rather than silently omit them. Only explicitly set false after the exporting adapter documents why extra keys should be ignored.
- allowedColumnTags: hides tagged columns by default, unless the already-authorized caller explicitly enables the tag. NOT a backend authorization boundary.
- footer/group.footer: authoritative precomputed values, not invented or recomputed by the styling layer.
- type formula: only accepts a deliberate { trustedFormula: "...", result: ... } object; plain user strings are never evaluated.
- type text: text identifiers retain leading zeros, while formula-like leading symbols are apostrophe-escaped.
- numeric/money/integer/percentage/date/boolean: preserved as native workbook values and number/date formats; malformed inputs fail explicitly.
- custom: uses exact existing builder body (e.g. invoice, matrix, stock-transfer form); the engine only allocates the named worksheet and leaves layout untouched.
- filters, companyName, exportedAt/dateFormat: visual metadata in report mode only.

### Minimal example (for Phase 3–8 adopters)

~~~ts
import type { UniversalExcelWorkbookSpec } from "@shared/universal-excel/engine";
import { downloadUniversalExcelWorkbook } from "@/lib/universalExcelExport";

const spec: UniversalExcelWorkbookSpec = {
  schemaVersion: 1,
  mode: "report",
  title: "Stock Items",
  companyName: selectedCompany.name,
  dateFormat: "dd/mm/yyyy",
  filters: [{ label: "Status", value: "Active" }],
  allowedColumnTags: canSeeCosts ? ["stock-cost"] : [],
  sheets: [{
    kind: "table",
    name: "Stock Items",
    columns: [
      { key: "code", header: "Code" },
      { key: "name", header: "Name" },
      { key: "qty", header: "Quantity", type: "integer" },
      { key: "cost", header: "Cost", type: "money", permissionTag: "stock-cost" },
    ],
    dynamicColumns: locations.map(location => ({
      key: "price_" + location.id,
      header: "Price - " + location.name,
      type: "money",
    })),
    rows: alreadyAuthorizedAndFullyFetchedRows,
  }],
};
await downloadUniversalExcelWorkbook(spec, "Stock_Items.xlsx");
~~~

**Important:** This is an API usage example, not an assertion that the Stock Items page has already been migrated. Preserve the existing stock exporter until its Phase 5 tests prove identical data and permissions.

Server-side adaptation:
- sendUniversalExcelWorkbook(res, filename, spec) for authenticated HTTP routes
- buildUniversalExcelAttachment(spec) for intentional attachment bytes
- Both must receive data already filtered by company, role, hidden-cost flags and route access checks.

## Compatibility and security checklist

1. **Import-template mode**: the first data sheet and exact coordinates remain authoritative. The engine does not prepend branded rows. For the legacy Container Items A3:D3 header, use headerRow: 3 and prefaceRows for the first two rows. Existing importer parsers remain unchanged.
2. **Hidden prices**: blocked permission-tagged columns are absent from the XLSX, but source APIs must also enforce authorization; do not pass unscoped/multi-company records to the builder.
3. **No silent data loss**: unknown keys throw by default; discoverColumns does not stop at 200 rows; no title/header overwrite.
4. **No silent data creation**: group footers and report footers come from the caller, not an automatic double-counting sum.
5. **Large workbooks**: the schema scans source rows without making another copy; no per-cell alternating fills on body rows; server uses the existing queue and safe response code. Page adapters must still fetch all filtered pages without partial results.
6. **Formula safety**: trusted formulas require an explicit typed wrapper; all other values go through text/number/date conversion. Custom builders remain responsible for their existing formula safety.
7. **Custom reports**: signed debits/credits, chronological ledgers, canonical invoices, sheet ordering, print ranges and matrix links stay in specialized builders.

## Phase 2 acceptance tests

Added tests/universal-excel-engine.test.ts for:
- valid XLSX ZIP bytes and ExcelJS reload of a standard report
- metadata title, date, company, filters, frozen header and filter
- native number and money cells plus barcode leading zeros
- hidden cost fields absent without column tag access
- dynamic allowlisted price column appearing only after row 200
- rejecting unmapped source fields
- string formula injection versus explicitly trusted formula objects
- native date values and locale display formatting
- grouped sections and precomputed subtotals
- importer headers at row 1 and A3:D3
- exact custom invoice/matrix builder layout
- duplicate names/columns, invalid numbers and untrusted formula rejection
- safe filename validation

**Execution:** Tests were added to the existing backend Vitest collection, but a complete repository checkout/dependencies and a runnable CI or local environment are needed to execute npm/tsc/vitest. The GitHub-only integration in this session supports source commits and diff inspection, not running application code. Do not claim a passing test run based only on source review. Run the focused tests before migrating the first production exporter:

~~~bash
npm run check
npx vitest run tests/universal-excel-engine.test.ts
npm run test:backend
~~~

## Next phase

Phase 3: universal design and theme tokens; controlled adoption through a first report sample on the SAME branch, then Phase 4 dynamic schema integration and Phase 5+ module-by-module migration. The default outputs and import routes currently stay unchanged.
