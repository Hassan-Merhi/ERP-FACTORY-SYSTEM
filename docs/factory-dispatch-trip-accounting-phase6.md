# Factory Dispatch Trip Accounting — Phase 6 Handoff

**Date:** 2026-11-10  
**Branch:** `feature/factory-dispatch-trip-accounting-20261110`  
**Scope:** Normal ERP PO Import compatibility, strict Factory article-code/supplier/cost validation, durable source identity, one manual ERP receipt per truck, and safe duplicate/partial-import handling.

**Owner instructions preserved:** No CI checks, test execution, SQL execution, merge to `main`, Render deployment, or automatic Factory→ERP import button. All SQL remains saved for the final TablePlus handoff.

## Completed functionality (committed source)

The operator continues to use **Normal ERP → PO Import**, not a Factory-side import button:

1. Upload the Phase 5 truck `.xlsx`. The ordinary ERP parse endpoint detects the canonical `Container_Number=FD-{FactoryCompany}-{Order}-{Trip}` and `PO_Number=FDPO-{FactoryCompany}-{Order}-{Trip}`. Invalid or mixed identities are refused. **One truck per file** is mandatory.
2. On **Validate**, Factory-dispatch files require **the exact active ERP supplier code** from every `Supplier_Code` row, not just a supplier selected by name. Mixed or missing supplier codes are rejected.
3. Every article's `Item_Barcode` must match a real ERP stock item **code or alias exactly**, including case. No fallback by `Item_Name` is allowed on these Factory-origin POs; missing aliases must be created in ERP and the file validated again.
4. The billed `Quantity` must be a positive whole number of shipped bales for that article (not KG, and not an individual bale reference). One article code per row, one PO per truck.
5. Purchase `Rate` must be **positive, USD, and up to two decimals**; line total must be `Quantity × Rate`, with only harmless IEEE-754 rounding noise tolerated in the legacy ERP parser. Freight, Surcharge, Fumigation, Discount and Document_Charges must reconcile to the file's net charges; grand total must equal goods + charges − discount. Negative individual charges, inconsistent totals and unsupported Other Charges are rejected.
6. On the **Import** action, the backend repeats all checks; a browser or saved draft cannot bypass validation by changing client state.
7. The importer checks prior file hash, ERP PO number, the **globally unique ERP container number**, and the new **globally unique Factory source identity**. Before the first ERP purchasing/ledger write, it reserves an immutable Factory-origin ERP receipt with status `PENDING_REVIEW`.
8. The **existing ERP PO import** continues its original purchase/stock/accounting behavior. On success the new receipt is completed with the actual ERP container ID and import-log ID, status `IMPORTED`, and a source-to-target identity. It does NOT create a second Factory customer debit or additional separate supplier voucher.
9. **Rename or edit and retry the same Factory truck:** rejected because the source identity and container identity are stable independent of file name and MD5 checksum. **If an import fails after reserving the identity**, the receipt stays `PENDING_REVIEW` and blocks a retry. The operator must reconcile any partially posted ERP container, PO, vouchers and log before an authorized correction; retrying a possibly partially posted purchase is not safe.
10. Success toast states that the Factory trip was manually imported and linked to the ERP container.

## Safety and limitations

- New receipt SQL is **NOT installed** yet. Factory-trip parse/validation/import fails with a clear `503 FD_PO_RECEIPT_SQL_PENDING` until the final TablePlus handoff has been applied, including unique index, enabled/forced company RLS, and immutable origin trigger. Existing non-Factory PO imports retain their prior workflows.
- Database origin uniqueness is across all ERP companies: one Factory dispatch trip cannot be imported into multiple companies using the canonical identity.
- No cross-tenant Factory financial rows are read from an ERP session. Factory source identification is based on the **canonical PO/container identity in the manual file**, not a cryptographic authenticity certificate. The duplicate guarantee applies to a retained canonical Factory dispatch identity; it is **not protection against a deliberately forged/different origin**. A signed cross-company provenance check can be added if there is a need to authenticate Factory exports against a connected ERP company without relaxing RLS.
- The existing general PO importer has non-atomic legacy writes. An origin reservation keeps partial-failure retries **fail-closed**, but it does **not roll back** partial ERP purchase writes. Existing PO/import voucher recovery must be reviewed before trying to reconcile a pending receipt. This is explicitly not described as an atomic supplier import.
- Importing a PO follows the existing ERP supplier-accounting and offload lifecycle. A generated Factory Excel file alone never updates ERP balances.
- Normal ERPs may use parent-paid freight semantics; selecting Parent Freight instead of Supplier Freight can affect which ledger holds that freight. Existing validation and voucher rules apply unchanged.
- The Excel `Item_Barcode` contains **Factory article code**, not bale reference. A missing ERP code/alias must not be silently substituted by a same-name stock item.

## New and modified files

### New

- `server/routes/import/factoryDispatchPoImportGuard.ts` — canonical FD/FDPO identity, exact company-scoped ERP article alias and supplier code validation, positive integer quantities, reviewed USD rates and correctly reconciled totals; no name fallback.
- `server/routes/import/factoryDispatchPoImportReceipt.ts` — fingerprint, mandatory manual TablePlus schema readiness, duplicate inspection, pre-write unique origin reservation and post-import receipt completion.
- `docs/sql/manual/2026-11-10-factory-dispatch-erp-po-phase6-receipts.sql` — **NOT EXECUTED**, company-isolated receipt table, globally unique Factory origin and container identities, immutable completion trigger, status constraints and indexes.
- `tests/factory-dispatch-financial-phase6.test.ts` — staged identity, supplier, exact alias, rate/charge, floating-point dust, RLS/receipt and import-at-write regressions. **NOT RUN**.

### Modified

- `server/routes/import/po-import-preview.ts` — preserve `supplierCode` from the uploaded worksheet on each parsed article and container.
- `server/routes/bankAssetRoutes.ts` — fail-fast Factory origin parsing/duplicate checking at the existing `POST /api/po-import/parse`.
- `server/routes/import/po-import.ts` — strict Factory-only checks on both `/validate` and `/import`, immutable reservation before container/PO/voucher creation, no Factory name fallback on re-lookup, and completed source→ERP receipt link on successful manual import.
- `client/src/pages/POImport.tsx` — Factory-dispatch banner inside Normal ERP's existing PO Import wizard; exact supplier/code warnings and Factory-receipt success messaging.

## SQL sequence reserved for the FINAL handoff (not yet shared or executed)

1. `docs/sql/manual/2026-11-10-factory-dispatch-trip-financial-phase2.sql`
2. `docs/sql/manual/2026-11-10-factory-dispatch-trip-financial-phase4-guards.sql`
3. `docs/sql/manual/2026-11-10-factory-dispatch-trip-financial-phase5-export.sql`
4. `docs/sql/manual/2026-11-10-factory-dispatch-erp-po-phase6-receipts.sql`

Each is **only a staged source file**. None has run in TablePlus or production.

## Remaining program phases

- **Phase 7:** reconcile every CLOSED physical trip with Pending Loading as one order, permit approved removal only for actually unshipped bales, and show manually imported ERP receipt state without duplicate charges.
- **Phase 8:** finalize ONE Factory combined invoice and clear provisional dispatch goods receivables to sales **without debiting the customer again**; reconcile all charge ownership and inventory COGS.
- **Later QA/rollout phases:** run owner-approved tests and ledger reconciliation once all manual SQL is installed; merge and deploy only on explicit authorization.

**Phase 6 source is implemented and committed, but NOT runtime-validated.** No CI, tests, DB, main or Render actions occurred.
