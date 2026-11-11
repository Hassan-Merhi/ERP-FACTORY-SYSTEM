# ERP Phase 4 — Confirmed defect remediation, 2026-11-11

**Scope:** ERP company accounting, stock, purchasing, sales and permission exceptions, not independent Factory or Properties work. No production mutations were performed. These findings are current-snapshot and source-review evidence, not an executed end-to-end certification.

## ERP4-01 — Canonical stock transfer reconciliation masked import evidence and stale flags

**Confirmed source defect:** `loadDatabaseStockTransferDocuments` previously required `inventory_applied=true`, even though the post-journal Mali import transfer 866 has 116 legitimate movement legs while that flag is false. `loadDatabaseCanonicalStockTransferEvidence` previously read only `source_type='stock-transfer'` where `source_id=transfer.id`. The two ERP import workflows instead write `source_type='stock-transfer-import'` and `source_type='stock-transfer-import-multi-source'`, both keyed by voucher ID.

**Additional complication, caught during production simulation:** Edited ordinary transfers contain historical issue/reverse generations under the same `stock-transfer` source identity. **Some immutable revision approvals record delta movements only** (not replacement full quantities), so selecting just the latest issue revision is ALSO wrong. Current stock is the signed net at the destination across ALL batches. For example HADI transfer 779 had `rev0` issue, `rev73` reversal/reissue, and `rev219` reversal/reissue batches. The canonical journal must not delete any of these history records.

**Proposed nonposting code change:**
1. Load every active, nonoptional, post-journal transfer regardless of its `inventory_applied` flag.
2. Join canonical evidence by the verified document pair `(transfer_id, voucher_id)`: ordinary transfer rows via transfer ID, both import forms via voucher ID; normalize their reporting identity to transfer ID.
3. **Retain every complete and delta revision** and reconstruct current inventory as the signed sum of movement legs at the transfer destination. A full edit reverses old stock and reissues replacement; immutable approval revisions write only their signed delta. Group each idempotency batch and validate precisely two equal-and-opposite legs of the same item/cost before adding its signed destination contribution. This catches missing/corrupt movement pairs without hiding legitimate reversals.
4. Preserve the document's applied flag in the stock snapshot and add `STOCK_TRANSFER_APPLIED_FLAG_MISMATCH` to the ordinary read-only reconciliation discrepancies when false or null.
5. Existing canonical balanced-leg checks remain authoritative. No inventory, document, or accounting records are written by the reconciliation.

### Read-only production simulation of proposed movement selection

Companies: HADI=1, HMD Kinshasa=8, Mali=9, GC LSHI=10. Only active, nonoptional, post-canonical-journal transfer records were counted. A quantity/value exception below is based on exact document quantity or more than 0.01 difference in raw value. The deployed convergence comparator currently uses exact decimals, so smaller differences can also be reported.

| Company | Post-journal transfers | Missing evidence | Quantity/value exceptions (>0.01 in value or any qty difference) | Unbalanced issue/receipt | False applied flag with evidence |
|---|---:|---:|---:|---:|---:|
| HADI (1) | 101 | 0 | 11 | 0 | 0 |
| Kinshasa (8) | 10 | 0 | 0 | 0 | 0 |
| Mali (9) | 24 | 0 | 2 | 0 | 1 |
| GC (10) | 12 | 0 | 0 | 0 | 0 |

**Mali transfer 866 / voucher 15358:** 58 item lines, document quantity 102 and value 10509.98, canonical 116 issue/receipt legs, receipt quantity 102 and value 10509.98, net quantity 0, but `inventory_applied=false`. This is tracking metadata inconsistent with movement evidence; **do not replay stock**. A separate, approved exact metadata-only correction is appropriate only after source audit.

**Remaining document mismatches:** HADI transfer IDs 787, 811, 825, 833, 838, 846, 847, 890, 893, 896, 928 (transfer 893 is value-only). Mali transfer IDs 900, 927 (both ~0.01 cost differences). These require per-stock-item canonical history and edit lineage before any correction. Under the correct signed-destination aggregation, HADI has **8 quantity** mismatches and **11 value** mismatches above 0.01. HADI transfer 846 item 515 remains a 350-unit document-versus-journal gap. Across the four examined companies, all **9,489 canonical transfer idempotency batches** have exactly two opposite legs, matching item IDs and rates, and two distinct locations. An apparent mismatch may be historical line edit or costing precision, not missing physical stock.

## ERP4-02 — Historical HADI voucher ledger account ownership (Phase 1 carryover)

Eight posted HADI voucher-entry rows previously verified to point to account IDs owned by company 13; seven other HADI references are unresolved, and one posted line has no recognized posting target. No economic entries have been remapped. In this Phase 4 investigation `ledgerIntegrityGuard.ts` was inspected: it explicitly rejects a new or retargeted ledger entry whose account company differs, but intentionally leaves existing rows untouched. The live database has an **enabled** `voucher_entries_target_guard` trigger, plus ledger delete/tree guards. Thus blanket new trigger installation or historical account relinking would be counterproductive. Historical source-ledger provenance is required before correcting the old rows. See issue #3132 and draft PR #3131 for the separate accounting-adjustment work.

## ERP4-03 — Historical HADI purchase order source linkage (Phase 2 carryover)

55 HADI purchase orders from November–December 2025 have no `voucher_id` link but all have container/offload evidence and summed `items_total` approximately USD 2,217,099.10. This does **not** prove a missing historical journal, and a blind source backfill could duplicate costs or liabilities. See issue #3135. No production voucher creation/relinking approved.

## ERP4-04 — ERP user permission metadata (Phase 3 carryover)

One duplicate HADI company-role pair, 20 TEST company ERP page-grant rows without matching company role; no mutation. Draft PR #3140 contains membership/atomicity guards for future permission updates; no Phase 4 duplication or conflicting changes. See issue #3141.

## Tests and certification

New source tests: `tests/erp-phase4-stock-transfer-convergence.test.ts` covers movement-source pair query, full-edit and delta revision netting, paired-leg validation, posted false flag inclusion, missing evidence, and discrepancy reporting. Existing suites `tests/canonical-stock-transfer-journal.test.ts`, `tests/convergence-evidence-loaders.test.ts`, `tests/stock-transfer-lifecycle.test.ts` must pass on the exact final PR SHA.

**Exit criteria still open:** Run targeted tests/typecheck/full CI, validate document and item-level historical mismatches on a disposable fixture, approve any metadata-only update for transfer 866 after audit, resolve Phase 1/2/3 historical blockers with original evidence, and verify deployed SHA. Do not merge or deploy on simulated evidence alone.

**Status:** The repeatable reconciliation code remediation has been prepared for review. Historical data reconciliation and full Phase 4 certification remain OPEN.
