# Factory Dispatch Trip Accounting — Phase 3 implementation

**Date:** 2026-11-10  
**Branch:** `feature/factory-dispatch-trip-accounting-20261110`  
**Completed scope:** Charge CRUD and ledger-account financial preview for each CLOSED physical dispatch trip.  
**Explicitly out of scope:** Creating vouchers, posting customer receivables, modifying stock, financial trip finalization, ERP PO export, consolidated invoices, merging, deployment, and SQL execution.

## User workflow

1. Open Factory Dispatch Management and select a truck trip.
2. Physically scan its bales and **End Dispatch** to freeze the barcode manifest.
3. In **Trip financial preview & charges**, review signed bale count, KG and goods amount.
4. Add charges individually as:
   - **Customer-billable:** adds to the proposed customer amount, requires an active **income/revenue** ledger account; optional PO export mapping to Freight, Surcharge, Fumigation, Document Charges.
   - **Internal expense:** separate, never automatically added to customer debt, requires both a valid expense/asset account and a company payable/cash/clearing offset account; no ERP PO charge mapping.
   - **Discount:** reduces the proposed customer amount and uses a validated discount/contra-revenue/expense account. Later ERP PO export will map it to the template's `Discount` field (not to Freight).
5. Save, edit or delete **draft** charges. The backend rechecks company, role, signed source manifest, price fingerprint, charge fingerprint and account ownership.
6. Review totals: goods, billable charges, discounts, internal expenses and customer amount.
7. **Phase 4** will introduce a separate controlled **Financially Finalize Trip** operation; this phase does not offer a posting button.

## Implemented files

- `server/routes/factory/customer-orders/loadingDispatchFinancialChargeModel.ts`
  - Exact decimal money math and normalization, safe charge classification, supported PO mapping checks, stable fingerprint for concurrent editors.
- `server/routes/factory/customer-orders/loadingDispatchFinancialChargeRoutes.ts`
  - Registered under the existing `factory/invoicing` Loadings permission.
  - Requires an authenticated **Admin, Owner or Developer** for reads and all mutations; prevents View Only, Create Only and POS access.
  - `GET /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/financial-preview`
  - `POST /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/financial-charges`
  - `PATCH /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/financial-charges/:chargeId`
  - `DELETE /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/financial-charges/:chargeId`
  - Keeps order -> dispatch -> financial locks for every mutation, refuse missing/changed signed scans, validate company-owned active accounts, use idempotent charge-fingerprint collision checks, and record append-only financial events.
  - Inserts one `DRAFT` parent financial control on first charge, never writes a voucher, daybook, customer balance, or stock.
  - Returns `503 TRIP_FINANCIAL_SCHEMA_PENDING` if the owner has not yet installed the manual Phase 2 TablePlus tables; it never runs DDL automatically.
- `server/routes/factoryRoutes.ts` — registered Phase 3 API routes.
- `client/src/pages/factory/FactoryLoadingDispatchFinance.tsx` — responsive light/dark charge list, editor, account pickers, preview, and friendly schema/source refusal messages; displays no financial-posting action.
- `client/src/pages/factory/FactoryLoadingDispatch.tsx` — mounted financial card on trip detail, below existing physical closure review, without altering scanning.
- `config/route-manifest.json` — added the four server routes in exact handler registration order.
- `tests/factory-dispatch-financial-phase3.test.ts` — staged regression specifications for arithmetic, mapping, account classification, fingerprints and validation. **NOT EXECUTED**.

## Financial preview formula

```text
Estimated Factory customer charge
  = signed dispatch goods value
  + billable trip charges
  - customer discounts

Internal expense total is displayed separately and NEVER added to the
customer total.

Existing order-level charges remain separate. Future Phase 8 consolidation
must check charge ownership so no order charge is counted twice.
```

## Safety constraints and next-phase integration

- No expected quantity or pre-planned bale allocation is required for a trip; only signed physically scanned barcodes determine source goods.
- A trip must be physically **CLOSED** with a saved intact manifest before saving charges.
- Admin/Owner/Developer access is enforced by the server; the UI is not the access boundary.
- Charges require a non-negative nonzero USD amount with 2 decimal places. Cross-currency posting must be implemented and reviewed in Phase 4 before other currencies can be enabled.
- Once the future financial status is POSTED or CONSOLIDATED, all Phase 3 draft-charge mutations are rejected. Locked older revisions stay read-only.
- Pending customer total cannot become negative from excessive discounts.
- PO charge mapping is optional in Phase 3; unsupported or unmapped custom billable charges must be explicitly handled in Phase 5/6 and must never silently vanish on export.
- Charge event history is append-only. The physical dispatch closure and financial source remain separate.
- Phase 4 must preserve the existing invoice and charge voucher accounting path, integrate provisional dispatch receivables and ensure no duplicate sales/AR when a final invoice is generated.
- **Manual SQL remains unchanged from Phase 2.** No new Phase 3 schema migration was introduced. The user requested all SQL only at the end of all phases and will execute it themselves in TablePlus.
- **No CI checks, tests, build, database SQL, merge, Render deploy, or production mutation were executed**. Production usability requires the final TablePlus schema installation and Phase 4 financial posting implementation.

## Phase 3 completion

Source changes, UI, route registrations and staged tests are committed on the feature branch. Functionality is not verified in a running database because tests and SQL execution were expressly excluded. The next task is **Phase 4 — idempotent customer balance and charge voucher accounting**.
