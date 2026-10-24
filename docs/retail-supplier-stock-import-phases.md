# Retail Supplier Stock Import — Phased implementation

Branch: `feature/retail-supplier-stock-import-20261024`

## Phase 1 — UI and spreadsheet preflight (implemented)

Entry: Retail company > Retail Inventory > **Supplier Stock Import**.

- A downloadable `retail_supplier_stock_template.xlsx` includes:
  `Item Name, Category, Brand, Size, Color, Quantity, Cost Price, Selling Price,
  Main Image, Extra Images, SKU, Barcode, Description`.
- Supplier is selected from the **active company's existing suppliers**
  (`GET /api/suppliers`, without parent-company fallback).
- Receiving location comes from the selected Retail company's active stock
  locations (`GET /api/locations`).
- Invoice/reference, receipt date, and invoice currency are collected in the form.
  Default purchase intent is supplier credit; no payment is posted in Phase 1.
- XLSX and CSV uploads parse the first worksheet; invalid files and empty sheets
  are rejected. Maximum 5,000 rows / 15 MB. Source Excel row numbers are retained.
- Preview validates mandatory fields, integer quantities, nonnegative prices,
  malformed/duplicate SKUs and barcodes, and duplicate style/variant combinations
  within the uploaded file. Preview shows valid-row quantities and estimated cost,
  plus per-row errors. Headers support the existing basic import's aliases.
- Product-image ZIP selector is visible for the future picture matcher.
  **Phase 1 does not upload, store, validate ZIP contents, or associate images.**
- Blank barcodes and SKUs are allowed for later automatic generation.
- No `POST` is used: the preview is **non-persistent**. Closing it does not create
  a purchase, stock receipt, inventory movement, supplier payable, journal, or labels.
- The old **Legacy Import** is preserved separately for existing workflows, but
  clearly warned: it sets **absolute quantities** and is not a supplier purchase.

### Phase 1 source files

- `client/src/pages/retail/retailSupplierImportDraft.ts` — normalized parse, limits,
  duplicate detection, field validation and pure summary.
- `client/src/pages/retail/RetailSupplierImportDialog.tsx` — template, company-scoped
  supplier and location fields, Excel/CSV file parsing and preview UI.
- `client/src/pages/retail/RetailInventory.tsx` — entry button and dialog integration.
- `client/src/pages/retail/RetailImportDialog.tsx` — legacy-import warning.

No CI, tests, merge, rebase, or deployment were run as part of this Phase 1 handoff.

## Phase 2 — product/variant matching and image ZIP preparation (implemented)

UI: `client/src/pages/retail/RetailSupplierImportDialog.tsx`

- Accept an optional image ZIP (up to 50 MB); safely inspect archive contents,
  reject traversal/ambiguous duplicate filenames, reject oversized images or
  ZIPs with excessive declared expanded image bytes. Allowed JPG, PNG, WEBP,
  GIF must match image content signatures. Match by case-insensitive image
  basename in Excel's Main Image / Extra Images columns. Reject missing and
  duplicate photo references; limit to 4 images per color/size variant.
- Display per-line image counts, thumbnails, and errors. Excel/ZIP remain
  in the browser only. No image uploads or persisted catalog changes yet.
- `POST /api/retail/supplier-import/catalog-preview` is **read only**,
  requires Retail company context, authentication, non-POS role, and normal
  import permission; it checks existing SKUs, barcodes, brand/style, and
  color/size and detects mismatches and duplicate rows. Existing barcodes are
  shown in the preview.
- `server/services/retail/retailSupplierCatalogPreview.ts` implements a
  pure catalog reconciler with a company-scoped DB snapshot.
- `server/services/retail/retailSupplierCatalogWrites.ts` provides a
  **transaction-only, currently uncalled** product/variant upsert helper.
  Future confirmed supplier receipt will call it only as part of the same
  transaction that receives stock and posts its payable. It preserves old
  barcodes/SKUs and non-empty product cover photos. If a new variant is needed,
  the resolved barcode must be supplied by Phase 3.
- Added `jszip` as an explicit production dependency, updated the lockfile,
  operation-permission registry, and route-manifest snapshot.
- Reusing an existing category means preserving its existing product category
  text; in the Retail schema categories are not a separate table. New products
  create their category label; brand creation uses the existing normalized
  brand service.

**Safe staging boundary:** The client still does not call an accounting-unsafe
stock importer. Phase 2 is wired for image and catalog reconciliation, but no
new retail product is committed from this wizard until Phase 4's atomic
supplier receipt. Image files will be uploaded to existing company file storage
and attached to catalog rows by the finalized purchase flow.

No CI, tests, merge, rebase, or deployment executed in this phase.

## Phase 3 — automatic barcode resolution (implemented)

The supplier-import dialog now shows **three barcode outcomes** for each
non-conflicting row: **reuse existing** (never change a stored variant barcode),
**keep supplier barcode**, or **generate EAN-13 on confirmation**. Catalog
conflicts have a separate blocked state rather than being described as eligible
for auto-generation.

- `server/services/retail/retailSupplierBarcodeIntake.ts` adds a side-effect-free
  intent helper for preview and `resolveRetailSupplierBarcodesTx` for the
  purchase transaction.
- `POST /api/retail/supplier-import/catalog-preview` includes `barcodePlans`
  with each Excel row's action, effective barcode when known, and a message.
  **Preview does not reserve a barcode or advance any sequence.**
- At confirmed purchase posting, `resolveRetailSupplierBarcodesTx` must be
  called **inside the purchase transaction**, and must re-read company-scoped
  catalog identities, reject conflicts, reserve all manually supplied barcodes,
  and call the existing `allocateRetailBarcodes` EAN-13 generator only for
  new variants lacking barcode values.
- The existing per-company allocator issues valid GS1 restricted-circulation
  EAN-13 barcodes (prefix 2 and check digit), reserves sequence blocks
  atomically, skips used barcodes, and checks against incoming manual codes.
- `server/services/retail/retailSupplierCatalogBatch.ts` joins those barcode
  assignments with the Phase 2 product/variant transaction-only upsert.
  It reuses existing variant identities and stored barcodes. The future
  Phase 4 supplier purchase route must call this batch writer inside the
  **same transaction** as receipt stock movements, inventory valuation,
  supplier payable, and idempotency.
- The existing barcode/variant IDs flow to POS scanner lookup, retail transfers,
  and later label printing. One variant = one barcode, with one physical
  printed label per received unit in Phase 5.
- Supplier template SKU/Barcode Excel columns are text formatted to retain
  leading zeros. Uploaded supplier barcodes are not silently converted.
- `tests/retail-supplier-import-barcodes.test.ts` adds barcode intent,
  EAN-13 formatting and range cases for later CI execution.

**Safe staging boundary:** This Phase 3 adds the barcode planner and atomic
assignment mechanism, not a standalone barcode issuance or purchase endpoint.
No products, barcode sequences, inventory, or supplier balances are modified
by preview. Final submission remains blocked until Phase 4 makes everything
part of one all-or-nothing supplier receipt.

No CI, tests, merge, rebase, or deployment executed as requested.

## Phase 4 — Confirmed supplier purchase and payable posting (implemented)

- Added `POST /api/retail/supplier-import/confirm` (Retail company only,
  authenticated, non-POS, operational import permission).
- The import dialog collects a required supplier invoice reference, date,
  location, and purchase currency. USD invoices need no FX. Non-USD requires
  an explicit positive rate entered as **USD per unit of foreign currency**;
  the client sends its reciprocal to the ERP accounting normalization layer,
  which stores transaction units per USD with the posted historic voucher.
  All voucher and supplier entry amounts retain transaction and base values.
- The client uploads validated company pictures via the existing Retail media
  service and reuses those uploaded URLs on an interrupted-request retry.
  **Pictures persist independently of the DB purchase transaction**;
  orphan-photo cleanup is deferred to Phase 6.
- `server/services/retail/retailSupplierPurchaseService.ts` validates the
  supplier and receiving location belong to the active company, picture IDs
  belong to the company, the invoice date is not future, and the inventory
  accounting opening has been applied.
- The service serializes purchase confirmation for one company via a database
  transaction advisory lock. Duplicate invoice number for the same supplier
  is refused (case-insensitive); duplicate request keys return their original
  saved result only if the payload fingerprint matches.
- Product/variant creation and final EAN-13 reservations reuse the Phase 2/3
  transaction-only catalog service. Stock is **received in addition to**
  existing quantities, with weighted-average inventory cost; append-only
  `retail_stock_movements` entries are written per Excel line. A durable
  `retail_stock_operations` batch stores purchase totals, supplier id, FX
  rate, voucher id, and received row/variant/barcode/quantity mapping.
- The same transaction uses the central balanced posting engine to book
  **Dr Retail inventory account / Cr ERP supplier** (supplier_id target).
  It never creates a second Retail supplier ledger or uses GRNI/Inventory
  Adjustment for this invoiced purchase. Supplier payments later continue
  through the standard ERP Payment voucher, debiting that exact supplier.
- If inventory value fails to reconcile with the invoice at 2 decimal places,
  confirmation is refused and the **entire DB transaction rolls back**;
  nothing is silently pushed to an adjustment/suspense account. Closed-period,
  ownership, audit, and voucher idempotency checks belong to the central engine.
- On success the dialog shows the voucher ID, received item count, and total
  payable, and refreshes catalog and supplier/accounting query caches.
  Phase 5 now opens a printable receipt-label popup using those saved quantities.
- Tests for schema, image references and request fingerprint are added for
  Claude to run. No CI, tests, merge, rebase, or deployment performed.

**Operational prerequisite:** Retail inventory accounting opening must be
applied for the company before the first supplier import, to avoid posting a
supplier purchase in the pre-opening inventory state. This is NOT a cash
opening. Existing POS sale accounting is not modified here.

## Phase 5 — Automatic label printing after purchase (implemented)

- Once `POST /api/retail/supplier-import/confirm` returns a committed receipt,
  `RetailSupplierImportDialog` opens the existing `RetailLabelPrintDialog`
  in `purpose="supplier-receipt"` mode. The background import dialog is
  hidden while printing and returns to the saved receipt summary when closed.
- `client/src/pages/retail/retailSupplierReceiptLabels.ts` builds print targets
  using only the **confirmed server response** `items[{rowNumber, variantId,
  barcode, quantity}]`. Source Excel names are display-only; lifetime
  warehouse stock, Excel quantity, and provisional preview barcodes cannot
  determine copies. Duplicate receipt rows for one variant combine quantities
  only if they reference the exact same barcode.
- Each received unit has one default label. Existing thermal **50×30 mm**,
  **58×40 mm**, and **A4/24-up** print options remain available. Users can
  include/exclude individual variants and print all remaining selected units
  through successive jobs of **at most 500 physical labels**, respecting
  `POST /api/retail/labels` maximum copy count without silently losing
  oversized receipt quantities.
- Printing always goes through existing company-scoped `POST /api/retail/labels`,
  which reloads each variant's **stored barcode**, retail selling price and
  identity; it logs a label print event and never issues a new barcode.
  Customer labels offer optional **selling price only**, never stock cost or
  supplier cost. Retail POS scanners can continue to use those saved barcodes.
- The customer can select all remaining, clear selections, skip printing,
  or return to the saved receipt summary and click **Print received labels**
  again. Reopening starts a new reprint selection from the original receipt.
  Receipt posting is never reversed by label dismissal or print failure.
- On multi-batch jobs, the UI tracks quantities **prepared** for the browser
  print dialog, not guaranteed physically printed. Browser/OS cancellation
  cannot be reliably detected; users may reopen the receipt to print again.
- Added `tests/retail-supplier-receipt-labels.test.ts` for committed quantity
  source, barcode reuse, per-job limits, selected subsets and duplicate rows.

No CI/tests, merge, rebase, deployment, or production accounting mutations
were performed. Claude should verify the UI/printing workflow, especially
500-label batches and physical thermal-printer page formatting.

## Phase 6 — Import history, partial deliveries and retry recovery (implemented)

- `server/services/retail/retailSupplierPurchaseHistory.ts` exposes read-only,
  **company-scoped** import history and single-receipt detail. Paginated list
  supports invoice-reference search and supplier filter. Receipt details include
  supplier, company location, voucher ID, original invoice/date/currency,
  posted base total, attachment, and exact saved lines, quantities, barcodes,
  prices and unit costs. A stock-movement reconciliation flag compares
  persisted receipt lines with actual linked stock movement rows. It does
  **not** create a second Retail stock, accounting, or supplier ledger.
- Protected routes in `server/routes/retailRoutes.ts`:
  `GET /api/retail/supplier-import/history`,
  `GET /api/retail/supplier-import/history/:id`, and
  `GET /api/retail/supplier-import/requests/:key`. All require authenticated
  Retail company context, a non-POS role, and the import-data operational
  permission policy. They provide no cross-company data access.
- `client/src/pages/retail/RetailSupplierImportHistory.tsx` adds searchable
  history, view receipt, company-authorized invoice file download and
  **exact-quantity label reprinting** based on saved receipt lines rather
  than present-day stock. The existing label API loads stored variant barcodes;
  receipt reprinting is blocked if movements do not reconcile or the
  current variant barcode differs from the barcode saved on the receipt.
- `retailSupplierPurchaseSchema` now supports `partialReceipt` with a
  required **unique deliveryReference** per supplier/invoice. Under a
  company-scoped advisory transaction lock, the confirmed purchase flow
  refuses reusing a delivery reference, mixing full and partial receipts
  under the same supplier invoice, or switching invoice currency mid-series.
  Every accepted delivery still receives only its own Excel units and posts
  its own exact supplier-targeted payable voucher and movement references;
  previous receipts are never overwritten. The UI can start the next
  delivery while preserving the supplier/invoice context.
- Optional supplier invoice PDF/JPG/PNG attachments are uploaded to the
  existing **company-owned file store**, linked by `invoiceFileId` to
  a confirmed receipt and accessible from history through the company's
  authenticated download route. Before confirmation, server validation
  checks company ownership, 10 MB maximum, MIME and file signature.
- A company switch resets supplier/invoice/date/currency and pending receipt
  context to prevent accidental cross-company reuse.
- A lost response or failed submission preserves the input and imported
  picture upload URLs in the browser. **Check whether receipt was posted**
  queries the same company and request key read-only; a saved receipt
  is recovered without repeating inventory, barcode or supplier accounting.
  A retry with the same unchanged request ID remains guarded by its persisted
  payload fingerprint; failures show a contextual message.
- Import preflight now offers **show only rows with errors** and
  **download all errors as CSV** (including Excel, picture and catalog errors),
  not just the first 100 preview lines. The exported CSV escapes
  supplier-controlled values so spreadsheet applications cannot evaluate
  product names as formulas.
- Added `tests/retail-supplier-import-phase6.test.ts` for partial delivery,
  invoice attachment, exact saved barcode/quantity and immutable fingerprint
  contracts, for Claude to execute during Phase 7.

**Known cleanup boundary:** The file upload API commits pictures/invoice files
separately before the stock/accounting DB transaction. If a purchase ultimately
fails, those uploads can be unreferenced; this phase intentionally does not
delete stored files automatically because an interrupted response cannot
prove that files are unreferenced. Claude's Phase 7 review must reconcile
unreferenced import uploads with the complete company media-reference graph
before implementing safe automatic cleanup.

No CI, tests, merge, rebase, deployment or database changes were run.

## Phase 7 — Final source-level integration and handoff (committed)

- Reconciled the supplier-import confirmation path with the existing Retail
  product/variant catalog, company-scoped EAN-13 allocation, POS scanner,
  Retail stock movement and weighted-average cost ledger, central ERP voucher
  posting, supplier balance and standard ERP Payment workflow.
- Removed the **Legacy Import** button from Retail Inventory, preventing casual
  bypass of supplier credit accounting. The legacy endpoint remains available
  for backward compatibility; review its access controls before deployment.
- Hardened confirmation: transaction valuation and historical accounting
  entries now use the exchange rate **rounded to the voucher schema's stored
  six decimal places**, avoiding disagreement between the persisted voucher
  rate and stock/accounting calculations. Out-of-range rates/totals fail.
- Aligned client import field limits with server validation; numeric Excel
  SKU/Barcode cells are rejected to prevent corruption of leading zeroes.
- Made Retail POS selling-price currency explicitly **USD**, separate from
  supplier invoice **Cost Price** currency. Receipt labels show USD for price.
- Validated company-owned invoice/media upload file signatures server-side
  using bounded database header reads instead of trusting the stored MIME.
- Added compact persisted supplier receipt list totals, avoiding fetching
  thousands of full lines when listing import history; full receipt detail
  retains immutable line metadata for reconciliation and reprinting.
- Added `tests/retail-supplier-import-final-integration.test.ts` for later
  Claude execution (barcode text safety, schema limits and media signatures).
- Prepared the integration checklist, current branch-drift precautions,
  remaining upload cleanup boundary and precise Claude validation instructions
  in `docs/retail-supplier-stock-import-phase7-handoff.md`.

**Status:** All seven phases have source changes committed to
`feature/retail-supplier-stock-import-20261024`. No CI, tests, merge, rebase,
deployment or production accounting mutations were performed. Claude must
verify and reconcile with concurrent main changes **before** release.

## Reference checklist and deferred checks

**Phase 2 reference checklist — Product and image import engine**

- Map product identity to existing Retail brand/style + color/size variant.
  Group by a stable SKU when supplied; resolve to existing company-scoped SKU/
  barcode before creating a variant. Reuse existing brand/category/location.
- Match filenames from the uploaded ZIP to Main Image / Extra Images. Validate
  extension, size, magic bytes and path traversal; apply image-count and company
  storage restrictions. Images are attached to the correct product or variant.
- Never create duplicate variants by skipping already-used identities.
- Respect the existing generated EAN-13 implementation, rather than inventing a
  separate barcode sequence. Only use stored barcodes; no silent regenerations.

**Phase 7 — Final integration and Claude review**

- Keep all phases on this same branch. Review navigation,
  Retail POS, transfer/scanner, accounting, cost valuations, multi-company
  isolation and source-level consistency. Let Claude run CI/tests later
  before PR merge/deployment as instructed.

### Why the legacy stock import must remain separate

The old bulk importer sets quantity **equal to** the spreadsheet value and
does not credit an ERP supplier. The new **Supplier Stock Import** uses a
separate confirmed purchase API that adds quantities and creates a balanced
supplier-targeted payable voucher in one transaction. The old importer is
no longer shown on the Retail Inventory screen; its legacy API is retained
for backwards compatibility and should be reviewed for deprecation
separately.
