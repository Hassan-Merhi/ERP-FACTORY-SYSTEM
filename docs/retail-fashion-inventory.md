# Retail fashion inventory: intake, barcodes, scan-to-sell and stock movements

This is the operating reference for Retail / Variant Inventory companies (Waves 1–8 of
the retail fashion program). It describes the item model, the screens staff use, the
API behind them and the guarantees the system keeps.

## Item model

- **Style (product)** = brand + style/model name, e.g. `Zara · Wide Leg Trouser`.
- **Variant** = one exact color + size of a style, e.g. `Black / M`. Each variant owns
  its barcode, SKU, up to 4 photos, cost, selling price, low-stock threshold and stock
  per location. Different colors or sizes are never collapsed into one stock row.
- Legacy variants created before color existed carry the color `Default`.
- Several identical units share one variant: one barcode, quantity `n`. A one-off
  piece is simply a variant with quantity `1`.

## Screens (all under the retail workspace navigation)

| Screen | Path | Purpose |
| --- | --- | --- |
| Inventory | `/retail/inventory` | Brand → style → exact color / size rows with photo, stock badge and quick actions (print/reprint label, transfer, adjust, history, archive). Bulk-select variants to print many labels. |
| Quick add | `/retail/quick-add` | Phone-first intake: brand, style, location, then one card per color/size with camera capture or upload, quantity (default 1), price, cost, SKU and optional supplier barcode. Saving shows the new barcodes with *Print labels*. |
| Stock operations | `/retail/stock` | Scan a label to receive (optionally one unit per scan), transfer between locations, or adjust with a required reason; shows the variant's movement history. |
| Retail POS | `/retail/pos` | Scan-to-sell with persistent scan focus, repeat scans increase quantity, receipts, returns, exchanges and cancellations. |
| Reports | `/retail/reports` | Dashboard plus stock-by-variant and sales-by-variant reports with CSV export. |

## Barcodes and labels

- A variant saved without a barcode receives a generated **EAN-13 in the GS1
  restricted-circulation range (leading `2`)** from a per-company sequence
  (`retail_barcode_sequences`). Generated values skip any barcode already used in the
  company. `barcode_source` records `generated`, `manual` (typed/scanned supplier code)
  or `import`.
- Barcodes are unique per company and are never regenerated. Leaving the barcode blank
  when editing an existing variant keeps its barcode; changing it requires an explicit
  unlock in the editor because printed labels would stop scanning.
- Labels (`POST /api/retail/labels`) always print the stored barcode, so a reprint has
  the same identity. Every print is audited in `retail_label_print_events` with copies,
  layout, reprint flag and user (`GET /api/retail/variants/:id/labels`).
- Layouts: thermal 50 × 30 mm and 58 × 40 mm (one label per page) and A4 24-up
  (70 × 37 mm). Labels show brand, style, color · size, a Code 128 barcode, the
  human-readable digits and optionally the selling price. The barcode image comes from
  the existing `/api/barcode/:code` renderer and is stretched to the label width with a
  quiet zone from the label padding. Printing uses the browser print dialog.
- Verified: the printed 50 × 30 mm PDF rasterised at 203 dpi decodes back to the exact
  variant barcode, and that barcode resolves to the exact variant in the POS lookup.

## Scan-to-sell

- `GET /api/pos/retail/barcodes/:barcode?locationId=` answers `404 BARCODE_NOT_FOUND`,
  `409 ITEM_INACTIVE` (archived; item details included) or the variant with its stock at
  the selling location and `otherLocations` holding stock. An exact match is tried first,
  then a case-insensitive match.
- The POS refuses to add more units than the location holds for users who cannot sell
  into negative stock (POS role and roles without the permission); Admin/Owner/Manager
  follow the existing negative-stock rule and see a warning instead.
- Checkout (`POST /api/pos/retail/sales`) locks each variant/location stock row,
  deducts atomically, snapshots `unit_cost` for profit reporting and is idempotent on its
  key; a replay returns `200 { replayed: true }` without deducting twice.
- Returns restore the exact variant at the sale location. Exchanges
  (`POST /api/pos/retail/exchanges`) return items on the original sale and record the
  replacement as a new sale in one transaction; neither sale is rewritten.

## Stock movements

Every stock change writes an append-only `retail_stock_movements` row with variant,
location, quantity before / change / after, user, timestamp, reference and reason:

| Operation | Endpoint | Movement type |
| --- | --- | --- |
| Quick add intake | `POST /api/retail/quick-add` | `receive` |
| Receive / restock | `POST /api/pos/retail/receipts` (updates weighted average cost) | `receive` |
| Transfer | `POST /api/pos/retail/transfers` | `transfer_out` + `transfer_in` |
| Adjustment (reason required, negative-stock rule applies) | `POST /api/pos/retail/adjustments` | `adjustment` |
| Sale / return / cancel | POS endpoints | `sale` / `return` / `cancellation` |
| Product editor stock edit | `PATCH /api/retail/products/:id` | `adjustment` |

Product edits send the quantity the editor loaded (`expectedQuantity`); if POS activity
changed the stock meanwhile the edit is rejected with `409` instead of overwriting it.
`GET /api/retail/variants/:id/movements` returns the full history for one variant, and
`GET /api/retail/reporting/audit` reconciles inventory against movement history.

## Archiving

`PATCH /api/retail/variants/:id/active` and `PATCH /api/retail/products/:id/active`
hide an item from selling and browsing. Nothing is deleted: barcodes, sales lines,
returns, movements and label history remain, and restoring makes the item sellable again.

## Reports

`GET /api/retail/reporting/stock` and `GET /api/retail/reporting/variant-sales` filter
by brand, style/barcode/SKU search, color, size and location; the stock report also
filters in / low / out of stock and slow-moving. Add `format=csv` for a spreadsheet.
Sales are net of returns and include cost of goods and profit.

## Payments, cashier shifts and accounting

Retail checkout records payment rows independently from stock movements. A sale can use
cash, card, bank/transfer, mobile/other, or a split across several methods. Cash captures
the amount tendered and change while the applied payment amount remains equal to the sale
total. Payment inserts use the sale idempotency key, so a checkout retry cannot collect
twice.

Retail reuses the existing POS shift table. POS cashiers can open a shift only at an
assigned location. Retail shift summaries combine opening cash, cash sales, cash refunds
and audited cash-in/cash-out movements. Closing stores expected cash, actual closing cash
and variance. Non-cash methods are reported separately and do not inflate drawer cash.

Every new Retail sale posts one idempotent balanced journal through the central accounting
engine:

- debit the payment settlement account(s), credit Retail Sales Revenue;
- debit Retail COGS, credit Retail Inventory Asset using the sale-line cost snapshot.

Returns, exchanges and cancellations refund against the original payment methods and post
the corresponding revenue/COGS/inventory reversals without rewriting the original journal.
Sales created before Wave 1 remain refundable: the first refund materializes their
historical sale total as a legacy cash payment, while reconciliation continues to flag
missing historical accounting rather than fabricating a historical journal.

`/retail/reports` includes company/location accounting mapping and a financial
reconciliation panel. Location mappings inherit the company default until explicitly
overridden.
## Permissions and company isolation

All retail endpoints require a Retail company in the session and scope every query by
company. POS-role users can scan, sell, return and exchange at their assigned location;
intake, labels, receiving, transfers, adjustments, archiving and reports require a
non-POS role.

## Deployment

Apply the versioned migrations `migrations/20261003_001_retail_fashion_variants.sql`,
`migrations/20261004_001_retail_fashion_barcodes_labels.sql`, and
`migrations/20261005_001_retail_financial_core.sql` (all idempotent) with the explicit
versioned-migration runner before deploying the application code. The always-on runtime
schema guard also ensures the additive Retail financial tables because production can
disable the bulk migration pass.
