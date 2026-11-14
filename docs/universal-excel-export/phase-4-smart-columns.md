# Universal Excel Export — Phase 4: Smart Dynamic Columns

**Branch:** `feature/universal-excel-export-system`  
**Status:** Implemented as opt-in column infrastructure and schemas; source-level verification complete, runtime tests need a runnable checkout.  
**Scope:** Smart columns, strict data-source accessors, deterministic placement, predeclared module schemas, regression tests, plus a data-loss fix in the existing full-company dataset exporter. **No SQL, merge or deployment.**

## What changed

| Source | Role |
|---|---|
| `shared/universal-excel/columns.ts` | Dimension families, sort and placement rules, conditional fields, local price/month/currency/attribute builders |
| `shared/universal-excel/reportSchemas.ts` | Explicit initial per-module column schemas for Stock Items, monthly production, Daybook, currency comparison, agent statement, optional attributes |
| `shared/universal-excel/engine.ts` | Read-only, declared source-key accessors; strict validation of nested sources; multi-tag column visibility |
| `server/services/export-excel/sheet-helpers.ts` | Full-company workbook now discovers all keys across all rows instead of only the first 200, without duplicating the rows |
| `tests/universal-excel-dynamic-columns.test.ts` | Dynamic layout, numeric values, permissions, month array mapping, sparse fields beyond row 200, XLSX round trips |
| `docs/universal-excel-export/phase-4-smart-columns.md` | Phase handoff and migration instructions |

## Declarative dimension families

One dynamic family declares a `namespace`, a `sourceKey` in the existing row, an explicit list of dimensions and a value type. The builder creates exactly one column for each enabled dimension. Data is not flattened or copied into a second full array.

- **Locations** — alphabetical `Price - <Location Name>`, keyed by stable location ID. A missing per-location price can fall back **only** to the caller-supplied default price field. This is an explicit option, not automatic price calculation.
- **Production months** — validated `YYYY-MM` IDs, chronological columns, `integer` counts and optional source arrays. Display-order sorting does not disturb the original source-array indices. For array-backed matrices, missing positions fail instead of silently dropping a month's quantity; record-backed missing counts remain blank unless the caller supplies a value.
- **Currencies** — sorted ISO-style three-letter codes, `Amount (EUR)`, `Amount (USD)`, etc. FX rate columns are optional, typed numeric cells with the explicit `#,##0.000000` display format. The engine never converts currencies itself.
- **Custom attributes** — named/typed fields from the page's known metadata. Arbitrary keys do **not** become exposed spreadsheet columns.
- **Conditional fields** — opt-in group insertion for summary/detailed modes, FX and other page flags. All fixed/dynamic columns are placed deterministically at explicit anchors.

The following helper exports are the Phase 4 API:

```ts
buildUniversalExcelDimensionColumns(family)
buildLocationPriceColumns(locations, { fallbackPriceKey: "defaultSellingPrice" })
buildProductionMonthColumns(months, { sourceKey: "values", sourceFormat: "array" })
buildCurrencyColumns(["EUR", "USD"], { measure: "fx-rate" })
buildAttributeColumns(attributes)
composeUniversalExcelColumns(base, [{ after: "costDubai", columns: locations }])
selectUniversalExcelConditionalColumns([{ enabled: showFx, column: fxColumn }])
```

The engine's `UniversalExcelColumn` supports `value(row)` and **mandatory `sourceKeys`** for derived columns. This allows `row.pricesByLocation[id]`, `row.values[index]` and `row.amountsByCurrency[currency]` without allocating another full flattened dataset. All derived values pass the same text, date, numeric, integer and formula validation as ordinary columns.

## Initial page schemas and exact relative placement

| Report | Source field keys/shape | Columns |
|---|---|---|
| ERP Stock Items | `code/name/barcode/aliasCodes/uom/stockGroup/grade/category/defaultSellingPrice/costDubai/pricesByLocation/active` | Code, Name, Barcode, Alias Codes, UOM, Stock Group, Grade, Category, Default Selling Price, Cost Dubai, **Price - <Location>** (alphabetical), Active |
| Factory Production | `name/articleCode/categoryName/monthCounts/totalBales` (or `values` array) | Item Name, Article Code, Category, **<Month Year>** (chronological), Total Bales |
| Factory Daybook Summary | `date/type/description/currency/amount/fxRate/amountUsd/optional` | Date, Type, Description, Currency, Amount, FX Rate, Amount (USD), Optional |
| Factory Daybook Detailed | summary data, optional FX, `accountName/debit/credit` | Date, Type, Description, Currency, Amount, Amount (USD), Optional, Account Name, Debit, Credit |
| Finance Currency Comparison | `date/description/amountsByCurrency/fxRatesByCurrency/totalUsd` | Date, Description, Amount (CUR1), Amount (CUR2), optional FX Rate (CUR1), optional FX Rate (CUR2), Total USD |
| Agent Statement | `ledger/type/debit/credit/runningBalance/date/notes`, optional `fxRate` | Ledger, Type, Debit, Credit, Running Balance, Date, Notes, optional FX Rate |
| Custom Attribute Report | base fields plus `attributes` record | Retains fixed fields, adds explicitly configured optional attribute columns |

These are **schema definitions only**, not claims that production export handlers already emit these normalized field names. During Phases 5–8 the export-specific adapter must map existing data to the declared shape, preserve complete filtered pagination, and test field-by-field equivalence to the old workbook. In particular, the specialized Factory monthly-production workbook retains its own drilldowns, coloring and Excel table until its dedicated migration.

## Safety and compatibility guarantees

- **No silent fields:** the engine rejects unmapped row source keys by default, including properties that appear only in the final row.
- **No hidden-cost leakage via columns:** columns with a `permissionTag` or `permissionTags` are emitted only if the caller explicitly grants **every required tag**. This is a secondary safeguard, not server-side authentication or cost authorization.
- **No scope changes:** pages remain responsible for selected-company isolation, role and cost visibility, and complete filtered datasets. Nothing in Phase 4 changes authorization on existing routes.
- **No incorrect price fallback:** default selling price fallback is explicitly configured. An absent currency or production value stays blank unless a declared missing-value policy says otherwise.
- **No mangled codes:** article codes, aliases and barcodes remain text. User-controlled formula-like strings are escaped by the engine, not executed.
- **No invented totals:** the engine displays supplied authoritative totals. It doesn't calculate production quantities, FX gains/losses, supplier balances or voucher journal entries.
- **No import breakage:** all new columns are opt-in. Existing import-template row-1 and A3:D3 contracts are untouched; new report metadata is not inserted in import mode.
- **No formula/layout changes to special sheets:** custom sheets (invoices, production drilldowns, manifests) remain untouched.

## Existing full-company exporter fix

The existing `server/services/export-excel/sheet-helpers.ts` detected union keys only in the first 200 records and could lose fields first present in record 201 or later. It now scans **every row** in order, collecting the exact stable first-seen union of keys, and rejects more than Excel's 16,384-column limit. This keeps the existing data export formatting, chunk size (30,000 records), worksheet names, first-row header position and no-per-cell-styling memory safeguards.

This is the only already-active export logic altered in Phase 4; verify against large-company fixtures before production rollout.

## Test and rollout gate

`tests/universal-excel-dynamic-columns.test.ts` includes focused checks for:
1. Stable stock price column order and exact numeric Excel cells.
2. Default price fallback, disabled locations and duplicate-location rejection.
3. Missing permission tags and multiple required tags.
4. Chronological production months with original source-array index.
5. Invalid month IDs and no invented zero production rows.
6. Sorted currencies, optional six-decimal FX and accurate original amount cells.
7. Conditional Daybook summary vs detailed, and agent FX columns.
8. Typed custom attributes, duplicate fields and unknown insertion anchors.
9. Formula-like input text and malformed nested value sources.
10. Sparse dynamic field presence after row 200.
11. Full-company export preserving a field first present after row 200.
12. Round-trip ExcelJS XLSX validity; empty sheets and non-mutating inputs.

Tests have been added, but were **not executed** in the connector-only session. From a runnable repository checkout, execute:

```bash
npm run check
npx vitest run tests/universal-excel-engine.test.ts tests/universal-excel-design.test.ts tests/universal-excel-dynamic-columns.test.ts tests/export-excel-sheets.test.ts
npm run build
```

No database migration or TablePlus SQL required.

## Phase 5 handoff

Start ERP module migration (Stock Items, Containers/OTW, PO, POS, Stock Query and other ERP operational exports). Choose **one** report at a time, map the current fields to the declared schema, gate costs by the real API permissions, confirm pagination completeness, compare XLSX worksheets and amounts, then replace that one download call with the existing Phase 2 browser adapter. Keep all changes on `feature/universal-excel-export-system` until the user authorizes a merge. Before integration, sync the feature branch with any unrelated main changes and rerun the complete verification suite.
