# Company 12 historical supplier catchup — internal posted reconciliation, not routine Journal vouchers (2026-11-02)

## Owner requirement
The company-12 supplier and named-creditor balances are correct and must not change. The October 14 historical goods/commission catchup records should no longer clutter ordinary voucher and Daybook browsing as manual "Journal Vouchers". This is a **presentation classification only**, not a cancellation of posted expenses.

## Exact protected source cohort
The existing 86 active Journal vouchers were posted October 14, 2026:
- 38 goods vouchers with the exact `FACTORY-IMPORT-<container>-<generation>` identity **and** the source-specific description `Goods import - container ... (historical supplier reconciliation)`, $356,942.28.
- 48 commissions with the exact `FACTORY-COMM-<container>(-<generation>)` identity and `created_at` on October 14, 2026, $32,500.
- Total recorded historical reconciliation: **$389,442.28**. The source-identity SQL matched exactly **38 + 48** in BOTH accessible company-12 databases; other routine current purchases and commissions are not included.

The same exact predicate is used for:
1. unpaginated /api/vouchers routine list;
2. paginated /api/vouchers routine list, applied in SQL before counts/offset;
3. paginated /api/daybook and All Daybook, including continuous cursor and routine exports;
4. Factory Daybook synthetic voucher rows, paginated and legacy unpaginated.

**Original source-backed factory daybook events remain visible**, as they are operational source documents and not the duplicate synthetic "Journal" display. No visible history is silently rewritten. There is no new arbitrary "hide voucher" switch, no hiding unrelated future/current journals and no generic developer bypass for the internal batch.

## Mandatory accounting evidence and balances retained
This filter MUST NOT be used for:
- official posted voucher tables and voucher_entries;
- supplier, creditor, customer, bank and cash statement calculations;
- General Ledger, trial balance and formal P&L/Balance Sheet;
- audit logs, direct-voucher evidence access, formal accounting exports, reconciliation scripts and compliance history;
- historical posting, valuation or reconciliation job calculations.

The existing original vouchers, all ledger legs, and their accounting date remain posted. Do **not** set `optional`, `deleted_at`, change `voucher_type`, `is_hidden`, edit a supplier opening or force a creditor-neutral reversal. The $389,442.28 expense recognition remains separately under investigation, **not erased from financial results**.

A routine voucher screen no longer enumerates these system backfills. The routine voucher count and filtered export exclude them so pagination/exports are consistent. Official accounting must continue to expose/reconcile the complete entries to anyone authorized to audit.

## Additional report issue — independent of this view cleanup
At November 2, 2026, `/api/stats/net-profit` currently loads ALL future-dated vouchers if `toDate` is absent. Two goods-reconciliation imports alone have combined expense **$15,465.32** dated November 11 and December 11. They should not be recognized as incurred in a November 2 as-of P&L. **Do not change posted vouchers or supplier balances to solve this**; fix report as-of logic independently, keeping financial statements and historical date selections correct.

## Validation
- SQL batch-selection count independently verified read-only: 38 goods and 48 commission in each database.
- Tests verify exact batch signatures, other-company isolation and future-dated goods classification.
- No ERP accounting transactions, supplier balances, stock costing or ledger account classifications were modified.
- Full CI/test execution must be separately confirmed; source-level checks alone are not a passing test run.
