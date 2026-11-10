# Factory Dispatch Trip Accounting — Phase 5 Handoff

**Date:** 2026-11-10  
**Branch:** `feature/factory-dispatch-trip-accounting-20261110`  
**Phase:** 5 — Per-truck ERP PO-compatible Excel export, using article codes, with independent supplier purchase rates.

**User's explicit constraints retained:** no CI checks or test execution; no SQL execution; all TablePlus scripts provided at the end of the full program; no merge to `main`; no Render deploy. No ERP automatic import button.

## Implemented workflow

1. Scan actual physical Factory truck bales, **End Dispatch**, then **Financially Finalize Trip** under Phases 3–4.
2. On the same trip page, open **ERP PO Excel export**.
3. Source is the **immutable posted** trip financial snapshot:
   - one frozen row per confirmed bale, with its article code and Factory monetary evidence;
   - normalized article codes are grouped, so `Quantity` is the number of those actually shipped bales;
   - bale reference numbers are **never** used as `Item_Barcode`;
   - one deterministic ERP PO and container number per original Factory company/order/trip.
4. Enter the exact **ERP Supplier_Code**. The Normal ERP import wizard will still require selecting and validating the ERP supplier.
5. Enter/review a separate **ERP purchase Rate for every article code**. This does NOT default to the Factory customer selling price: those can legitimately differ. Rate is USD **per bale**.
6. Review five independently editable ERP PO invoice fields: Freight, Surcharge, Fumigation, Discount, Document_Charges. Their suggestions come from mapped, financially posted Factory customer-billable charges and discounts, but they may be changed for the ERP supplier invoice.
   - Unmapped customer-billable Factory charges are explicitly listed as warnings, **not silently copied**.
   - Internal Factory-only expenses are **excluded** from the ERP supplier invoice.
7. Use **Preview ERP PO totals** to obtain the server's exact cents amounts and file fingerprint.
8. Confirm that the supplier, purchase rates, and PO charges were independently reviewed. Click **Export ERP PO Excel (.xlsx)**.
9. In **Normal ERP → PO Import**, upload the downloaded Excel, validate that each article code/alias and supplier matches the ERP master data, then manually import. **ERP's stock-item code/alias lookup is case-sensitive** (`getStockItemByCodeOrAlias` uses exact equality); the importer can fall back to a name match, so verify the exact destination ERP item ID/code rather than accepting a similar product name. Phase 6 will tighten these destination checks. **No API action on Factory automatically creates an ERP PO, supplier payable, stock receipt, voucher or ledger entry.**

## Exact PO Import workbook schema

The first (and only) Excel worksheet is `PO Import`, matching `GET /api/po-import/template` and the parser `server/routes/import/poImportExcelParser.ts`:

```text
PO_Number
Container_Number
Supplier_Code
Item_Barcode        ← signed Factory ARTICLE CODE (never bale reference)
Item_Name
Quantity            ← number of physically scanned bales of this article
Rate                ← manually reviewed ERP purchase rate PER BALE
Currency            ← USD
Freight
Surcharge
Fumigation
Discount
Document_Charges
```

Charges are stored on the **first item row only**, with 0 on all remaining rows; the existing ERP parser sums those fields across item rows. The XLSX workbook has row-1 headers, numeric qty/rates/charge cells, text-formatted identifiers, and a frozen header. No decorative or source-detail sheet precedes the import worksheet.

**Financial example:** Factory goods `$35.00` + customer billable charges `$20.00` − customer discounts `$2.00` = Factory customer receivable `$53.00`. Independently reviewed ERP goods costs `$14.50` + selected ERP charges net `$10.50` = ERP supplier invoice `$25.00`. These are **separate legal/accounting balances**; exporting does not post either balance again.

## New backend files

- `server/routes/factory/customer-orders/loadingDispatchPoExportModel.ts` — pure deterministic PO grouping by article, exact decimal money, per-article ERP rate requirement, proper charge bucket handling, stable company/order/trip PO identities, spreadsheet-safe identifier validation and SHA-256 export fingerprint.
- `server/routes/factory/customer-orders/loadingDispatchPoExportData.ts` — reads only financially POSTED / CONSOLIDATED snapshots and their recorded original posting vouchers; validates snapshot revision, fingerprint, customer amount, immutable charge lock, voucher presence and absence of cross-trip duplicate billed bales.
- `server/routes/factory/customer-orders/loadingDispatchPoExportWorkbook.ts` — ExcelJS workbook matching the existing PO Import template, first sheet, exact 13 columns.
- `server/routes/factory/customer-orders/loadingDispatchPoExportRoutes.ts` — Factory company/role/permission-scoped setup, read-only preview and guarded download.
- `server/routes/factoryRoutes.ts` — registers Phase 5 routes after Phase 4 posting and before legacy Factory routing.
- `server/services/security/operationalPermissionRoutePolicy.ts` — includes all three Phase 5 routes in `exp_excel` export permission gate.
- `config/route-manifest.json` — exact handler-registration route manifest entries.

### New endpoints

Under `/api/factory/customer-orders/:id/loading-dispatches/:dispatchId`:

| HTTP | Path suffix | Purpose |
| --- | --- | --- |
| GET | `/po-export/setup` | Read posted trip articles, suggested charge mapping and any prior export |
| POST | `/po-export/preview` | Read-only exact ERP invoice calculation and export fingerprint |
| POST | `/po-export/download` | Generates and returns .xlsx; saves canonical immutable export evidence exactly once |

All require authenticated Factory Loadings permission, Excel export permission, and Admin/Owner/Developer role. No `targetErpCompanyId` is inferred because this is a manually uploaded document, not a verified ERP company/receipt.

## UI implementation

- `client/src/pages/factory/FactoryLoadingDispatchPoExport.tsx` — responsive light/dark-mode editor for supplier, per-article ERP prices, editable PO charges and unmapped warning; server-confirmed preview, explicit acknowledgements and .xlsx download.
- `client/src/pages/factory/FactoryLoadingDispatch.tsx` — mounts PO export below trip financial finalization in the selected truck details.
- **No `Import into ERP` button**, import API call or automatic balance write.

## Idempotency and financial integrity

- The Export Fingerprint covers company/order/trip, financial ID/revision and frozen source fingerprint, supplier code, stable PO/container identity, every per-article cost, all ERP PO charge amounts and computed total.
- On the first successful XLSX generation, records one immutable `factory_dispatch_trip_exports` row and one `ERP_PO_FILE_GENERATED` event. Its status explicitly says `FILE_GENERATED_NOT_ERP_IMPORTED`; no claim that ERP received or imported the file.
- A repeated request for **identical** source/supplier/rates/charges re-downloads the original PO data without creating a second export record.
- After first generation, attempts with a different supplier, rate, charge or financial source are rejected. A linked cross-company correction will be needed if the wrong file was actually imported.
- The database transaction locks parent order → dispatch → financial row before saving export evidence. Buffered workbook generation happens **before** that final transaction to avoid holding financial locks during expensive Excel serialization.
- The previous Phase 4 reversal workflow already refuses reversing a trip after any export record exists.
- The backend refuses monetary export until the final Phase 5 unique index is installed. Phase 2 and Phase 4 TablePlus financial/RLS safeguards remain prerequisites.
- A written Excel file can be re-downloaded after a network interruption. A generated-file record is not proof the operator actually saved or uploaded it.

## Manual SQL — staged, NOT executed

`docs/sql/manual/2026-11-10-factory-dispatch-trip-financial-phase5-export.sql` creates:

- `factory_dispatch_trip_exports_financial_once_uq` — UNIQUE `financial_id` (at most one canonical PO file per posted trip).
- `factory_dispatch_trip_exports_source_lookup_idx` — scope/reconciliation lookup index.

`shared/schema/factory/dispatch-financials.ts` also declares the unique export index. All manual scripts will be provided together **at the end of the full implementation**, for the user to execute in TablePlus.

## Staged tests — NOT executed

`tests/factory-dispatch-financial-phase5.test.ts` covers grouping by article, independent purchase rates, real first-sheet template headers, billable charges only once, round-trip workbook parsing by the existing ERP PO importer, immutable identity, source reconciliation, invalid supplier/rates and duplicate/export protections. It was written but not run.

## Phase 5 completion boundary

**Source implementation is committed.** No CI tests, local build, database SQL, merge or deployment were run. The .xlsx path has not been validated against a live ERP importer/company database. Phase 6 should address target-ERP stock-code compatibility, supplier selection and the receiving PO import's duplicate/price safeguards without adding any auto-import button. Later reconciliation and consolidated Factory invoice posting remain separate phases.
