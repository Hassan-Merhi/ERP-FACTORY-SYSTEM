# Factory Dispatch Trip Accounting — Phase 2 Handoff

**Branch:** `feature/factory-dispatch-trip-accounting-20261110`  
**Date:** 2026-11-10  
**Scope:** Schema model, manual-only TablePlus DDL, source snapshot validator and staged regression tests.  
**Execution:** NO CI, tests, builds, SQL, deployment, or merge to main performed.

## Delivered files

- `shared/schema/factory/dispatch-financials.ts` — seven typed financial tables, exported by `shared/schema/factory/index.ts`.
- `docs/sql/manual/2026-11-10-factory-dispatch-trip-financial-phase2.sql` — **manual-only** PostgreSQL installation, with composite company/order/trip/signed-closure foreign keys and append-only snapshot/history guards. Saved for **the user's final all-phase TablePlus handoff**. DO NOT execute or auto-run.
- `server/services/factory/dispatchTripFinancialSource.ts` — exact physical-close manifest and Pending Loading source validator plus SHA-256 fingerprint; **read-only**.
- `tests/factory-dispatch-financial-phase2.test.ts` — staged source test coverage, **not executed**.

## Tables defined — no production tables created yet

1. `factory_dispatch_trip_financials` — one control row per `(company_id,order_id,dispatch_id)`, status DRAFT / POSTED / REVERSED / CONSOLIDATED, amounts and source fingerprints.
2. `factory_dispatch_trip_financial_bales` — append-only, per-revision frozen individual scan barcode, bale, article, KG and exact per-bale price evidence.
3. `factory_dispatch_trip_charges` — per-revision trip charges, classification BILLABLE / INTERNAL / DISCOUNT, selected ledger/offset accounts, optional supported PO export mapping, immutable once frozen.
4. `factory_dispatch_trip_postings` — append-only idempotent posting references and voucher IDs, including audited reversals.
5. `factory_dispatch_trip_exports` — exported-file evidence and stable ERP PO identity, without pretending a file download is an ERP import.
6. `factory_dispatch_order_consolidations` — one consolidation record per original Factory order; no duplicate invoice.
7. `factory_dispatch_financial_events` — append-only financial audit timeline.

All newly created tables are declared in `shared/schema`, so the repository's runtime-only-table ratchet does not require an expanded baseline. The six *existing* physical dispatch tables remain untouched. SQL is intentionally **not** part of the application's startup ensure path.

## Signed source invariants

`loadDispatchTripFinancialSource(tx, companyId, orderId, dispatchId)`:

- Accepts only an active company-scoped original order and a **CLOSED** physical trip with a current saved closure revision.
- Rejects a reopened closure or earlier historical closure that lacks `manifest_snapshot`.
- Rejects duplicate/removed physical scans, missing/altered Pending Loading bale IDs, different bale references/article codes/KG, invalid prices, and absent article codes.
- Uses `customer_order_bales.price_used` as the **exact stored per-bale total**; does not calculate with Javascript floats or assume planned truck quantities.
- Freezes one row per physically verified bale, includes article code for later ERP grouping, and reports exact goods subtotal and weight.
- Computes a deterministic SHA-256 `sourceFingerprint` from signed closure ID/revision/fingerprint, source price snapshots and barcode evidence. Trip posting must recalculate and compare it under the same order->trip lock.
- Does **not** post or alter customer balance, voucher, stock, existing physical trips or Pending Loading.

## Financial and database invariants

- Source closure cannot be substituted with a different trip or company: composite foreign keys bind source financials, scans and signed closure to the same company/order/dispatch.
- A financial bale row, posting, export-history row or financial event is append-only at DB level (manual SQL trigger).
- Only draft/reversed financial parents accept charge modifications; historical locked charge rows cannot be modified or deleted.
- The original Factory invoice remains under one `customer_orders` parent; no separate customer/supplier balance table is created.
- Built-in money constraints ensure stored totals are non-negative and `customer_total = goods_subtotal + billable_charges_total - discount_total`.
- Per-trip export identity and source fingerprint fields are ready for Phase 5. An export is not a receipt or acknowledged ERP import.

## Phase 3/4 integration checklist

1. Add company- and role-scoped charge CRUD and a per-trip financial preview UI; never mutate financials directly through client-supplied amounts.
2. For financial posting: acquire the parent order lock, then trip lock, validate latest closure, compare fingerprint, ensure parent is DRAFT/REVERSED, persist new signed snapshot revision, freeze its charge revision, post vouchers atomically, then update parent status POSTED. Ensure version and posted voucher metadata do not get edited after posting.
3. Recheck all selected charge accounts belong to the same company and validate kind/contra account and customer-side impact; do not silently classify an internal expense as customer receivable.
4. Introduce server-side guards on trip reopen, order bale removal, repricing, final invoice and invoice reversal once financial postings exist.
5. Account for the existing `CHARGE-` and `INV-GL-` invoice journal logic before posting any real customer amounts; do not reuse `postOrderChargeVoucherTx` on an unfinalized parent.
6. For the ERP file exporter, group bales by normalized **article code**, one row per item/rate, and conform to `poImportExcelParser.ts`. Validate supplier selection, unique container ID, and charge compatibility.
7. After all phases, provide the final user-ready SQL in a copy/paste TablePlus format with dependency order, and let the **user** execute it. Never execute this or later manual SQL without new instruction.

## Completion boundary

**Phase 2 source implementation complete on the feature branch.** This is not a production-installed schema, and its staged tests have not run. The manual SQL is intentionally held for the final handoff as requested. Phase 3 charge management and later financial posting remain separate deliverables; no operational behavior has changed in production.
