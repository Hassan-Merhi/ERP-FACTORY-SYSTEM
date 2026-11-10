# Factory Dispatch Trip Accounting — Phase 4 implementation handoff

**Date:** 2026-11-10  
**Branch:** `feature/factory-dispatch-trip-accounting-20261110`  
**Scope:** Transactional Factory trip financial finalization, immediate customer-ledger posting, charge journals, controlled reversal, immutable evidence gates and UI.  
**Explicit user constraints:** NO CI; NO test execution; NO SQL execution; NO merge to main; NO Render deployment. Any TablePlus SQL is held for the end of all phases.

## Business behavior implemented

Each physical dispatch is still scanned and ended separately. Ending the truck changes **only** physical verification. An Admin/Owner/Developer opens its **Trip financial preview & charges**, reviews the snapshot of actually scanned bales and prices, and explicitly confirms **Financially Finalize Trip**.

One database transaction performs the following, with parent order lock before truck and financial locks:

1. Verifies company, role, original Pending Loading status, physical CLOSED trip, latest signed closure snapshot, exact current barcode membership and bale prices.
2. Compares the browser's signed source fingerprint and charge fingerprint against the current locked evidence; refuses concurrent changes.
3. Confirms real active company-owned ledger accounts, USD currency, supported charge category and the nonnegative customer total.
4. Freezes the signed individual physical bale and article/weight/price snapshot, with an immutable revision.
5. Posts **one provisional customer receivable voucher** through the existing balanced Factory posting engine, with deterministic per-trip/revision identity:
   - Dr existing Customer Receivable for `goods + billable charges − discounts`.
   - Cr **Factory Dispatch Clearing** for goods (not immediate Factory Sales Income).
   - Cr selected charge income accounts for billable charges.
   - Dr selected discount/contra income accounts for discounts.
6. Posts each **internal trip expense** through the same engine: Dr selected expense/cost account / Cr selected payable/accrual liability account. This does **not** debit the customer and does **not** imply cash settlement.
7. Saves the posted voucher IDs to the charge rows and the immutable `factory_dispatch_trip_postings` audit record; marks the parent financial trip `POSTED`.
8. Displays the trip as financially posted with linked voucher IDs and history.

**No `customer_balances` cache SALE row is added per trip.** The existing customer statement, Accounts and Net Position derive balances from the actual customer-tagged ledger vouchers; adding a second cache row would risk phantom memo/double receivables. The customer's balance increases via the posted Dr customer ledger line only once.

The original order's `customer_orders.invoice_number` remains **NULL** until Phase 8's one combined final invoice. Goods credit stays in `FACTORY_DISPATCH_CLEARING`; Phase 8 will reclassify goods clearing to Factory Sales Income without duplicating customer receivable. Cost/COGS is not prematurely posted during the trip.

## Controlled corrections

- UI permits reversal only for an unconsolidated `POSTED` trip, with an explicit confirmation and a reason of 10–1,000 characters.
- Reject if the trip has any PO Excel export record: cross-company correction is required instead.
- Reject if the order has linked payments or if a customer ledger credit may have settled this receivable; reconcile customer payment/credit first.
- Reverse by separate **balanced mirror vouchers**, linked in immutable posting records to the original POST. Never physically delete the old voucher, barcode evidence, or posted charges.
- New revisions after reversal keep historical prior snapshot, charge and posting rows immutable. New charge revisions can be entered before re-posting.
- Mirror vouchers are posted at the company's current business date, through the same central posting engine; closed-period checks remain active.
- Retried original POST requests are idempotent: they return the existing posting only if the persisted signed source matches; different source fingerprints are rejected.

## Protections added

- Normal physical dispatch reopen is blocked if the same trip has a live posted receivable.
- Ordinary (non-reconciliation) bale removal and container emptying are blocked on orders with live trip accounting. The existing authorized **unshipped** bale reconciliation is still possible; a bale included in a posted truck can never be removed.
- Original order rewrites, charges, repricing and changes are blocked by an early Company-scoped Factory middleware gate while any trip has a live posting. Physical trips and approved loading-status transitions retain their existing workflow.
- The old `/customer-orders/:id/finalize` handler now refuses any dispatch-managed order; it cannot silently post a full duplicate receivable and sell all bales.
- Legacy `/unfinalize` refuses to revert an invoice with live posted dispatches.
- **`syncFactoryInvoiceTx` itself** refuses the legacy full-invoice journal path for orders with posted trip financials, preventing bypass through other Factory services. Phase 8 must explicitly implement the one-invoice clearing path.
- The final TablePlus SQL addendum adds DB-level guards for physical/closure scan changes, posted order bale mutation, and FORCE ROW LEVEL SECURITY for all 7 new financial tables.

## Core files

### Financial posting and safeguards

- `server/services/factory/dispatchTripFinancialPosting.ts` — source verification, locked financial post, exact monetary entries, idempotency, mirror reversal and customer-credit protection.
- `server/services/factory/dispatchTripFinancialGuards.ts` — company-scoped live-post detection. It safely checks for the Phase 2 schema's existence to preserve existing behavior until TablePlus installation.
- `server/routes/factory/customer-orders/loadingDispatchFinancialPostingRoutes.ts` — 3 guarded endpoints.
- `server/routes/factory/customer-orders/loadingDispatchFinancialChargeModel.ts` — internal cost offset restricted to liability/payable/accrual rather than an unconfirmed cash payment.
- `server/routes/factory/customer-orders/loadingDispatchFinancialChargeRoutes.ts` — updated account validation message.
- `server/services/accounting/perpetualInventory/factoryInvoice.ts` — source-of-truth double-post safeguard.
- `server/routes/factory/customer-orders/finalize-loading/finalize.ts`, `unfinalize.ts`, `loadingDispatchLifecycleRoutes.ts`, `bale-scanning/remove.ts`, `server/routes/factoryRoutes.ts` — existing route safeguards.
- `config/route-manifest.json` — registered the three additional Phase 4 endpoints.

### UI

- `client/src/pages/factory/FactoryLoadingDispatchPostingPanel.tsx` — confirmation dialog, posting/reversal action, voucher IDs, and status/history.
- `client/src/pages/factory/FactoryLoadingDispatch.tsx` — mounts the panel on the existing dispatch detail page.
- `client/src/pages/factory/FactoryLoadingDispatchFinance.tsx` — corrected internal-expense payable-account picker.

### Staged SQL and regressions — not run

- `docs/sql/manual/2026-11-10-factory-dispatch-trip-financial-phase2.sql` — 7 Phase 2 tables with composite FKs and immutable history.
- `docs/sql/manual/2026-11-10-factory-dispatch-trip-financial-phase4-guards.sql` — Phase 4 posted-bale/scan/closure guards and forced company-scope RLS.
- `tests/factory-dispatch-financial-phase4.test.ts` — staged accounting equation, idempotency, reversal, and legacy double-post protection coverage.
- `tests/factory-dispatch-financial-phase3.test.ts` — updated to refuse pretending an unpaid internal cost was paid from bank.

The posting service **fails closed with HTTP 503** until both manual SQL files are installed and its required RLS and trigger safeguards are present. No TablePlus execution was performed.

## Routes

| HTTP | Route suffix below `/api/factory/customer-orders/:id/loading-dispatches/:dispatchId` | Description |
| --- | --- | --- |
| `POST` | `/financial-finalize` | Requires `confirm: true`, source and charge fingerprints. Posts exactly once under lock. |
| `POST` | `/financial-reverse` | Requires `confirm: true` and at least 10-character reason. Controlled audited mirror vouchers, no deletes. |
| `GET` | `/financial-history` | Lists financial state, recent posting entries, linked vouchers and audit events. |

All require authenticated Factory Invoicing → Loadings access and Admin/Owner/Developer permissions, and trust the server's active Factory company rather than a user-submitted company ID.

## Pending phases

- **Phase 5:** One per-trip Excel file in the existing ERP PO Import format (article code rather than bale reference). Export follows a **POSTED** financial trip; it is NOT automatic ERP posting.
- **Phase 6:** Ensure ERP's PO loader maps the article, rates, supplier and charges safely, prevents duplicate import, and supports different ERP supplier valuation.
- **Phase 7:** One order-wide comparison of Pending Loading against all physically finalized trips and approved short shipments.
- **Phase 8:** ONE consolidated Factory invoice, correct clearing reclassification, charge inclusion and once-only inventory COGS; restore only the dedicated consolidate path after changing the legacy journal guard.
- **Phases 9–10:** Reporting and audit presentation, all remaining migration/SQL handoff, manual validation and controlled deployment.

## Scope and delivery status

**Phase 4 code changes are committed.** No CI, test suite, build, migration, TablePlus SQL, merge, or deployment was performed. Live accounting correctness is **not verified** until the two SQL files are applied in a controlled environment and ledger reconciliation is run. User will run final SQL themselves at the end.
