# Retail Wave 2 — Implementation Plan

Spec: `docs/superpowers/specs/2026-10-05-retail-wave2-customers-pricing-tax-stock-count-design.md`

## Global constraints

- Walk-in checkout, no-discount checkout and tax-disabled pricing behave exactly as in Wave 1.
- `unit_price` remains the per-unit pre-tax amount actually charged; `original_unit_price` is never
  overwritten and returns refund `gross_unit_price` (actual amount paid).
- Every retail endpoint is company-scoped and requires a retail company session.
- Tax is disabled by default; nothing charges tax unless a company enables it.
- Stock counts never write inventory without a movement, and every movement references its session.
- Finalization is atomic and idempotent; POS sales during an open count do not corrupt
  reconciliation.
- New UI strings get EN/AR/FR entries in `client/src/i18n/retailWave2Translations.ts` (already
  registered in `ApplicationInterfaceTranslator.tsx`); no new translation module is needed.
- Follow repo conventions: schema in `shared/schema`, migrations mirrored in
  `server/startup/ensureRuntimeSchema.ts` (production runs the guard, not `migrations/*.sql`),
  routes registered in `server/routes/stockRoutes.ts` / `server/routes/pos/index.ts`, tests under
  `tests/` (DB-backed) and co-located pure unit tests.

## Tasks

### 1. Schema, migrations, startup guard  ✅/🔄

- [x] Sale/item/return columns for customer, discount, tax, promotion and refund basis.
- [x] `retail_pos_settings`, `retail_promotions`, `retail_discount_approvals`.
- [x] `retail_stock_count_sessions` / `_lines` / `_events`, `stock_count` movement type.
- [x] Verify `ensureRuntimeSchema` mirrors every column/table and passes the runtime-schema test
      (`tests/retail-wave2-contract.test.ts`, DescribeWithDatabase guard section).

### 2. Pure services

- [x] `retailPricing.ts` — pricing math (line/order discounts, override, promotion, tax,
      allocation, rounding) + unit tests.
- [x] `retailSettings.ts` — load/default/validate/save selling settings.
- [x] `retailPromotions.ts` — validate, match, best promotion per line, CRUD.
- [x] `retailDiscountApproval.ts` — policy, HMAC token, fingerprint, cover checks + unit tests.
- [x] `retailStockCountMath.ts` — line status, scan/set, summary, finalize delta + unit tests.
- [x] `retailStockCount.ts` — session lifecycle service.

### 3. Sale/return service integration

- [x] `createRetailSaleInTx` prices the cart, snapshots the ladder, stores customer/approval,
      consumes approvals, writes stock movements.
- [x] `createRetailReturnInTx` refunds `gross_unit_price`, records refund totals.
- [x] `loadSaleResponse` returns the full breakdown + customer + per-line discounts.
- [x] `retailReporting.ts` reports tax collected / discounts given / customer counts.

### 4. Routes

- [x] Checkout + returns accept the Wave 2 fields; approval policy enforced with 428/409.
- [x] `POST /api/pos/retail/cart-preview` — server-side ladder + approval policy for the POS.
- [x] Retail customer search/quick create/history + historic sale search.
- [x] Settings + promotions + discount-approval endpoints.
- [x] Stock-count session lifecycle + variance report endpoints.
- [x] Register everything; verify route ordering and capability middleware.

### 5. PostgreSQL integration tests

- [x] `tests/retail-wave2-customers-pricing-tax.test.ts` — customer quick create/search/history,
      walk-in default, line/order discounts, override, approval required/approved/reused, tax
      exclusive + inclusive, tax-disabled parity, refund of discounted amount.
- [x] `tests/retail-wave2-stock-count.test.ts` — snapshot/scan/unexpected/manual/recount/review/
      finalize, movement references session, idempotent finalize, POS sale during count, uncounted
      guard, variance report. 3 passed.

### 6. Client UI

- [x] POS: customer picker + quick create, line discount/override dialog, order discount, totals
      ladder (server-priced), manager approval dialog, receipt with customer + breakdown.
- [x] Retail: stock-count screen (create/scan/table/review/recount/finalize/history+variance),
      settings screen (tax, discount limits, promotions CRUD), sales/customer history screen.
- [x] Nav, routes, lazy imports, EN/AR/FR translations (`retailWave2Translations.ts`, +107 strings).
- Type-check: `node --max-old-space-size=3072 node_modules/.bin/tsc -p tsconfig.w2client.json`.

### 7. Contract tests + verification

- [x] `tests/retail-wave2-contract.test.ts` — schema fields, route registration, service wiring,
      UI markers, translations, plus the runtime-schema guard (13 passed).
- [ ] Run retail suites, `npm run verify:migrations`, formatting.
- [ ] Wider regression pass over suites touching shared files.
- [ ] Branch, commit, push, PR.

`npm run check` OOMs in this sandbox (3.9 GB RAM); the equivalent repo-local configs are
`tsconfig.w2.json` (server + shared) and `tsconfig.w2client.json` (Wave 2 client screens).
