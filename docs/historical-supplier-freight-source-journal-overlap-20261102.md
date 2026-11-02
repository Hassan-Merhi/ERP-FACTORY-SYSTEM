# Historical supplier import / freight journal overlap preview — November 2, 2026

**Company 12, production SELECT-only verification. No existing voucher, supplier balance, inventory cost, bank, customer or account type is changed.**

This extends the private backend-only audit `scripts/audit-historical-factory-suppliers-20261102.ts`. The script runs manually using a repeatable-read read-only PostgreSQL transaction scoped to company 12. No new UI, route, scheduler, database tables or write methods were added.

## Exact same-prefix import voucher check

All **38 historical supplier goods** source containers were compared to other nondeleted, nonoptional `FACTORY-IMPORT-{containerId}(-...)` vouchers. **Zero** other active voucher IDs for those same containers were found. This disproves a specific same-prefix duplication hypothesis only. It does NOT prove an identical purchase was not previously recorded under another source code, ledger, stock opening or prior period.

## Freight pairing for the exact 38 source goods containers

| Diagnostic classification | Containers |
| --- | ---: |
| Source goods containers | 38 |
| With at least one active freight-prefixed voucher | 34 |
| With exact FREIGHT account Dr/Cr offsets | 16 |
| Total exact FREIGHT-account matched offset | USD 35,824.80 |
| With FREIGHT Dr and Cr that do not match | 1 |
| With FREIGHT debit but no matching credit | 1 |
| With freight-prefixed vouchers using other ledger accounts, no FREIGHT Dr/Cr | 16 |
| With no freight-prefixed voucher | 4 |

Example: container **122** has FREIGHT debit $1,750 and credit $2,065 (difference -$315) and a Factory Charges Payable debit $2,065. Container **102** has FREIGHT debit and credit both $2,065 and a Factory Charges Payable debit $2,065. These entries establish accounting pairing, not that $2,065 can safely be removed from cost.

The other-ledger group includes `FACTORY_FREIGHT_EXPENSE` and `IMPFRE`, often with a nonledger/party counterpart. A zero in the FREIGHT account cannot be interpreted as absent freight cost.

## Safety of the new report

For each **goods** voucher, the report adds a `freightOffsetReview` with freight debit/credit, charge clearing debit, original source ledger codes, extra same-prefix import count and reason flags. Every report sets:
- `isProvenOverstatement: false`
- `proposedCorrectionAmountUsd: null`
- `proposedGLPosting: null`
- `supplierMovement: null`

The top-level audit continues to withhold verified expense overstatement and proposed GL corrections. No routine in this change supports `--apply`.

A matched FREIGHT debit/credit pair is not proof the entire clearing debit is wrong, nor an inventory asset to capitalize. Before correction, reconcile invoice/receipts, prior GL cost recognition, container landed-cost policy, and the actual counterpart accounts and periods. Keep suppliers untouched and do not classify unknown amounts as profit.
