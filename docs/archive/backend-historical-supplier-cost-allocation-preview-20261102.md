# Company 12 historical supplier cost allocation — backend preview (November 2, 2026)

This extends the private read-only audit in `scripts/audit-historical-factory-suppliers-20261102.ts`. It adds **no public route, UI, migration, scheduled job, voucher writer, supplier balance editor or accounting mutation**. Execute only from a trusted backend shell using:

    npx tsx scripts/audit-historical-factory-suppliers-20261102.ts

The command rejects `--apply` and all other arguments, runs inside one REPEATABLE READ READ ONLY database transaction and outputs JSON to stdout. Its `costAllocationPreview` key is evidence, **not** an approved adjustment.

## Production evidence verified with SELECT-only queries

| Check | Observation |
| --- | ---: |
| Backfill goods vouchers | 38 |
| Goods expense debits posted | USD 356,942.28 |
| Backfill commission vouchers | 48 |
| Commission expense debits posted | USD 32,500.00 |
| Goods vouchers matching saved containers/FX/supplier | 38 of 38 |
| Commissions matching saved supplier, amount and currency | 48 of 48 |
| Balancing failures across 86 vouchers | 0 |
| Goods containers with positive raw remaining | 8 |
| Goods containers with no positive raw remaining | 30 |
| Current positive remaining source raw stock | 136,971 kg / USD 124,451.43 |
| Separately overused raw stock record (container 23 / Germany) | 3,516 kg |
| Goods containers traceable into mixes | 32 |
| Distinct related production mix batches | 143 |
| Source rows tracing material from containers to these mixes | 252 |
| Source-linked mix weight from these containers | 614,026 kg |
| Shared linked-mix positive unused weight (operational snapshot) | 126,097 kg |
| Shared linked-mix current WIP cost in factory records | USD 88,208.12 |
| Active factory bales with direct mix id | 0 |
| Active factory bales with pressing batch id | 0 |
| Active factory bales in the company | 45,514 |
| Factory pressing batches with saved mix id | 0 |
| Company 12 applied perpetual-inventory cutover | none found |
| Matching factory daily stock GL journals | none found |

**Critical limitation:** The raw values, WIP values and mix source costs do NOT reconcile directly to the October import voucher amounts. Mix source costs can use supplier-average or landed cost and may include other charges, and a single mix can contain material from multiple containers. The 143 mix current-WIP total is shared, not allocated per container. It must not be added to raw stock as a historically verified supplier-correction amount.

The 45,514 active bale records lack both direct mix and pressing-batch IDs. Consequently, the available database cannot tie any of the source mixes to specific unsold/sold bales. No amount may be assigned to Cost of Goods Sold or finished goods from these joins.

## Required behavior of the private preview

For each historical voucher, include its source identity, status, supplier, native/USD amount, current raw KG and cost valuation, linked source mix count/KG/source cost, physical receipt evidence and suspect dates. For goods, the cost allocation preview explicitly shows `workInProgressCostUsd: null`, `finishedGoodsCostUsd: null`, `soldCostUsd: null` and `verifiedOverstatedExpenseUsd: null` until provenance is independently proven. For commissions, mark landed-cost/expense treatment unresolved.

The current operational values are diagnostic-only, **not** proof of the GL expense to reverse. Every `proposedGLCorrection` and `proposedSupplierAdjustment` remains null. If proof is insufficient, the preview must fail closed rather than guess or generate financial postings.

## Before any real accounting change

1. Reconstruct the source-to-bale chain from authenticated historical factory operations (pressing logs, production snapshots, validated stock moves), or identify and document untraceable periods.
2. Check actual prior recognition in original GL and financial opening balances, including any legacy inventory policy, not merely the currently applied perpetual cutover state.
3. Verify commission capitalization policy and source costs versus freight/clearance, so separate landed charges are not counted twice.
4. Reconstruct the period-end inventory / work in progress / finished stock and sales COGS with signed source evidence before establishing any correction amount or GL offset account.
5. Review a proposed GL-only journal which has **no supplier, customer, cash, bank or stock-quantity lines** and prove that both supplier combined balance and the trial balance remain unchanged (other than approved reclassification). Keep immutable audit links and ability to reverse.

Until those conditions hold, **financial adjustments: ZERO**. This does not mean the $389,442.28 is correct; it means there is no proven safe adjustment yet.
