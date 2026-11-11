# ERP Phase 2 — Operational workflows (read-only production audit)

Date: 2026-11-11. Scope: ERP, supplier-partner, and ERP-integrated retail; Factory and Properties excluded. Primary Render Postgres `dpg-d75mfh0ule4c73ctksfg-a` in confirmed workspace `tea-d42ik0c9c44c73878jsg`; all queries read-only and company-scoped with RLS.

## Scope reviewed
- Purchase orders, supplier relationship and offloads.
- Stock transfer create/edited/draft flags, line integrity, location ownership and canonical movement evidence.
- ERP sales and stock-item references, POS idempotency IDs, credit notes and retail sale/return prevalence.
- Payment and receipt voucher prevalence and explicit reversal links.
- Existing automated workflow regression files and nonposting audit runner.

## Production results (current record snapshot)

| Company | POs | Transfers | Unapplied nonoptional transfers | Sales lines | Credit note lines |
|---|---:|---:|---:|---:|---:|
| HADI (1) | 416 | 466 | 117 | 61,684 | 6 |
| Beira (7) | 8 | 0 | 0 | 955 | 0 |
| HMD Kinshasa (8) | 81 | 57 | 12 | 14,609 | 3 |
| Mali (9) | 25 | 33 | 4 | 2,396 | 1 |
| GC LSHI (10) | 11 | 33 | 8 | 3,690 | 1 |
| POS Jnah (17) | 12 | 0 | 0 | 596 | 3 |
| DOHA Retail (18) | 0 | 0 | 0 | 0 | 0 |
| Zambia (19) | 4 | 0 | 0 | 0 | 0 |
| TEST (20) | 0 | 0 | 0 | 0 | 0 |

**Read-only checks passed for records examined:** no missing/foreign stock references in 83,930 sales item lines (the sum above); no duplicate current transfer voucher references; no transfer headers without item lines; no foreign transfer stock items or source/destination locations; no cross-company or missing PO voucher links when `voucher_id` is present; no negative or zero-quantity ERP sales item lines; no duplicate active non-null POS client sale identifiers; no missing/foreign stock references in existing credit note lines. These database checks do not demonstrate that every UI endpoint or reversal workflow executes successfully.

### Finding ERP2-01 — Mali stock transfer 866: applied movements, false tracking flag
Company 9, transfer 866 / voucher 15358, dated 2026-10-05. Nonoptional transfer has 58 stock_transfer_items and `inventory_applied=false`. **116** canonical movements with `source_type='stock-transfer-import-multi-source'` and `source_id='15358'` exist; net quantity is zero. The current import implementation sets `inventoryApplied: true` and posts lines together inside one transaction (`server/routes/stockTransferImportRoutes.ts`). Therefore the false flag is inconsistent with the recorded applied stock movement; it is **not evidence that stock needs to be moved again**. Requires historical authorization/audit reconstruction, and a reviewed metadata-only correction if legitimate. Do not replay stock.

### Finding ERP2-02 — Legacy unapplied transfer flags
141 nonoptional transfers are marked unapplied in companies 1,8,9,10. Only one of those (the Mali case above) was created after the canonical journal started; all others predate the respective journal starts. The older records cannot be certified from the flag alone. Avoid blanket updates and movement backfills. Current transfer route creates posted records with `inventoryApplied: !isOptional` and atomically posts stock.

### Finding ERP2-03 — HADI 55 historical PO voucher-link gaps
HADI has 55 purchase orders, all created November–December 2025, with `voucher_id IS NULL`, totaling **2,217,099.10** in `purchase_orders.items_total`. Every one has a matching container and offload. This is **not proof of missing expense or liability posting**; a linked voucher may have been absent in the original legacy workflow, and GL provenance must be checked before any backfill. `server/routes/containers/accounting/standalone-po-repair.ts` explicitly skips missing voucher links and says to use PO backfill first. Do not create duplicate postings.

### Finding ERP2-04 — Parent supplier reference is expected
Beira (8 POs), HMD Kinshasa (81), Mali (25), GC (11), Zambia (4) use suppliers owned by HADI company 1. Every one has explicit `companies.parent_company_id=1`. The current purchasing implementation supports explicit parent-company journals for subsidiaries. **Not a defect from this evidence.**

### ERP retail, returns and payments certification limits
DOHA has one retail POS sale and no retail return records in the production sample. Credits/returns/refunds and failed-payment reversals cannot be certified by merely counting production rows. Existing code tests include `tests/stock-transfer-lifecycle.test.ts`, `tests/import-regression.test.ts`, retail return/exchange suites and `tests/phase12-business-regression-suite.test.ts`. These must be run against a disposable database with exact-commit CI plus manual authorized-role tests. Zero active `reversal_of_voucher_id` entries in the checked ERP samples is not proof that reversal flows are missing, as some paths use independent journals and exact-reversal service.

## Read-only repeatability
`npx tsx scripts/audit-erp-operations-phase2.ts --company 9` produces a JSON diagnostic for one explicitly authorized company. It starts a REPEATABLE READ, READ ONLY transaction, sets `app.current_company_id` and always rolls back; `--apply` and `--repair` are refused. Run against a configured database intentionally. It is not a production repair mechanism.

## Phase 2 sign-off gates
- [ ] Verify Mali transfer 866's 116 canonical movements against locations/items, historical journal, and original import audit, then approve disposition of false flag (no stock replay).
- [ ] Classify 140 older unapplied transfer flags with archived movements/ledger provenance, no blanket metadata update.
- [ ] Prove whether 55 HADI POs' accounting is posted elsewhere; prepare signed-off source-linked, idempotent correction *only where* missing.
- [ ] Run exact-main isolated end-to-end ERP purchase → offload → stock → sale → receipt/payment → credit note/return → reversal flows for at least one linked parent subsidiary and standalone ERP; exercise permissions.
- [ ] Run POS standard and Retail variants including idempotent checkout, split tender, account credit, exchanges, returns, refund and rollback cases in a disposable test database.
- [ ] Confirm full backend and frontend CI including Main Certification and app deployment SHA.
- [ ] Re-run read-only audit and sign off any remaining exceptions.

**Status: production structural audit substantially completed. Phase 2 operational certification remains OPEN until historical provenance and executable workflow tests pass.** No production mutations authorized or performed by this report.
