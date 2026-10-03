# Retail Fashion Variants — Wave 1 Design

Date: 2026-10-03
Branch: `feature/retail-fashion-variants-wave1`

## Goal

Make Retail inventory model fashion stock correctly when the same product/style exists in different colors and sizes, while preserving all existing retail companies and POS behavior.

Wave 1 is the variant-foundation change. It does **not** implement automatic barcode sequencing or label printing; those remain the next barcode wave. Existing barcode lookup and scan-to-sell continue to work.

## Existing model

Retail already has:
- brands
- products with product-level images
- variants keyed primarily by size
- unique company barcode / SKU
- stock by variant + location
- POS barcode lookup and exact-variant stock deduction
- returns, transfers, adjustments, imports, and reporting

The current blocking constraint is `UNIQUE(product_id, size)`, which prevents one style from having (for example) Black/M and Beige/M.

## New variant contract

A retail product represents the style/model. A retail variant represents the sellable color/size combination.

### Product
- brand
- code / style code
- name
- category
- description
- product-level images
- active

### Variant
- color
- size
- barcode
- SKU
- variant images
- cost
- selling price
- low-stock threshold
- active
- stock by location

The natural uniqueness rule becomes:

`UNIQUE(product_id, color, size)`

Barcode and SKU uniqueness remain company-scoped exactly as today.

## Backward compatibility

Existing variants are migrated to color `Default`.

Database column:
- `color varchar(100) NOT NULL DEFAULT 'Default'`
- `image_urls jsonb NOT NULL DEFAULT '[]'`

The old `retail_product_variants_product_size_unique` index is removed and replaced by a product/color/size unique index.

Existing clients that do not send color (notably existing imports) are normalized to `Default` at the server/schema boundary so old data and old CSV files continue to load.

No existing barcode, variant id, product id, inventory quantity, sale item, return, transfer, or movement record is rewritten.

## Catalog and inventory behavior

Retail product reads return variant:
- `color`
- `size`
- `imageUrls`
- existing barcode/SKU/pricing/stock fields

Retail catalog:
- search includes color
- catalog facets include colors
- inventory can filter by color
- product detail shows Color and Size separately
- product cards/table can summarize available colors and sizes

Variant display image resolution:
1. first variant image when displaying an exact variant
2. first product image
3. existing placeholder

## Product editor

Each variant card gains:
- Color *
- Size *
- variant image upload/remove UI
- existing barcode, cost, selling price, threshold, stock fields

For new variants, color defaults to `Default` so non-fashion retail remains usable, but the field is editable and validated as non-empty.

Product-level images remain supported for style-level photography.

## POS behavior

POS item payloads and sale-history item payloads include `color` and variant `imageUrls`.

Search covers:
- product name/code
- brand
- SKU
- barcode
- color
- size

Visible exact-variant labels become:
`Brand · Color · Size`

Barcode scan behavior does not change: an existing unique barcode still resolves directly to one variant and the sale deducts that exact variant.

Returns, cancellations, transfers, and stock math remain variant-id based and therefore need no semantic change.

## Import behavior

Existing imports stay compatible.

The retail import row gains optional:
- `color` (defaults to `Default`)
- `variantImageUrl` (optional)

Existing `imageUrl` remains the product-level image.

Rows with the same product code, same color, and same size target the same variant. Same product code + same size + different color creates different variants.

## Reporting behavior

Reporting rows that identify a variant expose color where relevant (low stock, out of stock, slow moving, profit/product drilldowns).

Existing size reports remain size reports. Wave 1 does not add new color-ranking dashboards; it only prevents color from being lost and makes exact variant rows understandable.

## Error handling

- Empty color is rejected on new/updated variant writes.
- Duplicate product/color/size is rejected as a validation/conflict error.
- Company-scoped barcode and SKU uniqueness remain unchanged.
- Variant images use the existing file upload endpoint and existing allowed image MIME/size rules.
- Maximum variant images: 4.
- Product image maximum remains unchanged.

## Migration safety

Migration order:
1. add `color` with non-null default `Default`
2. add variant `image_urls` with empty-array default
3. drop product+size unique index
4. create product+color+size unique index
5. add an index useful for company/color filtering if query plans justify it

This order keeps every existing row valid throughout migration.

Rollback note: dropping color-aware uniqueness would be unsafe after users create same-size/different-color variants. Rollback must first consolidate or remove those duplicates; no destructive automatic rollback is provided.

## Test requirements

Tests must prove:
1. same product + same size + different colors is accepted
2. same product + same size + same color is rejected
3. omitted import color becomes `Default`
4. POS barcode lookup returns color and variant images
5. POS search matches color
6. catalog filtering by color works
7. legacy variants remain readable as `Default`
8. exact-variant sale/return/transfer behavior still uses variant id and remains unchanged
9. TypeScript build/typecheck passes
10. relevant retail test suites pass

## Files expected to change

Primary:
- `shared/schema/retail.ts`
- new migration in `migrations/`
- `server/routes/retailCatalogRoutes.ts`
- `server/routes/pos/retailPosRoutes.ts`
- retail import route/service files
- retail reporting service/routes where variant display fields are selected
- `client/src/pages/retail/retailInventoryTypes.ts`
- `client/src/pages/retail/RetailProductEditor.tsx`
- `client/src/pages/retail/RetailInventory.tsx`
- `client/src/pages/pos/RetailPOS.tsx`
- existing retail tests plus focused Wave 1 regression tests

## Explicitly deferred

Not part of Wave 1:
- automatic retail barcode number generation
- barcode label printing / thermal label layouts
- bulk receiving workflow
- color sales ranking widgets
- per-physical-unit serialisation when quantity > 1

Those build on this variant foundation in later waves.
