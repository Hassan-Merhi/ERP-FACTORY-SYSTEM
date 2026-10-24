# Retail POS & Inventory Workflow — Claude Handoff (Phases 1–8)

**Branch:** `feature/retail-pos-inventory-workflow`
**Target:** `main` — do not merge without verification and owner approval.
**Status:** Implemented by ChatGPT (phases 1–8), then verified and repaired by
Claude on 2026-10-23 — see **Verification record** below. Not merged or deployed.

## Objective and boundaries

The Retail company type must use normal ERP-style POS layout while keeping the
Retail barcode/color/size variant and financial posting engine. Retail Inventory
uses one cover image per product, with full interactive galleries. Retail
navigation hides Reports, Stock Count, Retail POS and Sales History as redundant
inventory tabs; sales remain discoverable through the existing Sales Report.
Manual Journal, Credit Note, Adjustment and Transfer Order voucher entry options
are hidden for Retail and protected in generic voucher HTTP creation/edit paths.
Automatic financial journals/stock accounting and read-only Daybook vouchers
remain available. Legacy normal ERP, Factory, Properties and Supplier Partner
behavior must remain unchanged.

### Implementation by phase

1. **Navigation/layout:** `RetailNav.tsx`, `RetailInventory.tsx`,
   `PosWorkspaceColumns.tsx`, `POS.tsx`, `RetailPOS.tsx`.
2. **Photos:** `RetailProductImage.tsx`, `RetailCatalogList.tsx`,
   `RetailProductEditor.tsx`, `RetailInventory.tsx`.
   Includes keyboard-accessible gallery/zoom, exact-variant previews,
   cover-photo reordering and image URL normalization.
3. **ERP-style Retail POS:** `RetailErpPosWorkspace.tsx`, `RetailPOS.tsx`.
   Left exact-variant sale grid, right photo-enabled scanner/sidebar, header,
   payment/customer controls, discounts, notes; server variant APIs retained.
4. **Credit and customer balances:** `RetailPaymentPanel.tsx`,
   `RetailCustomerPicker.tsx`, `retailFinancialService.ts`,
   `retailSaleService.ts`, `retailPosRoutes.ts`,
   `retailCustomerRoutes.ts`, `retailReceipt.tsx`, `retailPosTypes.ts`,
   `shared/schema/retailPos.ts`.
   Credit is the unpaid portion Dr customer. Other methods Dr actual cash/
   bank/clearing. The full sale amount still posts Cr sales/tax.
5. **Returns/exchange:** `RetailReturnDialog.tsx`,
   `RetailExchangeDialog.tsx`, `retailSaleService.ts`,
   `retailFinancialService.ts`, `retailPosRoutes.ts`,
   `retailStockOpsRoutes.ts`, `retailReporting.ts`,
   `retailVariantReports.ts`, `retailReceipt.tsx`.
   Receipt lookup, exact partial quantities, historical price/tax/COGS,
   original-tender vs ERP customer-account credit, manager-gated damaged
   no-restock, atomic exchange, audit trails.
6. **Retail voucher UI:** `retailVoucherPolicy.ts`, `Vouchers.tsx`,
   `VoucherEdit.tsx`, `VoucherEditDialog.tsx`,
   `StockTransferOrder.tsx`, command palette/sidebar/routes.
   Source-only Phase 8 adds `retailManualVoucherBoundary.ts` before generic
   voucher handlers in `voucherRoutes.ts` for Retail-only HTTP safeguards.
7. **Transfers:** `RetailStockOperations.tsx`,
   `retailTransferWorkflowRoutes.ts`, `server/routes/pos/index.ts`,
   `retailStockOpsRoutes.ts`, `retailInventoryJournal.ts`,
   `systemAccounts.ts`, `RetailPOSPanels.tsx`.
   Immediate exact-variant transfer OR dispatch→OTW→receipt, photo selection,
   immutable source costing, transfer asset and idempotent receipt.
8. **Integration hardening:** Split tender now works with an initially fully
   allocated default payment; return idempotency rejects reuse for changed
   sale/items/restock; dispatch retry rejects changed variants, quantities,
   locations or notes; generic manual-voucher HTTP creation/edit is guarded.
   See final checklist below for runtime validation still required.

### Database changes

- **Additive migration only:** `migrations/20261023_001_retail_return_disposition.sql`.
  Adds `retail_pos_return_items.restocked BOOLEAN NOT NULL DEFAULT true`,
  preserving the interpretation of historical returns. The always-running
  retail financial schema guard also adds this column idempotently.
- No new table is needed for deferred transfers; the existing
  `retail_stock_operations` JSONB metadata holds status/variant/locations/cost,
  with `retail_stock_movements` for one dispatch and one receipt audit leg.
- `RETAIL-IN-TRANSIT` is an **Asset** account in the existing system-account
  registry; it is resolved by the Retail stock posting helper *after* the
  company's stock opening. It is never manually created by this branch.
- Do not edit historical customer balances, Retail vouchers, inventory rows,
  company settings, bank accounts or production data as part of integration.
  Use an isolated test database for any migration and financial tests.

## Mandatory Claude verification checklist

### 0 — First actions

- Fetch this branch and compare with current `main` before touching source.
  There was an outstanding six-commit divergence when Phase 8 was written.
  Resolve conflicts conservatively and keep the same branch.
- Run the project's appropriate typecheck, lint, focused test suites and CI
  **only under Claude ownership**, as agreed with the user. Do not deploy or
  merge unless explicitly instructed and the gate is green.
- Review the incremental source diffs before changing any database schema,
  balance logic or journals. Look for unused imports/TSX conflicts/React
  hook dependency and accessibility errors.

### 1 — Retail navigation & images

- Inventory navigation contains ONLY Inventory, Quick Add, Stock Operations,
  Selling Settings; no redundant tabs.
- Cover photo opens gallery; arrow keys, escape, focus return, filmstrip,
  zoom, narrow phones and dozens of photos work correctly.
- Set-main saves cover order; exact variant images do not mix colors/sizes,
  generic style photos appear as fallback.
- Broken/empty images remain graceful and never add a sale/variant to cart.

### 2 — POS, pricing, payments, approvals

- Retail POS resembles normal ERP POS; normal ERP POS unchanged.
- Scanner Enter, global hardware scanning, input focus and invalid barcode
  feedback; exact SKU/color/size is preserved.
- Verify item grid price/rate/amount against server cart preview with
  promotions, line discounts, order discounts, tax and overrides.
- **Phase 8 fix:** On a $100 default cash tender, pressing Split should create
  two positive tenders whose sum is $100 (not a zero-value second tender).
  Rebalance to $60 cash + $40 credit, with customer selected; no misleading
  "Paid $100" when only $60 was collected.
- Check all supported tender methods, cash change and original payment refs;
  changing cart price does not reset selected method or silently corrupt split.
- Credit requires existing active customer and posts to ERP party receivable,
  not to a phantom cash account or duplicated customer balance cache.
- Confirm managers can approve/deny discounts without unintended submission,
  duplicate idempotency token or stale approval state.
- Full and partial credit receipt displays reflect paid vs on-account portions.

### 3 — Returns, refund allocations, exchanges

- Search receipts, product names and numeric/non-numeric variant barcodes.
- Return one/multiple sale lines; enforce unreturned quantity, correct
  historical price/promotion/discount/tax snapshots and same location/company.
- $100 sale: $60 cash + $40 credit. A $30 return should clear up to $30
  receivable and pay no cash. A subsequent $30 return should clear $10 more
  receivable and refund only the $20 actually collected.
- Test customer-account credit on a fully paid sale vs original-tender refund.
  Debit and credit to a real ERP customer must reconcile to posting engine.
- Damaged/non-restock return: no stock quantity/average-cost increase,
  no original COGS reversal, but refund revenue/tax and a zero-delta audit
  movement with `returnedQuantity`. Verify reports and reconciliation.
- Exchange: original sale return + replacement sale are one transaction;
  replacement price comes from authoritative server preview; original
  customer and credit terms are retained correctly.
- Closed shifts, user/manager role gates, two simultaneous returns, receipt
  replay, changed-payload replay, changed customer on posted credit sale,
  retry after network timeout and cancellation of part-returned sales.

### 4 — Voucher access protection

- Retail excludes manual Journal, Credit Note/Adjustment, Transfer Order tabs
  from desktop/mobile and stale query links; Payment, Receipt and Stock
  Transfer remain available where previously permitted.
- Read-only Daybook/voucher detail can show automatic Retail journals.
- **Phase 8 guard:** POST /api/vouchers/journal and generic manual Journal
  create/edit/deletes are forbidden for Retail; other company types unaffected.
- Confirm Retail automatic sale/refund/credit/stock postings bypass HTTP
  manual-voucher guard, and authorization does not shadow valid ERP routes.
- Check any **other** manual voucher endpoints outside `/api/vouchers/*`
  separately; this guard is narrow and is NOT a blanket permission audit.

### 5 — Transfers, costing, inventory valuation

- From-location selector, exact photo item picker, destination and positive
  quantity. Source stock may not go negative for a dispatch.
- Immediate flow posts one source-out + destination-in, with no income/COGS.
- Dispatch creates source-out and an in-transit balance, NOT sellable
  destination stock. Receipt later moves the *same* variant and source cost
  into destination stock, without duplicate receipt.
- Retry same dispatch payload returns same operation. Retry with changed
  barcode, location, quantity or note must NOT succeed as old dispatch.
- Two users confirming receipt simultaneously must result in one receipt.
- Confirm balanced Retail inventory/in-transit journals and compare both
  stock sub-ledger + ERP ledgers before dispatch, OTW and after receipt.
- Validate value rounding on locations with different average costs and
  account mapping. Initial stock opening must refuse while OTW exists.
- Verify restrictions for Retail selected-company, employee assigned
  locations, global POS/Manager/Admin roles, and inactive locations.
  **Per-location permission enforcement is an open security concern:**
  `requireNonPOS` is not a substitute for every user/location assignment.

### 6 — Cross-module regression

- Normal ERP POS, Supplier Partner, Factory production/containers, Properties,
  conventional ERP voucher flows and other companies remain unchanged.
- Sales Report includes Retail sales and refund history correctly; avoid
  duplicate or mismatched new Retail-side report modules.
- Verify daily Daybook balances, COGS, taxes, cash drawers, customer statements,
  payment sources and valuation under the selected company.

## Verification record (Claude, 2026-10-23)

Isolated environment only: a local PostgreSQL 16 database built with
`drizzle-kit push` plus the application's startup migrations. No production
database, Render service, voucher, balance or stock row was touched.

### Branch reconciliation

`main` was merged into the branch twice (no conflicts): the six commits it was
behind, then the later Puppeteer 25.14.0 `allowScripts` approval that every CI
`npm ci` step needs.

### Defects found and fixed

| Area | Defect | Fix |
|---|---|---|
| Build | Branch did not compile: unclosed JSX in the exchange dialog, unclosed Split `onClick`, duplicate-key spread in the return dialog | Repaired |
| Phase 4 POS | After a credit/split sale tenders were not reset; the next sale stayed on a credit tender with no customer | Tenders reset on success; clearing the customer turns credit back into cash |
| Phase 5 exchange | Counter balance assumed the return was paid back in cash; on a credit original the screen said "even exchange" while the replacement was booked as cash received (drawer short) | Server reports `receivableReversed`, `tenderRefund` and `balanceDue` = replacement money collected − tender paid back; dialog shows the same breakdown |
| Phase 5 shifts | New hard rule "POS cashier needs an open shift to refund" broke the established, tested shiftless-refund contract (sales never required a shift) | Restored; refunds without a shift stay off every drawer |
| Phase 5 receipts | A completed return was not offered for reprint | Return becomes the last sale |
| Phase 6 API | Guard only covered `/api/vouchers/*`; manual Credit Notes (`/api/credit-notes`), Stock Adjustments (`/api/stock-adjustments`), voucher-entry edits and bulk delete were open | Guard extended and registered with the permission boundaries ahead of every writer |
| Phase 7 | Receipt required the *source* location to be active, stranding goods in RETAIL-IN-TRANSIT if the source closed | Only the destination must be active |
| CI ratchets | Unformatted files, two files over the 900-line cap, stale route manifest, unindexed docs, +3 literal source-text assertions | Formatted; logic split into `useRetailBarcodeScanner` / `retailCheckoutPolicy`; manifest regenerated; docs indexed; literal checks replaced by behavioural tests |

### Accounting reconciliation (`tests/retail-pos-inventory-workflow-integration.test.ts`)

Every assertion reads the posted vouchers:

- **Credit split sale** $100 = $60 cash + $40 credit → Dr RETAIL-CASH 60, Dr customer 40,
  Cr RETAIL-SALES 100, Dr COGS 36 / Cr RETAIL-INVENTORY 36; customer balance 40.
- **Credit-first returns** first $30 → one `credit` refund of 30, no cash, balance 10;
  second $30 → `credit` 10 + `cash` 20, balance 0; voucher Dr sales 30, Cr customer 10,
  Cr cash 20, Dr inventory 10 / Cr COGS 10. Same-key replay → 200; same key with a
  changed disposition → 400.
- **Damaged return** refund voucher is only Dr sales 40 / Cr cash 40 (no COGS reversal);
  stock unchanged; zero-delta movement with `restocked:false, returnedQuantity:1`.
- **Customer-account credit** on a card sale → `store_credit` refund, Cr customer 30.
- **Exchange** of a credit sale at a raised current price ($30 → $35) → refund at the
  historical $30 reverses the receivable, replacement priced $35 by the server,
  `balanceDue` 35.
- **Dispatch** 3 × $16 → Cr RETAIL-INVENTORY 48 / Dr RETAIL-IN-TRANSIT 48; source −3,
  destination unchanged; overshipment 409; replay 200; changed replay 400.
- **Receive** (two concurrent receivers → one 201, one 409) → Dr inventory 48 / Cr in-transit
  48; destination 2 @ $19 + 3 @ $16 = 5 @ $17.20; in-transit balance 0; no revenue/COGS lines.
- **Voucher guard** Retail Journal / Credit Note / Adjustment creation and edits, deletes,
  bulk deletes and entry edits of automatic journals → 403; reading them → 200;
  Payment vouchers and non-Retail companies unaffected.
- **Final tie-out** RETAIL-CASH ledger = Σ cash tenders − Σ cash refunds; customer ledger and
  the POS balance endpoint = Σ credit tenders − Σ credit/store-credit refunds; inventory
  sub-ledger = RETAIL-INVENTORY (difference 0.00) after every step; RETAIL-IN-TRANSIT 0;
  Retail dashboard revenue and COGS = the posted RETAIL-SALES and RETAIL-COGS balances.

### Checks run (local, isolated database)

| Check | Result |
|---|---|
| `npm run check` (TypeScript) | Pass, 0 errors |
| `npm run lint` + lint ratchet | Pass, 0 errors / 0 warnings |
| Prettier on every file the branch changes | Pass |
| `npm run build` (client + server bundle verification) | Pass |
| `drizzle-kit push` + application startup migrations + `verify:startup-migrations` | Pass, 0 failures; `restocked` column present; migration SQL idempotent |
| Retail suites (`tests/retail-*`, wave 17c/17d) incl. the new reconciliation test | 19 files, 132 tests pass |
| Full frontend suite | 244 files, 2,265 tests pass (+ 2 new Retail UI test files) |
| Full backend suite | Pass in GitHub CI (run 39984585928); locally 1,086/1,089 before `main`'s toolchain/FX fixes, all three now pass |
| Repository audits (doc index, write routes, write evidence, type escapes, god files, route manifest, source-text ratchet, toolchain) | Pass |
| GitHub CI (`workflow_dispatch` on `47b72fb`, no PR opened) | **All jobs pass**: Repository Audits, Type-check, Lint / Format, Build, Backend / Database Tests, Frontend Tests, Coverage Ratchet and the CI gate |

### Browser device check (built app, Chromium, isolated database)

Run against `npm run build` output with a seeded Retail company, at 1440×900 and
a 390×844 touch phone viewport:

- Keyboard-wedge scan with focus outside any field adds the exact Red / L variant;
  field scan adds Blue / S; an unknown barcode shows feedback and leaves the cart alone.
- Totals come from the server preview (40.00 → 70.00).
- Gallery: thumbnail opens it without adding to the cart; arrow keys browse and wrap;
  Zoom toggles; Escape closes and returns focus to the thumbnail; a variant gallery
  contains only that variant's photos; the Inventory product gallery shows the style
  photo plus every variant photo, and a broken photo becomes a placeholder.
- Existing customer picked from the POS; Split turns $70 into 35 + 35; one row switched
  to customer credit shows "On account: 35.00"; the sale completes, the tender resets to
  cash, and the receipt print runs with the on-account line.
- Return by receipt number completes.
- Phone: no horizontal scroll on POS, Inventory or Stock operations; sticky cart bar
  shows the total and Complete Sale; the gallery fits the screen and works by touch.
- Stock operations: dispatch through the UI moves Main 20 → 19 with Mall unchanged and
  one shipment pending; Confirm receipt moves Mall 3 → 4 and clears the queue.
- Not covered: a physical camera scanner and a physical receipt printer. Noted, not
  changed: the global draggable "My Notes" button (30% opacity, also on `main`) can
  sit over the phone cart bar's total; it does not cover Complete Sale.

### Open items (not fixed — need an owner decision)

- ~~Per-location authorization~~ — resolved: non-manager roles may only ship from,
  receive at, or immediately move between their assigned Retail locations.
- ~~Receivables paid later through ERP receipts~~ — owner decision (2026-10-24): keep
  it. The return credits the customer's account; a cash payout, if wanted, is an ERP
  Payment voucher to the customer. Documented in `retail-pos-inventory-workflow.md`
  (Phase 4).
- ~~Repository-wide toolchain and `wave17c-rates` failures~~ — resolved by merging
  `main`, which aligned `render.yaml` on Node 24.22.1; both now pass on this branch.
- A physical camera scanner and receipt printer still need a check on real hardware.

## Release and handoff rules

1. No CI/tests/lint/builds/typechecks/merge/rebase/deploy were executed by
   ChatGPT, and no production vouchers or stock records were changed.
2. Claude should run source and integration checks in an isolated environment,
   resolve discovered bugs on **the same feature branch**, and report evidence.
3. The user must approve final merge and Render deployment separately.
4. Do not treat a source-level commit as a production-verified solution.
5. Avoid a new draft PR until the owner's GitHub Actions triggering policy is
   confirmed; PR creation may itself start CI before Claude is ready.

## Prompt for Claude

> Continue work on branch `feature/retail-pos-inventory-workflow` in
> `Hassan-Merhi/ERP-FACTORY-SYSTEM`. All eight phases are committed in source,
> but ChatGPT deliberately ran no checks, CI, builds, merge, rebase or deploy.
> Read `docs/retail-pos-inventory-workflow.md` and this handoff in full.
> Review all Phase 1–8 changes against current main; inspect TS/React/Express/
> Drizzle contracts, migration sequencing and retail accounting invariants.
> Reconcile upstream changes cautiously on the same branch. Run focused tests,
> typecheck, lint and CI under your ownership, repair every integration issue
> and edge case without editing production accounting or stock data. Validate
> Retail cash/credit/discounts, returns, damaged/no-restock, exact variant
> transfers, in-transit valuation and manual voucher authorization, plus normal
> ERP/Factory regressions. Produce a precise pass/fail reconciliation and any
> remaining blockers. **Do not merge or deploy without the owner's approval.**
