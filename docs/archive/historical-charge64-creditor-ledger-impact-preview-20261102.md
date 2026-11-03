# Charge 64 / Container 83 — named-creditor correction impact, read-only (2026-11-02)

## Executive determination

The June 17, 2026 post-offload charge #64 on company 12 container #83 has TWO active, balanced vouchers for the same underlying charge. The original extra entry #9309 is **USD 1,692.96**, and the retained backfill #9341 is **USD 1,692.00**. Both debit `FACTORY_CHARGES_PAYABLE` (currently misclassified as Direct Expense) and credit the GL liability `WALMDACLE` (WALID MDAWAR CLEARANCE).

The factory daybook event #14136 and linked source charge #64 are **USD 1,692.00**, exactly matching the retained backfill voucher. A verified historical correction voucher #15976 (Dr WALMDACLE / Cr FACTORY_CHARGES_PAYABLE for USD 1,692.96) was posted October 14 and soft-deleted October 19. **It is not currently an active offset.**

An original source-voucher audit event dated June 17 records that the original amount was edited from USD 1,692.00 to USD 1,692.96. The correction deletion has a recorded audit event, but its `reason` is **null**, so the business reason for removing the October offset is not verified. This must not be bypassed by restoring/reposting the deleted voucher.

## WALMDACLE creditor exposure at the inspected production snapshot

| Measurement | Before any new correction | Hypothetical exact $1,692.96 GL-only reversal |
| --- | ---: | ---: |
| Active GL debits to WALMDACLE | $228,261.00 | $229,953.96 |
| Active GL credits to WALMDACLE | $227,277.66 | $227,277.66 |
| Posted net debit excluding opening balance | **$983.34** | **$2,676.30** |
| Independently saved opening balance, debit | $1,691.20 | $1,691.20 |
| Arithmetic net debit including saved opening (NOT proof of statement total) | $2,674.54 | $4,367.50 |
| Active GL debit to FACTORY_CHARGES_PAYABLE | $381,581.45 | $379,888.49 |
| Reported expense difference, only if that account remains Direct Expense | — | **$1,692.96 less expense** |
| Supplier-party/customer/bank/stock-quantity voucher legs | Unchanged | Unchanged |
| **Named GL creditor liability** | Existing position | **Changes by $1,692.96** |

The opening-inclusive figures above are only Dr-minus-Cr arithmetic. They may differ from the application's statement due to booking conventions, settlements, memo balances, other accounts and date cutoffs; no formal creditor statement was reconciled.

A distinct WALMDACLE debit **payment voucher #16639 for $10,000.00 dated October 26** was confirmed after the correction was deleted. The GL creditor currently has an active posted *debit* balance even before including its separately saved debit opening. Any new adjustment might affect overpayments, recoveries or a wrong creditor balance. This is not safe to post without an independently reviewed creditor reconciliation and settlement check.

Company 12 has no records in `accounting_fiscal_reviewed_closures` at the investigated snapshot; that does NOT mean arbitrary retrospective posting is authorized or prior periods are open.

## Why this is NOT a $389,442.28 supplier backfill reversal

The charge #64 duplicate is independent of the October 14 backfilled 38 goods-voucher expenses ($356,942.28) and 48 commission-voucher expenses ($32,500.00). It is one identified erroneous extra source posting. No change is authorized to supplier master balances or the historical backfill.

The possible offset must be a **newly reviewed, source-specific GL journal**, never a simple delete of voucher #9309, revival of deleted #15976, re-execution of the old batch, a reclassification of the entire $381,581.45 account, or a bulk reversal of $389,442.28. If eventually approved, the described economic effect is *debit WALMDACLE and credit FACTORY_CHARGES_PAYABLE*, which **does change a named creditor balance**. It must be compared against any supplier/creditor statements and monthly P&L and balance sheet before posting.

## Implemented in this branch

The existing manual `scripts/audit-historical-factory-suppliers-20261102.ts` gains `accountClassificationAudit.charge64CreditorImpactPreview` using a pure, nonposting helper:

- confirms all three historical voucher IDs and balanced GL account legs, including the deleted correction;
- joins company-specific active posted ledger lines (no deleted/optional entries) and independently recorded opening balance;
- reads the original daybook, June voucher edit audit, October correction deletion audit, last identified WALMDACLE payment and reviewed-closure count;
- calculates **only counterfactual** creditor/expense positions using precise decimal arithmetic;
- fails closed on modified source evidence and always returns `readyToPost=false` and `proposedJournal=null`;
- exposes explicitly that no direct supplier-party lines are modified **but a named creditor would change**.

This code is not a voucher writer, does not run at startup, and has no UI or API route. It is intended for private backend execution in the existing repeatable-read, read-only audit transaction. Pure unit tests are supplied. Actual financial changes remain blocked by source, deletion-history and creditor-settlement signoff.
