# Factory Dispatch Trip Accounting — Phase 8 Handoff

**Date:** 2026-11-10  
**Branch:** `feature/factory-dispatch-trip-accounting-20261110`  
**Phase:** 8 — One final customer invoice consolidating all signed Factory dispatch trips, with exact existing customer receivables, no duplicate journals and signed bale COGS/offload.

## Owner's execution constraints

- **No CI checks or tests have been run.** Phase 8 test source is committed but remains unexecuted.
- **No SQL executed**. All manual PostgreSQL migrations are saved for the operator's final TablePlus execution.
- **No merge to main**, **no Render deployment**, **no automated ERP PO import button**.
- This is an implemented **code source**, not yet a tested/released production workflow.

## New combined-invoice flow

1. Every physical truck is CLOSED and financially POSTED (Phases 3/4). The supervisor removes only unshipped Pending Loading bales using one atomic batch correction, then signs the exact all-trucks reconciliation (Phase 7).
2. Open **Factory → Dispatch → Compare All Trips** and view **Combined Order Reconciliation**. After signoff, the new **One Combined Customer Invoice** panel appears. It previews:
   - all original truck IDs/counts and posted customer charges/discounts;
   - the exact already-posted Factory trip customer receivable;
   - original **customer_order_charges**, separately identified as pre-posted or not yet posted;
   - the **single final invoice amount**, with any original charges included once;
   - total signed shipped bales, original goods subtotal, inventory COGS and cutover applicability;
   - any blocking accounting/item mismatch.
3. Admin/Owner/Developer enters a reason and explicitly acknowledges reviewed original charges and **no double debiting of already-posted customer receivables**, then clicks **Finalize one combined invoice**.
4. The API checks the signed Phase 7 reconciliation **again under order + trip locks**, including exact fingerprint, financial posting IDs, frozen bales, live original vouchers and USD totals.
5. **One transaction** allocates the company's existing `INV-000001` invoice sequence number, posts only the missing accounting classification, marks the exact shipped signed bales SOLD, freezes signed commercial line prices and marks each original trip financial control `CONSOLIDATED`. It updates one original `customer_orders` row to `FINALIZED`, saves the immutable `factory_dispatch_order_consolidations.finalization_details` including all trips and accounting voucher references, and appends the consolidated finalization daybook/audit event.
6. After commit, the existing canonical invoice document service freezes the one invoice for Excel/PDF. If freezing fails, the committed invoice remains successful, and the existing export path can retry its snapshot; **no accounting retry** occurs.
7. Repeating an identical finalize request returns the existing invoice number and source voucher IDs (`replayed: true`), with **no second invoice, cost movement, charge or customer debit**.

## Accounting entries

**Already posted on individual trucks:**

- Goods and customer-billable fees (net discounts): original `FDTR-...` vouchers debit the Factory customer once, credit `FACTORY_DISPATCH_CLEARING` for goods and configured income accounts for billable fees, and debit configured contra accounts for discounts.
- Internal Factory trip expenses: original `FDTE-...` vouchers already posted to their expense / payable accounts.
- These vouchers are **never repeated, edited, replaced or reversed** by combined finalization.

**Only new journals at final consolidation:**

- Goods reclassification: **Dr FACTORY_DISPATCH_CLEARING / Cr FACTORY_BALE_SALES_INCOME** for the signed **goods subtotal ONLY**. No customer account on this journal.
- Inventory cost when the company has an effective active perpetual-inventory cutover: **Dr COGS / Cr FACTORY_FINISHED_GOODS**, using only physically shipped, signed bale IDs. The Factory bale `total_cost NUMERIC(20,7)` is summed at full precision, then rounded once to cents for this journal.
- Original order-level customer charges not already posted: one deterministic voucher per `customer_order_charges` row (**Dr Customer Ledger / Cr configured charge account**) with its `voucher_id` linked. Existing live PRE charge vouchers are checked for the correct customer debit AND charge-account credit; an unlinked legacy PRE voucher is a BLOCKER, not an excuse to post again.
- No new `customer_balances` SALE cache row. No `INV-GL-...` full-invoice receivable. No `syncFactoryInvoiceTx` call, no ordinary order `/finalize`, and no automatic ERP PO import.

**One final document total:**

```text
Final Combined Invoice
  = Sum of all previously POSTED trip customer totals
  + Original customer_order_charges not represented in trip charges

Each trip customer total
  = Frozen signed bale goods + Customer-billable trip charges - Trip discounts
```

Original order charges already posted as vouchers are included in the final commercial total but **not posted again**. Missing ledger-account mappings block finalization rather than creating an unbalanced invoice.

## Inventory and commercial document

- Only the immutable Phase 7 signed **physically scanned** bale IDs become SOLD. Previously unshipped/reconciled bales remain available IN_STOCK.
- The existing `customer_order_lines` are rebuilt from **signed frozen bale price evidence** (grouped by article/product/bale rate) before `FINALIZED`. This avoids silently recalculating an old per-kg proforma into a different amount from what customers were already charged on trips.
- The existing canonical Factory Excel/PDF contains the invoice number and the full list of signed dispatch trip numbers. Its charges section includes original order charges plus all financially posted **BILLABLE** trip charges and negative **DISCOUNT** rows; internal-only expenses are excluded. All displayed goods + charge amounts must reconcile to the signed final total, or document generation refuses to emit an incorrect invoice.
- Combined invoice display currency is **USD**, matching the signed trip accounting. ERP supplier purchase rates remain separate from Factory selling prices and are manually imported through Normal ERP PO Import.

## APIs and frontend

**Backend (new)**

- `server/routes/factory/customer-orders/loadingDispatchCombinedInvoiceService.ts` — preview and transaction-based finalizer, exact customer-charge/voucher verification, ledger clearing-to-sales, active cutover COGS, invoice sequence, SOLD bales, one finalization receipt.
- `server/routes/factory/customer-orders/loadingDispatchCombinedInvoiceRoutes.ts` — company-scoped GET preview and supervisor-only POST finalize with explicit review confirmations and immutable fingerprint. After a successful transaction, attempts to freeze the canonical commercial document and notify the user.
- `server/routes/factoryRoutes.ts` / `config/route-manifest.json` — registers both routes before legacy broad Factory dispatch paths.

**Frontend (new/updated)**

- `client/src/pages/factory/FactoryDispatchCombinedInvoicePanel.tsx` — signed invoice preview, original charges, double-billing confirmations, finalization and completed invoice details.
- `client/src/pages/factory/FactoryDispatchOrderFinancialReview.tsx` — mounts the final invoice panel after Phase 7 signature.
- `client/src/pages/factory/FactoryLoadingDispatchCompare.tsx` — passes live Factory company context.
- `server/routes/factory/customer-orders/loadingDispatchOrderReconciliationRoutes.ts` — recognizes finalization as a legitimate signed state change and preserves the original signoff display.

**Existing invoice/statement integrations updated**

- `server/services/factoryInvoiceDocumentModel.ts`, `factoryInvoiceDocumentSource.ts`, `factoryInvoiceDocumentService.ts` — signed trip provenance and combined fees, rendering truck numbers on one PDF/Excel, fail-closed commercial total reconciliation.
- `server/services/accounting/balances/unpostedMemo.ts` — prevents a finalized dispatch combined invoice from appearing as a second *unposted invoice memo* when its customer receivable already exists in the original trip vouchers.

## Deferred SQL — final handoff

- `docs/sql/manual/2026-11-10-factory-dispatch-phase8-one-invoice.sql` — Phase 8 finalized invoice fields, immutable status transition, posted-voucher evidence validation and unique invoice number.
- `docs/sql/manual/2026-11-10-factory-dispatch-phase7-order-reconciliation.sql` — also enhanced to allow ONLY a signed DRAFT charge's `voucher_id` linkage to a valid posted customer+charge voucher without modifying approved amounts or account mapping.
- **ONE combined TablePlus copy/paste file:** `docs/sql/manual/2026-11-10-factory-dispatch-all-phases-tableplus.sql`. Contains Phase 2 → Phase 4 → Phase 5 → Phase 6 → Phase 7 → Phase 8, each wrapped in its own BEGIN/COMMIT.

**Prerequisite:** phase 6 requires the established `erp_company_scope_matches(integer)` RLS function. Verify it and the intended active ERP/Factory database before running the final manual SQL, and use a verified backup. Nothing has been installed by the assistant.

## Staged regression tests — NOT EXECUTED

`tests/factory-dispatch-financial-phase8.test.ts` covers posted vs new customer totals, exact signed source, absence of a second receivable, clearing-to-sales, optional COGS, original charges, immutable invoice identity, customer PDF/Excel fees and final SQL constraints. All previous phase test files remain staged. CI and runtime browser/database checks are deferred by owner instruction.

## Completion boundary

The Phase 8 **source, UI, financial/document integration, SQL and test definitions are committed** to the feature branch. The complete Factory multi-trip system is **not yet verified against a live database or in a production deployment**. Do not treat it as production-ready until the manual schema migration is installed and real posting flows are tested under controlled conditions. No CI, SQL, merge or Render deployment occurred.
