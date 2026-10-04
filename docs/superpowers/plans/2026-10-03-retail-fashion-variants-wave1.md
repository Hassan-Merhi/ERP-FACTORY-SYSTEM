# Retail Fashion Variants Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Track steps with checkboxes.

**Goal:** Make Retail variants color+size aware, add variant images, and preserve all existing retail data and exact-variant POS stock behavior.

**Architecture:** Keep the current product → variant → location-stock model. Extend variants with `color` and `imageUrls`, change uniqueness to product+color+size, and thread those fields through catalog, import, POS, reporting, and client UIs.

**Tech Stack:** TypeScript, React, Express, Drizzle/PostgreSQL, Zod, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-03-retail-fashion-variants-wave1-design.md`

## Global Constraints

- Legacy variants read as color `Default`.
- Existing IDs, barcodes, stock, sales, returns, transfers, and movements are not rewritten.
- Barcode/SKU uniqueness remains company-scoped.
- Variant images use the current upload endpoint; max 4.
- Existing imports with no color remain valid and default to `Default`.
- Automatic barcode generation/printing is deferred.
- Stock mutations remain variant-id based.

## Review Focus

- Omitted color must stay backward compatible.
- Color matching must normalize case/whitespace for duplicate validation.
- Edit flows must support same size across different colors.
- Variant images must fall back to product images.
- Sale/return/transfer/cancel math must be unchanged.

### Task 1: Schema and migration

**Files:** `shared/schema/retail.ts`, new `migrations/20261003_001_retail_fashion_variants.sql`, retail Wave 1 tests.

**Produces:** variant `color: string`, `imageUrls: string[]`; uniqueness on product+color+size; optional import color and variantImageUrl.

- [ ] Write failing tests proving color/images/defaults/limits and migration index changes.
- [ ] Run focused backend tests; expect failures because the fields do not exist.
- [ ] Add `color varchar(100) NOT NULL DEFAULT 'Default'` and variant `image_urls jsonb NOT NULL DEFAULT '[]'`.
- [ ] Drop product+size unique index; create product+color+size unique index.
- [ ] Extend Zod schemas: omitted color → `Default`, non-empty normalized color, max 4 variant image URLs, import `variantImageUrl`.
- [ ] Re-run focused tests; expect pass.
- [ ] Run `npm run verify:migrations`; expect pass.
- [ ] Commit: `feat(retail): add fashion color variant schema`.

### Task 2: Catalog, product writes, and import

**Files:** `server/routes/retailRoutes.ts`, `server/routes/retailCatalogRoutes.ts`, retail import path, retail tests.

**Produces:** color/image variant API fields, `availableColors`, color facet/filter, color-aware import matching.

- [ ] Write failing tests: same size/different colors accepted; same normalized color+size rejected; reads return color/images; color filter/search/facets work; omitted import color becomes Default.
- [ ] Run focused tests; expect failures on old duplicate-size and missing color behavior.
- [ ] Change duplicate validation key from size to normalized color+size.
- [ ] Persist/read/sort color and variant images on create/edit/load.
- [ ] Add `availableColors`, catalog color search/filter/facet.
- [ ] Change import matching/grouping to product+color+size; keep product image and map variantImageUrl to variant images.
- [ ] Re-run focused tests; expect pass.
- [ ] Commit: `feat(retail): make catalog color aware`.

### Task 3: POS and reporting payloads

**Files:** `server/routes/pos/retailPosRoutes.ts`, `server/services/retail/retailReporting.ts`, dashboard exact-variant display if needed, POS/reporting tests.

**Produces:** POS barcode/search/history payloads with color and exact-variant images; reporting rows with color.

- [ ] Write failing tests for barcode color/images, POS color search, product-image fallback, sale-history color, and reporting color.
- [ ] Run retail POS/reporting tests; stock-invariant tests should remain green while new assertions fail.
- [ ] Select color and variant images in POS queries; add color search; return variant images when present otherwise product images.
- [ ] Include color in sale-history and exact-variant reporting rows.
- [ ] Do not change sale/return/transfer/cancel mutation semantics.
- [ ] Re-run retail POS/reporting tests; expect pass.
- [ ] Commit: `feat(retail): expose color in pos and reporting`.

### Task 4: Inventory and product editor UI

**Files:** `client/src/pages/retail/retailInventoryTypes.ts`, `RetailProductEditor.tsx`, `RetailInventory.tsx`, focused frontend tests.

**Produces:** editable color, variant images, color inventory filter/display.

- [ ] Write failing frontend tests/contracts: blank color defaults to Default; edits preserve color/images; save payload includes both; separate Color/Size fields; max 4 variant images; inventory color filter/display.
- [ ] Run focused frontend tests; expect fail.
- [ ] Extend client types/draft helpers with color, variant images, availableColors, facet colors.
- [ ] Add Color field and up-to-4 variant image upload/remove controls using existing upload endpoint/rules.
- [ ] Keep product images unchanged; update validation wording to variants.
- [ ] Add inventory color filter/query and color column/display.
- [ ] Re-run focused frontend tests; expect pass.
- [ ] Commit: `feat(retail): add color and variant images to inventory ui`.

### Task 5: POS UI and full verification

**Files:** `client/src/pages/pos/RetailPOS.tsx`, relevant retail UI tests.

**Produces:** visible exact variant labels as Brand · Color · Size.

- [ ] Write failing UI tests/contracts for search card, scan toast, cart, sale history, and transfer selector showing color+size.
- [ ] Run focused tests; expect fail.
- [ ] Thread color through Retail POS types and all exact-variant labels. Preserve scanner behavior.
- [ ] Run backend retail suites: Wave 1, Wave 2 POS integration/transactions, Wave 3 reporting; expect pass.
- [ ] Run focused frontend retail tests; expect pass.
- [ ] Run `npm run check`, `npm run verify:migrations`, and `npm run format:check:changed`; expect exit 0.
- [ ] Run `npm test`; expect exit 0. Report any unrelated pre-existing failure by exact test name.
- [ ] Run `npm run build`; expect exit 0.
- [ ] Perform whole-branch review against spec/plan; fix all Critical/Important findings with RED→GREEN tests.
- [ ] Commit final fixes if needed: `fix(retail): close wave 1 review findings`.

## Completion Criteria

Wave 1 is complete only when same-size/different-color variants work, legacy rows remain compatible, color/images flow through API/UI/POS/reporting/import, barcode scan-to-sell still deducts the exact variant, migrations/typecheck/tests/build pass, and no Critical/Important review finding remains.
