# Company 12 historical supplier reconciliation — account classification and alternate lineage

**2026-11-02. Backend-only read-only evidence. No account classification updates, journal entries, voucher edits or data migrations.**

The company-12 historical supplier backfill audit now also checks ledger account classifications and related ledger journal pairings, because those classifications may affect reported expenses *independently* of whether the October 14 supplier expense entries were duplicates.

## Verified from source-code account contract and production database

| Account code | Saved account type | Accounting contract | Posted, live debit | Posted, live credit | Live posted vouchers |
| --- | --- | --- | ---: | ---: | ---: |
| FACTORY_CHARGES_PAYABLE | Direct Expense | Liability (systemAccounts.ts) | $381,581.45 | $0.00 | 225 |
| FACTORY_RAW_MATERIAL_STOCK | Indirect Expense | Asset (factory inventory accounting and raw-stock writer) | $3,288.00 | $0.00 | 4 |

The earlier snapshot aggregating **all** voucher lines (including non-posted/deleted/optional) gave Factory Charges Payable $383,682.49 debit, $1,692.96 credit, net debit $381,989.53. **Do not use that broad snapshot as the active posted voucher balance**. The live non-deleted non-optional filter instead shows $381,581.45 debit and no credits as of the latest read-only query. Reporting cutoff dates and historical source documents still require validation.

### Pairing of live Factory Charges Payable entries

| Counterparty account | Current type | Paired credit |
| --- | --- | ---: |
| WALMDACLE | Liability | $187,191.92 |
| FREIGHT | EXPENSE | $162,676.50 |
| IMPFRE | Loans | $14,251.40 |
| EMBSHI | Liability | $9,707.66 |
| EMBEUR | Liability | $7,753.97 |
| Total | | **$381,581.45** |

These are voucher counterparties, **not** a proof of double-booked costs, recoverable assets, or a safe net expense reversal. In particular, the credit to FREIGHT is part of the existing historical journal structure, so changing only FACTORY_CHARGES_PAYABLE's account type could cause an unverified P&L effect. The ledger account catalog should not be silently rewritten to force a desired reported profit.

## Alternative production lineage inspected

- 1,175 distinct bales with nonvoided pressing confirmations (snapshot, can change).
- 21,185 distinct bales with worker production-attribution records.
- 31,861 bales with historical cost-repair records.
- 0 distinct mix batch IDs recorded in factory_daily_usages for company 12.
- 0 distinct bale IDs in factory_pos_sale_bales for company 12.
- No direct mix_batch_id or pressing_batch_id was saved in the 45k+ active factory_bales records in the earlier production review.

Pressing confirmations, worker attribution and bale-cost repairs identify **bales**, but do not establish the exact originating mix batch, source container, supplier, production material unit cost, or historical end-user sale for the same bale. They are evidence, not a license to fabricate links. The audit reports their coverage without guessing joins or changing history.

## Financial correction gate

1. Reconcile all individual paired historical charge journals, including whether the FREIGHT credits reverse previously accrued freight.
2. Establish the approved accounting meaning of FACTORY_CHARGES_PAYABLE and FACTORY_RAW_MATERIAL_STOCK, their period treatment and existing GL contra postings.
3. Reconstruct historical sale source-to-bale identity with authoritative production evidence, or explicitly classify gaps as untraceable.
4. Produce balanced preview entries with an independently proved account/amount and no supplier, customer, cash, bank or stock-quantity mutations; compare trial balance, income statement and balance sheet.
5. Until that evidence is complete, leave all financial changes **blocked**. The backend report's proposedAccountTypeChange and proposedVoucherCorrection fields are intentionally null.

**Execution:** `npx tsx scripts/audit-historical-factory-suppliers-20261102.ts` from an authorized backend shell. This accepts no parameters and runs within a repeatable-read read-only transaction. It is not a public ERP page or background job.
