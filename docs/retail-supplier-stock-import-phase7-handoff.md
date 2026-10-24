# Retail Supplier Stock Import — Phase 7 integration and Claude handoff

**Branch:** `feature/retail-supplier-stock-import-20261024`  
**Repository:** `Hassan-Merhi/ERP-FACTORY-SYSTEM`  
**Scope:** Retail company type only; existing ERP supplier ledger, vouchers, inventory/stock movements, barcode POS and label routes. No Factory voucher or stock rewrites.

## Source-level integration (completed, not runtime-tested)

1. `RetailInventory` exposes **Supplier Stock Import** and no longer exposes the legacy direct-stock importer button. The legacy `POST /api/retail/import` endpoint remains in the code for compatibility, and must not be used by this supplier-credit workflow.
2. Supplier Excel/CSV columns: Item Name, Category, Brand, Size, Color, Quantity, Cost Price, Selling Price, Main Image, Extra Images, SKU, Barcode, Description. SKU and Barcode are TEXT to preserve leading zeroes; numeric Excel cells are rejected. Item, brand, category and description limits match server purchase schema.
3. `RetailSupplierImportDialog` stages/validates rows and optional image ZIP; server catalog preview is company-scoped, read-only and does not reserve barcodes. Conflicts block confirmation.
4. `POST /api/retail/supplier-import/confirm` is the ONLY supplier-credit stock posting entry. Company supplier/location/attachment ownership, stock accounting opening, valid invoice date, same-invoice uniqueness, partial delivery references, transaction currency and barcode identities are rechecked in the purchase transaction.
5. The confirmed purchase uses transaction-only product/variant upsert and company-sequence EAN-13 allocation. **Existing variants retain the identical barcode**; new supplied barcodes are checked for uniqueness; blank barcodes are allocated at the posting transaction, not at preview.
6. Received quantity is ADDED to stock at one selected location, with weighted-average cost and append-only stock movements. One balanced central voucher is created **Dr Retail Inventory / Cr the ERP supplier**, with the transaction currency and historical USD conversion. Standard ERP supplier payment vouchers remain responsible for later settling that supplier; this workflow must not create a separate Retail supplier balance.
7. Exchange rates use the accounting engine's **transaction-currency units per USD** convention. The UI collects **USD per foreign-currency unit** and converts it on confirmation. The voucher table stores 6 fractional exchange-rate digits, so server stock valuation and entries use the same persisted 6dp rate rather than an incompatible 10dp calculation. The Excel **Cost Price** is in supplier invoice currency; the Excel **Selling Price** is always USD for Retail POS.
8. Supplier invoice attachments and product images are referenced by company-owned `stored_files` records. Server validates MIME, size and actual binary signatures from bounded Base64 header reads. Uploaded files persist separately before purchase confirmation.
9. Duplicate/idempotency protection: one immutable company-scoped request key and payload fingerprint; replay of identical request is read-only. A distinct repeated full invoice is refused. A partial invoice can have multiple receipts only when all previously saved receipts were partial, new delivery reference is unique for that supplier/invoice and currency is consistent. In-progress confirmation is serialized by a company advisory transaction lock.
10. Successful confirmation returns voucher/receipt/variant barcode/received quantities and opens the existing label printing UI. One label per received unit (NOT current stock balance); 50×30mm, 58×40mm, and A4. Printing 500 labels or fewer per job; selection/reprints via saved receipt; supplier costs excluded. Closing print UI cannot affect stock/accounting.
11. Company-scoped `GET /api/retail/supplier-import/history`, `history/:id`, and `requests/:key` provide saved invoice/receipt lookup, request recovery, attachment access, movement/variant barcode cross-check, full receipt details, and historical exact-quantity reprints. List reads compact persisted counts/totals rather than full 5,000-row JSON arrays for each receipt. Do not create a separate financial balance.
12. All new import confirmation/read routes are represented in `config/route-manifest.json` and import-data operational permission registry; no route bypass for POS users. History is read-only. Schema uses existing tables, so this feature introduces no new supplier-inventory tables or backfill.

## Claude verification and merge gate — NOT executed here

**Before touching the branch:** Snapshot the current `main` and feature branch commit SHAs. The branches have diverged substantially due to parallel ERP work. **Do not fast-forward, overwrite main, force-push, or resolve conflicts by indiscriminately choosing ours/theirs.** Integrate selectively, preserving intervening Retail UI, accounting, route-policy and inventory changes from main.

### Required checks (Claude only)

- Run TypeScript/build/lint/tests as allowed by the user; include `tests/retail-supplier-import-*.test.ts`, `tests/retail-supplier-receipt-labels.test.ts` and operational route-manifest/permission assertions. First resolve any source-level type or import errors.
- Confirm Retail supplier ID is company-owned and points to the *same* ERP supplier entity used by standard Payment vouchers; check Dr inventory and Cr supplier have equal **base USD** and original **invoice transaction** amounts.
- Exercise separate Retail companies with identical supplier invoice numbers, barcodes, names and idempotency keys; ensure strict company isolation. Never use a Factory payable account for Retail purchases.
- Confirm existing product and variant re-use; product/size/color/SKU/barcode conflicts; new styles with multiple variants; stored barcode scanning in POS and retail transfer workflows.
- In a disposable **test company** with inventory opening in place: purchase 2 products with images and printed labels; verify each receipt quantity and cost, journal debit/credit, supplier aging and supplier Payment settlement from a selected cash/bank account. Compare Inventory Sub-Ledger to Inventory ledger at cent precision. Then try a partial second receipt and duplicate delivery rejection.
- Test foreign currency with USD/EUR/CFA and historical rates; ensure the saved voucher rate has **6dp**, normalized entries and weighted-average cost reconcile. Use small and large values and rounding edge cases; no rate inference/default for non-USD.
- Retry same request ID/payload, changed payload with same request ID, same supplier invoice/different request ID, and interrupted client after upload/after commit. **Must never duplicate quantity, barcodes or payable.**
- Confirm PDF/JPEG/PNG invoice attachment and ZIP JPG/PNG/WEBP/GIF media types are company-owned and signature-validated; wrong MIME, wrong company, oversized files and invalid ZIP paths fail closed.
- Print more than 500 labels; verify one-per-received-unit across batches, thermal sizing, exact barcodes, no cost on labels, and historical print audit. Cancel browser print and re-open saved receipt; purchase must remain intact.
- Reconcile history receipt rows to stock movements and stored current variant barcodes; block label reprints when inconsistent. Confirm history search, paging, attachments and permission failures.
- Audit whether `POST /api/retail/import` needs additional deprecation controls beyond hiding the legacy Retail UI button. It still exists for unrelated backward compatibility and can modify stock without supplier payable.
- Review any lingering legacy stock operations, direct variant-stock editing, or Retail receipt routes that could silently bypass the supplier credit workflow. Preserve other authorized/non-supplier flows where needed.

### Known boundaries and risks

1. **Not deployed, merged, or integration-tested.** Phase 7 performed source-level fixes and authored tests for Claude; no CI or tests were executed, no production vouchers or SQL were touched.
2. **Uploaded-file orphan cleanup is not automatic.** Existing company files are written before the purchase DB transaction, so a truly failed purchase can leave unreferenced uploads. A timeout can also mean the DB committed, so never delete based solely on request failure. For safe garbage collection, inspect references from all product/variant media and every saved supplier receipt and attachment before deleting only proven-unused files.
3. **Voucher rate precision:** Voucher schema stores 6dp while entry historical rates support 10dp. The supplier flow deliberately posts at the persisted 6dp precision. Claude should confirm this matches the central ERP accounting engine's reporting and source/rounding behavior.
4. **Potential stock valuation rounding:** The service fails the transaction if changed inventory sub-ledger value cannot reconcile with the posted invoice at cent precision. Do not bypass this guard using suspense or manual adjustments; investigate differing unit cost, average cost and historical FX rounding instead.
5. **Supplier import batch metadata** includes invoice snapshot line costs, selling prices, IDs, barcodes and quantities; full history details can be large (up to 5,000 lines). The list uses summary fields and strips the `items` JSON array at query time.
6. **Main branch drift:** Current feature branch edits `RetailInventory.tsx`, `retailRoutes.ts`, `config/route-manifest.json`, operational permission policy, `package.json` and lockfile; these are high-conflict paths. Do not use stale route counts or drop unrelated main changes.
7. There is no purchase reversal/credit-note implementation in this workflow. Posted accounting vouchers must be corrected through established reversal controls, not by editing the original purchase metadata or subtracting stock ad hoc.

## Suggested next Claude instruction

> Review `feature/retail-supplier-stock-import-20261024` against the latest `main` and the checklist in `docs/retail-supplier-stock-import-phase7-handoff.md`. First identify conflicts and defects without modifying production data. Perform TypeScript/build/test and schema/permission/route validation, correct implementation defects on the SAME feature branch, then reconcile Retail inventory and supplier accounting invariants in disposable test companies. Preserve main's intervening ERP/Factory work. Report any failed gates. Do not merge/deploy unless separately authorized.
