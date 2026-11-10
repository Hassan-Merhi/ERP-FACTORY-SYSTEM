# Factory Dispatch Trip Accounting — Phase 7 Handoff

**Date:** November 10, 2026  
**Branch:** `feature/factory-dispatch-trip-accounting-20261110`  
**Scope:** One Pending Loading compared with ALL CLOSED physical truck trips, atomic audited shortfall removal, verification of previously posted financial trip snapshots/vouchers, and signed financial approval that Phase 8 will use as the one combined invoice's source of truth.

**Owner constraints:** No CI checks/tests/build, no SQL execution, no merge into main, no Render deployment. All SQL is staged for the final TablePlus handoff.

## Implemented workflow

### 1. Single all-truck view

Open Factory Dispatch Management → **Compare All Trips**. The existing physical comparison (by exact bale barcode/reference, article, KG, unexpected scans and duplicates) is retained. Under it, the new **Combined Order Reconciliation** card shows:

- Original active Pending Loading bales, total physically scanned bales, total frozen financially posted bales, and unshipped shortages.
- Every truck, its physical CLOSED status, financial POSTED status, signed per-trip number of bales, actual goods subtotal, customer billable charges, discounts, customer total, and linked immutable POST reference.
- Whether the truck's **ERP PO Excel was generated**. This is deliberately labeled **not proof of manual ERP import**; cross-company ERP receipt reads are not attempted by Factory's RLS-scoped API.
- Total goods, trip charges, discounts and *combined previously posted* Factory customer receivable, without posting another receivable or creating an invoice.

No expected bale allocation per individual truck is invented. Only the original Pending Loading list and real physical barcode scans establish which bales were shipped.

### 2. One atomic, reasoned shortfall correction

Select actual **missing/unshipped** bale references. Admin/Owner/Developer opens the confirmation dialog, enters a 10–1,000-character reason, and confirms the full selected set.

`POST /api/factory/customer-orders/:id/loading-dispatches/order-reconciliation/remove-unshipped`

The server holds the company priority advisory lock and relevant proforma lock, locks original order and trips, recalculates all physically scanned vs expected bales and compares an exact signed fingerprint. It verifies that:

- Every physical truck is CLOSED; no duplicates, unexpected physical scans or changed references.
- Every selected **order-bale-link ID** is *currently* missing from the union of active truck scans.
- None of those physical bale IDs belongs to a financially POSTED trip.
- No prior order-wide signoff exists.

All selected links are removed from Pending Loading in **one database transaction**, all corresponding physical Factory bales return to IN_STOCK, standard audited `customer_order_bale_removals` records are written, original loading totals are recalculated, and any linked priority/proforma allocation is reversed. An append-only `ORDER_UNSHIPPED_BALES_REMOVED` event includes actor/reason, exact IDs/references and before/after fingerprint. If **any** bale or adjustment fails, the whole batch rolls back; there is no partial shortage removal.

The former per-bale `DELETE .../bales/:id?source=dispatch-reconciliation` is now explicitly **rejected** (`409 USE_ATOMIC_DISPATCH_RECONCILIATION`), preventing bypass via an older UI or direct caller. Standard non-dispatch bale corrections retain their existing rules.

### 3. Verify all financially posted trips before signoff

The server reads immutable `factory_dispatch_trip_financial_bales` and each original `factory_dispatch_trip_postings` record, then checks:

- Every physical truck is CLOSED and has one POSTED financial control row; no draft/reversed/unposted trips.
- Every financial bale matches an active physically scanned bale in the *same truck* by exact ID, barcode/reference, article and KG.
- No bale is double-counted across signed trips; no missing/extra/duplicate physical bale.
- Each trip's frozen bale line totals equal posted goods; each trip's billed amount equals goods + customer charges - discounts.
- Original posting ID, source fingerprint and amount match; linked voucher IDs are unique and reference still-active, non-optional vouchers in the correct Factory company.
- Combined customer amount is the sum of the existing individual posted customer balances, **not a new debit**.

Existing order-level charges are displayed **separately**, *excluded* from the sum of trip receivables and flagged for Phase 8 to include/classify once without double billing. If any requirement fails, the signoff button stays disabled.

### 4. Sign ONE order-wide snapshot

Admin/Owner/Developer explicitly confirms and submits reason + current fingerprint:

`POST /api/factory/customer-orders/:id/loading-dispatches/order-reconciliation/approve`

Inside the locked database transaction, the server recomputes source, validates fingerprint, and writes one **DRAFT** `factory_dispatch_order_consolidations` record with:

- `reconciliation_fingerprint`
- immutable `reconciliation_snapshot` (per-trip financial IDs, posting IDs, goods, charges, discounts, customer totals and scanned bale counts)
- `included_posting_ids`
- `goods_subtotal, billable_charges_total, discount_total, customer_total`
- `reconciled_at, reconciled_by_user_id, reconciliation_reason`

The signer and fingerprint are also recorded in an append-only `ORDER_DISPATCH_RECONCILIATION_APPROVED` audit event. A repeated submission using the exact same fingerprint is safely idempotent; different evidence is rejected rather than silently overwriting an approval.

**Financial significance:** These are existing POSTED trip balances held under one DRAFT consolidation. There is **no invoice number, new customer debit, stock offload/COGS journal, ERP import or second charge journal** during Phase 7.

### 5. Signed evidence protection

The manual Phase 7 TablePlus SQL extends the existing typed consolidation model with approval columns, check constraints and protective database triggers:

- Approved reconciliation source/fingerprint/totals and posting list are immutable.
- No barcode scans, physical trip updates, closure rewrites, new/altered loading bales or order-level charge mutations after approval.
- No financial POST reversal/reprice after approval. Phase 8 may change each trip status `POSTED → CONSOLIDATED` while preserving its source/amount fields.
- The original `factory_dispatch_financial_events` audit history remains append-only.

The approval fingerprint intentionally ignores independent *manual ERP PO file-download status*, so downloading a file after signing does not invalidate the Factory reconciliation. The signed fingerprint still includes the physical and financial evidence needed for Phase 8.

## Implemented/updated files

**Backend**
- `server/routes/factory/customer-orders/loadingDispatchOrderReconciliationModel.ts` — deterministic pure all-truck comparison, anomaly detection, exact money and approval fingerprint.
- `server/routes/factory/customer-orders/loadingDispatchOrderReconciliationData.ts` — company-scoped financial/physical snapshot reader; validates linked source voucher IDs, fingerprints, and amounts.
- `server/routes/factory/customer-orders/loadingDispatchOrderReconciliationRoutes.ts` — preview, atomic shortage correction and signed snapshot approval.
- `server/routes/factory/customer-orders/loadingDispatchComparisonRoutes.ts` — invoice-number field included in shared order snapshot.
- `server/routes/factory/customer-orders/bale-scanning/remove.ts` — reject the old unsafe per-bale dispatch correction.
- `server/routes/factoryRoutes.ts` and `config/route-manifest.json` — register exactly three new routes.

**Frontend**
- `client/src/pages/factory/FactoryDispatchOrderFinancialReview.tsx` — combined order/trip amounts, remaining differences, finance/voucher status, manual ERP file warnings, approval reason and signoff.
- `client/src/pages/factory/FactoryLoadingDispatchCompare.tsx` — mounted the new panel on the existing **All Trips** comparison view; removed sequential DELETE calls, added one atomic, approved shortfall removal.

**Schema and deferred SQL**
- `shared/schema/factory/dispatch-financials.ts` — typed approval columns/check constraints; no new separate invoice or receivable table.
- `docs/sql/manual/2026-11-10-factory-dispatch-phase7-order-reconciliation.sql` — Phase 7 PostgreSQL signoff and evidence locks. **NOT EXECUTED**.

**Regression source**
- `tests/factory-dispatch-financial-phase7.test.ts` — staged tests for multi-truck totals, exact shortages, duplicate/unexpected scans, missing financial vouchers, charge separation, export-independent fingerprint and atomic correction. **NOT RUN**.

## Manual TablePlus scripts held for the FINAL handoff

1. `docs/sql/manual/2026-11-10-factory-dispatch-trip-financial-phase2.sql`
2. `docs/sql/manual/2026-11-10-factory-dispatch-trip-financial-phase4-guards.sql`
3. `docs/sql/manual/2026-11-10-factory-dispatch-trip-financial-phase5-export.sql`
4. `docs/sql/manual/2026-11-10-factory-dispatch-erp-po-phase6-receipts.sql`
5. `docs/sql/manual/2026-11-10-factory-dispatch-phase7-order-reconciliation.sql`

All are saved on the feature branch. The user will execute SQL in TablePlus only at the end of the entire program. Nothing was run automatically.

## Phase 8 contract

- Require a valid, currently matching signed Phase 7 reconciliation under the same original loading and trip locks.
- Create **one** final Factory customer invoice for the original `customer_orders` row; include all signed trip IDs and approved order-level charges once.
- Transfer goods credit from `FACTORY_DISPATCH_CLEARING` to Factory Sales Income; **do not debit Customer Receivable again** for the already POSTED trip balances.
- Post once-only COGS and inventory offload against just physically shipped, signed bale IDs, never the removed shortages.
- Mark included trips CONSOLIDATED with the signed POST identities, no duplicate customer balance cache row, no duplicate voucher or manual ERP PO import.
- Preserve the ability to view the signed order history after `customer_orders` status becomes FINALIZED. An expected status/invoice-number change during Phase 8 is not by itself a corrupt prior signoff.

## Completion boundary

**Phase 7 code, typed schema, UI, SQL script and tests are committed, not executed or runtime-validated.** No CI/test/build, SQL, merge or Render deploy was performed. New routes intentionally fail until all manual financial schema scripts have been applied. Phase 8 final invoice code has not been started.
