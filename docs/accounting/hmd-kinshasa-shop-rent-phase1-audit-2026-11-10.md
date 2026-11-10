# HMD KINSHASA — ERP Shops rent ledger, Phase 1 read-only audit

**Date:** 2026-11-10 (as of November 10; production queried read-only).  
**Company:** HMD KINSHASA, company ID 8, ERP module, USD.  
**Source:** Render Postgres production `erp_db_qscj_64lv_e7rz_8744_2lm3`; `property_contracts`, `property_monthly_ledger`, `property_payments`, `voucher_entries`, `vouchers`, `ledger_accounts`. Tenant access scoped to company 8.  
**Branch scope:** documentation and evidence ONLY; no app changes, no database mutations, no new vouchers, no deletions.

## Conclusive primary finding: July 2026 double expense / uncleared payable

The three active contracts started 2026-01-01, bill $13,560 combined on the first of each month, and show 11 due and fully paid months (January through November). No December 2026 billing period is yet due as of November 10.

| Contract | Unit | Monthly | Jan–Nov expected | Jan–Nov posted rent | July payment ID |
|---|---|---:|---:|---:|---:|
| 15 | KINSHASA #1 (unit 40) | $4,400 | $48,400 | $48,400 | 303 |
| 16 | KINSHASA #2 (unit 41) | $6,660 | $73,260 | $73,260 | 304 |
| 17 | STAFF HOUSE (unit 42) | $2,500 | $27,500 | $27,500 | 305 |
| **Total** | | **$13,560** | **$149,160** | **$149,160** | |

Guarantees are separate from rent: $26,400 / $39,600 / $7,500 = **$73,500** across three guarantee-only payment rows (`ledger_row_id IS NULL`). Do not modify guarantees.

**July 2, 2026:** accrual voucher `9960` (`ACCR-RENT-1782986400048-mtod`) correctly posted:
- Dr Rent Expense – ERP Shops, account `877`: $6,660 (entry 45610), $2,500 (45611), $4,400 (45612) = $13,560.
- Cr Accrued Rent Payable, account `1401`: $13,560 (entry 45613).

**July 13, 2026:** July payment vouchers wrongly expensed already-accrued rent instead of clearing the payable:

| Voucher | Existing Dr entry to change in Phase 2 | Current Dr account | Amount | Untouched Cr cash entry |
|---|---:|---|---:|---:|
| `10579` KINSHASA #1 | `37980` | Rent Expense `877` | $4,400 | `37981` → CASH `352`, $4,400 |
| `10580` KINSHASA #2 | `37982` | Rent Expense `877` | $6,660 | `37983` → CASH `352`, $6,660 |
| `10581` STAFF HOUSE | `37984` | Rent Expense `877` | $2,500 | `37985` → CASH `352`, $2,500 |
| **Total** | | | **$13,560** | **$13,560** |

All three payment rows are `POSTED` and allocated to July rental-month rows (`637546`, `113144`, `637539`). The three original vouchers are live, non-optional and not deleted. Original cash credits appear valid. **Do not delete or recreate these payment vouchers.**

Balances exactly explain the screen discrepancy:

| Account | GL debit entries | GL credit entries | Net currently | Corrected net if only three wrong July debit allocations are reclassified in place |
|---|---:|---:|---:|---:|
| Rent Expense – ERP Shops `877` | $171,880 | $9,160 | $162,720 Dr | $149,160 Dr |
| Accrued Rent Payable `1401` | $54,240 | $67,800 | $13,560 Cr | $0 |
| Cash `352` | not in scope | not in scope | **do not change** | **unchanged** |

The $9,160 expense credits represent legitimate June historical AP-clearing entries; do NOT erase these credits to force a total. Account `877` has zero opening balance, and account `1401` has zero opening balance. November accrual voucher `16950` and November payment vouchers `17438`, `17439`, `17440` show correctly balanced liability settlement.

## Secondary historical conditions — review before any broad automatic repair

1. **January–May stale accrual link.** Fifteen monthly ledger rows (three units × five months), representing $67,800 of paid and due rent, reference `accrual_voucher_id = 8534`. No voucher with that ID resolves in the company-8 voucher read under the current tenant scope. This may be a stale, missing or cross-company historical link; do not infer a valid accrual or clear the reference without checking its provenance and preventing reposts. Rent expenses for these periods are already recorded by their payment vouchers.
2. **June historical control-account transition.** June accrual voucher `8537` credited account ID `918` for $13,560, while June voucher `8722` debited `918` for $4,400 and AP-clearing vouchers `8802` / `8804` debited it for $6,660 / $2,500 respectively (total $13,560). The matching amount suggests June was settled via that historical control account. Account ID `918` did **not** resolve in the company-8 ledger-accounts read. Confirm whether it is a legacy/deleted/foreign-tenant account before adjusting those historical records. Do not add its value to current payable `1401` without verified ownership.
3. The additional accounts `3865` (Rent Expenses) and `3868` (Rent Payable) belong to company 8 and show no voucher entries in the scoped rent-account query; these are not the account pairs carrying the discrepancy.
4. The existing reconciliation tool `rentalReconciliationService.ts` checks payment cache drift, future-posted payments, stale flags, dangling links, premature accrual and overdue scheduled payments, but does not explicitly catch **the double-expense condition where a settled, accrued rental month has its payment posted Dr Rent Expense instead of Dr Accrued Rent Payable**. The cash/payable summary currently totals gross accrued months without netting all original liability settlements, so it is not an accurate GL closing-liability measurement.
5. Current `rentalPaymentPostingService.ts` now chooses Dr Accrued Rent Payable for due periods with linked accrual vouchers. The wrong July vouchers are historical (`posted_by_engine=false`). The historical incorrect posting and gap in ongoing detection are verified; no claim is made that the current payment code automatically repeats it.

## Required Phase 2 change (NOT yet applied)

Use a tightly guarded, single company-8 database transaction targeting **existing entry IDs `37980`, `37982`, `37984` only**. After validating amount, original account 877, voucher ID, cash counterpart and that accrual voucher 9960 is still live:

- Change only `ledger_account_id: 877 → 1401` for these three **debit** entries; preserve IDs, debit amounts, voucher headers, dates, payment records and all CASH 352 credits.
- Verify that the linked July accrual remains exactly once, that each voucher stays balanced, that both GL account totals match the corrected rental subledger and that the accounting period is eligible for this recorded historical correction (or follow an approved auditable historical-record correction process).
- Record before/after values and actor in an audit trail. Do not change prepaid rent, guarantee, payment amounts or the November posting.
- Provide a dry-run exact match report and guard against concurrent posting or rerun; if any target does not match, abort all changes.
- Treat the January–May stale references and June historical account ownership as separately scoped diagnostics, not justification for additional blind mutations.

## Phase 3–5 follow-through

- Reconcile month-level accrual, settlement, voucher-entry account, account ownership and effective date for all 33 monthly payment allocations.
- Add a read-only diagnostic for already-accrued-and-paid months incorrectly hitting expense, missing/different-company voucher links, control-account ownership and account-vs-subledger mismatches.
- Harden direct and scheduled payment writers against the same error, preserve correct prepaid/advance paths, and add duplicate posting prevention.
- Test repeated manual/scheduled runs, November fully paid, future December billing, reversals, mixed prepaid periods and closed-period enforcement; verify account 877 at $149,160 Dr and account 1401 at $0 **conditional on no intervening transactions**.

**Phase 1 complete:** live read-only review and exact correction targets identified. **No production records changed.**
