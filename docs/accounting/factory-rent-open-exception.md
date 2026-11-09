# Factory rent accounting: open November 2026 recognition exception

## Scope and non-negotiable balance

Company 12 (HMD INT GROUP - BEIRUT / Factory Mode), contract 40, **WAREHOUSE 5001**, monthly rent **USD 1,416.67**. The production snapshot checked November 9, 2026 is:

| Account | Ledger account | Posted GL balance |
| --- | --- | ---: |
| Prepaid Rent | 2202 | **USD 29,566.66 debit — owner-verified, do not change** |
| Rent Expense - Factory Shops | 868 | USD 228,833.34 debit |
| Accrued Rent Payable | 2220 | USD 20,000.00 credit |

These are the balances **after** the approved Factory rent cleanup in PR #3057. The cleanup retired duplicate September accrual voucher **13139**, retained September accrual **14317** and original rent payment **14318**, corrected October's voucher **10544** description, and aligned unpaid November Main Factory row with payable journal **16951**. None of those changes touched the Prepaid Rent account. The one-time repair environment switch is disabled.

## Unresolved Warehouse 5001 November month

* Contract 40 started **September 9, 2026**; under the system's billing-day rule, the November period became due **November 9, 2026**.
* Rental monthly ledger row **889178** (November 2026) records **USD 1,416.67 paid**, **USD 0 expected**, `used_prepaid_account=true`, and **no `accrual_voucher_id`**. The payment was already made in voucher **14318**.
* The original September and October recognition records are linked to their own monthly rows; they are not substitutes for November.
* Normal due-period recognition would debit Rent Expense and credit Prepaid Rent for USD 1,416.67, reducing Prepaid Rent to **USD 28,149.99** if there were no other changes. **That violates the owner's explicit requirement to preserve USD 29,566.66.**
* Do **not** invent a balancing liability, reverse unrelated cash entries, post a replacement journal, or reassign a prepaid line without reconciling the contract, payment and account sources first. No new correction voucher was authorized.

## Implementation guardrails

1. The accrual engine in `server/routes/rental/shared/accrual-posting.ts` now locks each company/module rental row and refuses to post an already linked or legacy-orphaned accrual.
2. The prepaid recognition pass in `server/routes/rental/shared/accrual.ts` excludes zero-expected monthly rows. This prevents a zero-dollar voucher from silently stamping the missing November entry.
3. The production database now has an audited `[RENT_RECOGNITION_HOLD]` note on company 12 / contract 40 / monthly row **889178**. Both the monthly due scheduler and the transactional posting boundary refuse recognition of held months. This was verified live on November 9, 2026 with Prepaid Rent still USD 29,566.66.
4. The one-off installer and temporary company/row bootstrap guard were removed after the persistent note was confirmed. Future protection uses the same note-based mechanism for any explicitly reviewed rental month; it does not rely on permanent hardcoded company 12 exceptions.
5. Preserve the existing prepaid debit, payment voucher and all original evidence until a reviewed explanation establishes a **legitimate** balancing source. Any later remedy must be reviewed for its effect on all three GL accounts and Net Position.

## Required checks before closing this exception

* Confirm the contractual monthly charge, lease dates and rental-period policy for contract 40; explain why the November `expected_amount` is zero while payment is USD 1,416.67.
* Reconcile Prepaid Rent #2202 transaction by transaction against all rental contracts and Net Position, not just its grand total.
* Determine whether a genuine previously unrecognized credit, expense reclassification or monthly allocation explains the USD 1,416.67 mismatch **without moving Prepaid Rent**. If no such source exists, explain the accounting conflict to the owner; do not manufacture an offset.
* Validate monthly expense, payable, the unchanged USD 29,566.66 prepaid balance, existing cash and all rental-month voucher links after any separately approved correction.

**Status:** unresolved by design; no change to Prepaid Rent or November Warehouse 5001 accounting until the evidence supports a balanced, authorized correction.
