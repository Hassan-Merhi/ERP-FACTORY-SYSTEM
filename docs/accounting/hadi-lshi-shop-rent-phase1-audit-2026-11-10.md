# HADI L'SHI ERP Shop Rentals — Phase 1 forensic accounting audit

Date: 2026-11-10 (UTC). Read-only live PostgreSQL inspection, last account snapshot 2026-11-10 12:13:46 UTC.
Company: HADI L'SHI (company_id=1); linked landlord/source: Properties company_id=13.
Branch: `audit/hadi-lshi-rent-phase1-20261110`.

## Mandate and status

**Phase 1 technical audit complete: no database mutations, corrections, new vouchers, deleted vouchers, merges or deployments.** This report is not authorization to apply accounting reclassifications. The correction amount is **not** safely determinable until the October clearing journal, old opening balance, legacy accounts and July STAFF HOUSE debt are reconciled against original evidence. In Phase 2 change original voucher **lines** only where proved; never create historic correcting vouchers, modify cash/bank lines, or alter prepaid rent.

## Reproduced account balances (HADI, company 1, active vouchers)

| Account | Debit lines | Credit lines | Opening | Closing |
|---|---:|---:|---:|---:|
| #881 Rent Expense Lubumbashi - ERP Shops | 323,750.00 | 323,750.00 | 0 | 0 |
| #1007 Rent Expense - ERP Shops | 611,600.00 | 142,250.00 | **35,000 Cr** | **434,350 Dr** |
| #1021 Accrued Rent Payable | 157,350.00 | 175,350.00 | 0 | **18,000 Cr** |
| #1022 Prepaid Rent | 67,400.00 | 84,900.00 | **24,500 Dr** | **7,000 Dr** |
| #4065 Advance Rent Paid | 2,950.00 | 2,950.00 | 0 | 0 |

**Prepaid #1022 balance $7,000 is owner-verified and must remain untouched.** Two December 2026 prepaid months ($3,500 each for Hadi #2 and Hadi #4) support the current credit. Never use prepaid-account rewrites to settle the payable.

**Live write during audit, not performed by this audit:** voucher **#17476**, created at 2026-11-10 12:11:06.804186 UTC, pays HADI #1 November rent. Its original entries are Dr Accrued Rent Payable #1021 **$4,200**, Cr SAFE #112 **$4,200**; posting correctly settled HADI #1. The screenshots predated this entry, showing $22,200 Cr; the current balance is $18,000 Cr. Other account balances listed above include #17476.

## Units and dashboard reconciliation

The Shops UI combines **11 active HADI-owned ERP contracts** and **five active shared Properties contracts** (IDs 2, 7, 8, 29, 30) belonging to company 13 but linked to company 1. This yields **16 units** and monthly rent **$28,200 + $18,000 = $46,200**.

Active HADI-owned contracts now have **$243,350** in POSTED rent payments. Shared Properties contracts have **$168,000** in POSTED rent payments (46 payment allocations; latest 2026-10-26). Combined displayed paid is **$411,350** after #17476; previously $407,150, matching the screenshot before that payment. Ended-contract history is not included in active Shops KPIs.

The remaining visible **$18,000** is November 2026 shared rent:
- company13 contract #2, ETS HADI KOLWEZI DEPOT: $2,000
- #7, ALI MOUSSA HADI #3: $5,000
- #8, BASSEL HADI #2: $5,000
- #29, ETS HADI STAFF: $3,000
- #30, ETS HADI STOCK: $3,000

All five November rows show 0 POSTED and 0 SCHEDULED November payment allocations and point to HADI accrual voucher **#16974** (Cr AP $18,000, Dr expense $18,000). Whether settled through an outside transaction requires independent proof before changing the payable. These linked contracts are owned by company13; their accrual vouchers are posted in company1 by design of `postRentAccrualForCompany()`. The linked data crosses company ownership; preserve explicit tenant scope and validate source-owner semantics in the permanent fix.

**Separate historical liability:** ended HADI company1 STAFF HOUSE contract **#26**, July 2026, has expected **$2,000**, paid **$0**, original accrual voucher **#9919**. It is excluded from the current active Shops outstanding KPI but is an accrued unpaid month in historical subledger. The $70,650 October clearing journal appears to have extinguished it along with other balances. Establish if the $2,000 obligation was forgiven, settled with a guarantee, or remains payable; do not automatically erase it.

## Original-voucher defects and interactions

### A. Eight July payment vouchers: direct rent-expense debits after accrual, **$14,650**

| Payment voucher | Original expense entry ID | Amount | Period/contract | Accrual |
|---|---:|---:|---|---|
| #9993 | #34317 | 200 | 07/2026, #18 | #9919 |
| #10234 | #35045 | 1,200 | 07/2026, #18 | #9919 |
| #10235 | #35047 | 2,000 | 07/2026, #19 | #9919 |
| #10236 | #35049 | 1,750 | 07/2026, #20 | #9919 |
| #10237 | #35051 | 1,500 | 07/2026, #21 | #9919 |
| #10238 | #35053 | 1,500 | 07/2026, #22 | #9919 |
| #10328 | #35383 | 4,200 | 07/2026, #23 | #9919 |
| #10703 | #38389 | 2,300 | 07/2026, #37 | #10701 |
| **Total** | | **14,650** | | |

All eight original payments are balanced and their cash-side credits must be preserved. Payments #9492 $1,000 and #9618 $600 for July were dated **before** July accrual and should **not** be indiscriminately reclassified. The eight listed expense lines are strong misclassification candidates **before** considering subsequent manual adjustments; they are **not** a confirmed $14,650 remaining net overstatement.

### B. Historical compensation/clearing journals

- **#8787, 2026-06-01:** Dr expense #1007 $227,750; Cr legacy expense #881 $227,750. It migrated historical activity; #881 currently nets to $0. Do not remove or reverse without reconstructing the prior ledger and opening history.
- **#8789** June HADI #1 payment Dr expense $4,200; subsequent **#8790** Cr expense $4,200, Dr legacy account #1002 $4,200. They were already paired for one reclassification; avoid double correction.
- **#8870** HADI #4 April–December payment $31,500 originally Dr expense; subsequent prepaid recognition/reclassification history exists. Prepaid must remain unchanged.
- **#11719, 2026-07-26:** Dr AP #1021 $18,000; Cr equity #960 $18,000, titled 'rent expense removed'. This cleared the July shared-contract payable via equity, not a company1 cash payment. Trace the underlying landlord company13 receipts.
- **#13386, 2026-08-31:** Dr expense #1007 $18,000; Cr Transaction Account #1197 $18,000; description blank.
- **#15110, 2026-10-01:** Dr expense #1007 $18,000; Cr HP's Rent Credit #867 $18,000; label refers to September.
- **#16664, 2026-10-26:** Dr expense #1007 $18,000; Cr HP's Rent Credit #867 $18,000; label refers to depots.
- **#15659, 2026-10-11:** Dr AP #1021 **$70,650** and Cr expense #1007 **$70,650**. At the preceding voucher (#15415, Oct 6), the running AP balance was **exactly $70,650 Cr**; #15659 **zeroed the entire AP**, including historical liabilities. It is therefore not safe to blindly change the eight July lines and leave this journal as is. The $70,650 may compensate for several duplicate costs and/or shared-contract settlements, but there is not enough contemporaneous allocation documentation to treat those motives as proven.

July shared accrual $18,000 and August–October shared accruals $54,000 must be bridged to landlord receipts in company13; monthly HADI expense automatic accruals are **already present**. Any extra $18,000 manual expenses should be assessed for duplicate recognition or separate rent obligations, not removed simply because amounts match.

### C. Obsolete/unresolved legacy control account

HADI rent-related active vouchers refer to ledger-account ID **#1002** (e.g., #8763–#8767, #8784, #8786, #8790) but a company1-scoped read did not return a matching ledger-account row. Those eight entries aggregate **$13,950 Dr / $24,450 Cr**. The account may be legacy/deleted or owned elsewhere, rather than a current visible company1 payable. Also unresolved historical account refs include #922 on #8565/#8586 (balanced) and #432 on #2813. Before any account swap, establish the true account owner, status and legacy role and confirm any entry-level constraints or triggers. No speculative replacement of account #1002 is authorized.

## Verification passed

- 193 active vouchers selected by rent descriptions and key historical voucher IDs: **0 unbalanced vouchers**.
- HADI company1 ERP payment-voucher set: all checked have balanced debits and credits, no POSTED payment with missing voucher.
- HADI company1 monthly `paid_amount` cache vs POSTED payments: **0 mismatches** in the check.
- HADI company1 accrual links to missing/deleted voucher: **0 mismatches** in the check.
- 2026-11-10 live late payment #17476 correctly Dr AP/Cr SAFE, no extra rent expense.
- Prepaid account #1022 confirmed $7,000 Dr, unchanged.
- No writes, deploys, corrections, new vouchers, or changes to original cash/guarantee records made during Phase 1.

## Phase 2 safe execution prerequisites

1. Re-run read-only account, active-contract and voucher checks immediately before editing; the production figures moved during the audit.
2. Preserve immutable before/after snapshots of affected vouchers, entries, ownership, original effective dates, net account balances, and audit reason.
3. Determine the purpose and period allocation of #15659 $70,650 and #11719 $18,000. Allocate the eight July original expense lines against these prior offsets **before** proposing a net change. Confirm whether the July ended STAFF HOUSE $2,000 was legally/operationally due or settled.
4. Check whether #13386, #15110 and #16664 represent additional rent, settlement/owner-credit movements, or duplicates of the regular $18k/month shared accruals.
5. Resolve account #1002/#922 legacy ownership or deletion and safeguard related GL history; never guess mappings.
6. Correct only proven original voucher-entry account IDs, scoped by company, voucher and entry IDs, with exact amount preconditions, cash/other account protection, double-entry postcheck and audit log. No new historical vouchers, no deleted vouchers, no prepaid mutations.
7. Fix the future-linked-company payment settlement mapping in code; existing core shop-payment posting correctly chooses Dr AP for an already-accrued *same-company* rent payment, but company13 shared rental payments do not automatically appear as company1 AP debit lines, and historical manual offsets indicate reconciliation risk. Avoid creating duplicate intercompany postings; test all source/target company cases.
8. Check invariants: company1 AP = genuine open accrued rent including ended-contract historical balances after documented dispositions; each rent month recognized at most once; both rentals and GL show consistent amounts; preserve all cash, prepaid, guarantees and audit trails.

**Phase 1 conclusion:** GL figures and UI calculation are reproduced. Current $18k AP reflects five November linked lease rents with no November payment records; no automatic deletion is justified. Rent expense $434,350 is reproduced but **cannot be declared correct or assigned a safe final correction amount** solely from GL totals, because compensating manual entries and the old $35k credit opening must be apportioned. The report supplies exact evidence for a guarded Phase 2 rather than a risky blind reclassification.
