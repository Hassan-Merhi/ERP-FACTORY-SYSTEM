# Retail / Variant Inventory — Wave 1

## Scope delivered

- New `retail` company type with dedicated `/retail` workspace.
- Company-scoped retail brands with `Other / No Brand` fallback.
- Parent products with item code, name, category, description, and multiple image URLs.
- Size variants with unique company barcode, optional SKU, cost, selling price, and low-stock threshold.
- Independent stock balances per variant and location.
- Add/Edit Product UI and product detail stock-by-size view.
- Retail inventory list with image, product, brand, sizes, quantity, and selling-price range.
- Search plus brand, size, category, location, low-stock, out-of-stock, and in-stock filters.
- Excel import for `Code | Name | Brand | Size | Barcode | Cost | Price | Qty | Location` with optional category, description, and image URL.
- Import groups rows sharing the same Code into a parent product and creates/updates size variants.
- Duplicate barcode, product-code, product-size, tenant-location, and repeated location validation.
- Versioned PostgreSQL migration and regression/contract tests.

## Compatibility boundary

Retail data is stored in dedicated `retail_*` tables. Existing `stock_items`, factory inventory, ERP inventory, costing, transfer, voucher, and POS tables are not migrated or repurposed by Wave 1.

## Image performance

Inventory rows render only the primary product image and use native lazy loading plus asynchronous image decoding. Additional images are loaded lazily on the product detail view.

## API surface

- `GET /api/retail/brands`
- `POST /api/retail/brands`
- `GET /api/retail/products`
- `GET /api/retail/products/:id`
- `POST /api/retail/products`
- `PATCH /api/retail/products/:id`
- `GET /api/retail/barcodes/:barcode`
- `POST /api/retail/import`

All routes use the authenticated session company and reject use outside a `retail` company.
