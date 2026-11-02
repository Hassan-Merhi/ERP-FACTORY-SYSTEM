# Historical post-offload source/voucher lineage check — 2026-11-02

Company 12, production **SELECT-only** inspection. This is a new private section in the existing `scripts/audit-historical-factory-suppliers-20261102.ts` report, not an accounting repair, public API, user-visible ERP screen or automatic job.

## Verified active POC voucher to charge linkage

- **146** nondeleted, nonoptional POC vouchers.
- **146/146** voucher numbers parse to an existing, company-scoped source-charge ID in `factory_offload_additional_charges`.
- **145/146** source rows point back to the identical original voucher ID; their **native-currency voucher header amount also matches the corresponding source charge amount**.
- **0** container ID mismatches and **0** source-to-voucher currency-code mismatches.
- **74** source rows have a non-null `supplier_inventory_value_delta_usd` field. That is an operational costing/cascade delta, **not proof a GL inventory asset was recognized**; do not sum or capitalize it as a financial journal.
- One record requires document-level review: voucher `FACTORY-POC-83-64-1781674089261` (voucher ID **9309**, container **83**) is still active with original native header amount **USD 1,692.96**. Its parsed source charge **64**, description **CLEARANCE & SHIPPING WALID**, currently records **USD 1,692.00**, and links to voucher ID **9341** rather than 9309. The source charge `updated_at` is **2026-07-18**, later than the original 2026-06-17 voucher creation.

The existence of a stale or moved `voucher_id` reference, and the **USD 0.96 native source drift**, do **not** independently prove another expense was booked or that an active voucher should be voided. The charge table does not enforce a foreign key for its voucher link. A source edit may have occurred after posting. Keep the active voucher and original link history unchanged pending exact source/reversal review.

### Native vs USD amount

Historical POC `vouchers.total_amount` represents the native header amount and matches the charge's `amount` for all 145 linked vouchers. Comparing that header value to `amount × fx_rate_to_usd` yields false-positive differences for some source currencies. Base USD ledger debits must instead be examined from `voucher_entries` with the posted exchange rate and period.

## Change made

The private report now includes `accountClassificationAudit.postOffloadSourceEvidence` with active source match counts and a small exception list. The pure helper `inspectHistoricalPostOffloadLink` flags a missing charge, wrong container, stale voucher link, native amount or currency change, or deleted source. It never claims an expense duplicated merely because source metadata drifted.

For every anomaly, `isDuplicateProven=false`, `isExpenseOverstatementProven=false`, and `proposedGLCorrection=null`. No schema, data, account, supplier, stock, bank, employee, cash or voucher changes have occurred.

## Remaining correction gate

- Reconstruct the history around charge 64 and voucher IDs 9309 / 9341, including any approved correction journal or overwritten/deleted voucher references.
- Reconcile POC source business category and each historic landed-cost versus GL expense treatment.
- Reconcile historical inventory, unfinished production and sold bales before classifying paid costs as assets or COGS.
- Require independently reviewed supplier-neutral, period-accurate balanced GL journal candidates and trial balance / balance sheet / P&L before any live adjustment.

No financial mutation is approved by this release.
