# HADI L'SHI — 2026 original rent-accounting restoration with dated journals

**Owner decision updated 2026-11-10:** The earlier $35,000 Cr Rent Expense opening was an artificial balancing entry, **not genuine opening rent**, and the owner now permits **new correction journal vouchers dated to the relevant 2026 accounting month**. No reconciliation page/section. Maintain cash, the original payment vouchers, current Rent Expense $434,350 Dr, Accrued Rent Payable $18,000 Cr and Prepaid Rent $7,000 Dr.

**Production SQL delivery:** A separate downloadable, guarded `.sql` file is supplied alongside this audit in the same ChatGPT response, named `2026-11-10-hadi-lshi-monthly-rent-original-voucher-restatement.sql`. The SQL is not executed or deployed by this documentation commit. It must be applied as **one atomic TablePlus transaction** in the verified ERP production database, with the final `PASS` row checked.

## Verified original source evidence
- HADI ERP company 1; linked Hassan Properties 13. Voucher #6497 credits legacy ledger #276 and must not be called a direct cash disbursement; #8870 credits SAFE #112.
- The surviving Rent Expense #1007 has artificial opening **$35,000 Cr**. Old account #881 is retired/inactive, **$0 opening**, Dr and Cr gross movements each $323,750. Its original entries are included in the canonical accounting ledger but were missing from the existing monthly-ledger report; the adjacent source change fixes that real report discrepancy **without adding a reconciliation section**.
- $24,500 of the artificial expense opening was posted 2026-11-06 solely to balance an artificial Dr $24,500 Prepaid Rent opening #1022. This was originally requested **without journals**. The owner's new instruction authorizes replacing this artificial adjustment with dated source-linked journals.
- The remaining $10,500 credit was manually created 2026-06-08 by `dev`, audit log #2008.
- Original voucher **#8786** dated 2026-06-01: Dr Rent Expense #1007 **$3,500** each for HADI #4 April, May, June (entry IDs 30194–30196) and $4,200 for HADI #1 June (30197); Cr obsolete legacy payable #1002 **$14,700** (entry 30193).
- Original #8790 dated 2026-06-05: Dr obsolete payable #1002 **$4,200** (entry 30204), Cr expense #1007 $4,200 (30205), settling the related HADI #1 rent payment.
- Original **#8870** dated 2026-06-08: Dr expense #1007 **$31,500** / Cr SAFE **$31,500**, for HADI #4 **April–December ($3,500/month)**. April–June $10,500 had **already been accrued in #8786**, July–December $21,000 is prepaid; this is why the developer-added $10,500 credit was compensating for a duplicate, not real opening rent.
- Original **#6497** dated 2026-01-01 is a payment-type voucher (not a SAFE cash movement): Dr old expense #881 **$42,000** / Cr legacy ledger account #276 **$42,000**, for HADI #2 January–December. February–October were already reclassified through Jan-dated originals, but November–December prepaid **$7,000** and November consumption **$3,500** were missing.
- The legacy #1002 referenced by June vouchers currently has **$24,450 Cr / $13,950 Dr**, net **$10,500 Cr**, and has no current company1 account row. Moving original #8786/#8790 references to real payable #1021 and settling the $10,500 through dated #8870 allocation eliminates this legacy net **without changing real payable #1021's $18,000 Cr closing**.
- Original #27 HADI #4 April–June rental months link to #8786, keep them; original #24 HADI #2 November row ID 128505 is missing its prepaid recognition marker, which the repair will stamp against the new November 1 journal.

## Dated correction voucher plan (cash never touched)

| Correction voucher | Accounting date | Debit | Credit | Amount |
|---|---|---|---|---:|
| HADI26-RENT-JAN-ADV | Jan 1, 2026 | Prepaid #1022 | Rent expense #1007 | $7,000 |
| HADI26-RENT-JUN-ADV | Jun 8, 2026 | Payable #1021 $10,500; Prepaid #1022 $21,000 | Rent expense #1007 | $31,500 |
| HADI26-RENT-NOV-REC | Nov 1, 2026 | Rent expense #1007 | Prepaid #1022 | $3,500 |

In the same transaction: move the **original** voucher-entry ledger ID #30193 from legacy payable #1002 to #1021 (Cr $14,700) and original entry #30204 from legacy #1002 to #1021 (Dr $4,200); do not alter their amounts/dates, other entries or the cash voucher entries. Set opening #1007 **$35,000 Cr → $0**, opening #1022 **$24,500 Dr → $0**, keeping both closing balances and full currency metadata correct.

Then generate **eight separate** month-end, zero-net aggregate expense timing journals using a new disclosed, zero-opening and **zero-closing** `2026 HADI Rent Timing Reclassification` liability account:

| Voucher month | Net Dr(+)/Cr(−) to Rent Expense | Account offset |
|---|---:|---|
| January 31 | +$15,000 | Cr temporary timing control |
| February 28 | +$15,000 | Cr temporary timing control |
| March 31 | +$15,000 | Cr temporary timing control |
| April 30 | +$18,500 | Cr temporary timing control |
| May 31 | +$21,500 | Cr temporary timing control |
| June 30 | −$86,600 | Dr temporary timing control |
| July 31 | −$400 | Dr temporary timing control |
| October 31 | +$2,000 | Cr temporary timing control |
| **Net** | **$0** | **Timing closes $0** |

**Caution:** The month-end timing account captures true retrospective timing reallocations, not new lease debts or cash movements. Its **interim balance is a restatement-control balance**, not independent evidence that rent was payable to a third party. Do not mislabel those interim balances as tenant payable or cash; it must net to zero at completion.

## Required month-by-month posted-ledger result

Based on original 2026 active HADI Shops rent, five active linked Properties contracts and six posted STAFF HOUSE original settlements, the report must show (actual source voucher dates, including both #1007 and the archived #881):

| Period | Required Dr Rent Expense |
|---|---:|
| Jan | $32,700 |
| Feb | $34,450 |
| Mar | $34,450 |
| Apr | $37,950 |
| May | $40,950 |
| Jun | $40,950 |
| Jul | $41,250 |
| Aug | $43,250 |
| Sep | $43,250 |
| Oct | $46,200 |
| Nov | $38,950 |
| **Total** | **$434,350** |

One historic **STAFF HOUSE July $2,000** remains unproven/unpaid, excluded; it is not newly journaled.

## Safety and verification
- The SQL is one SERIALIZABLE transaction with an advisory lock, exact production database/company guards, closed fiscal-period refusal, originals-and-metadata checks, all 11 source rental-month targets checked live, duplicate voucher-number refusal and all-or-nothing balance checks.
- The original #6497 and #8870 cash vouchers and their entry-row fingerprints must remain completely unchanged.
- On success exactly **11** correction journals, all dated **in the relevant 2026 months** (not today's posting date); their genuine `created_at` timestamp remains the present to preserve auditability.
- Zero company1 #1007 and #1022 artificial openings; expense ends $434,350 Dr, actual payable #1021 $18,000 Cr, actual prepaid #1022 $7,000 Dr, temporary period account $0, old #1002 legacy net $0, all historical months match exact source targets.
- The original June rent accrual and HADI #1 payment-clearing links remain valid, November #24 rental row is stamped with the new prepaid recognition journal ID.
- Existing source-code PR #3114 for future duplicate-prevention **remains a separate draft** and is not automatically included/deployed here; must be tested/merged/deployed before future posting claims can be made.
- **This is a prepared, source-guarded SQL correction; it has NOT been executed in production.** Render's installed Postgres connection is read-only. Do not declare balances changed until the user reports the final SQL `PASS` and a separate read-only live check confirms it.

## Source-code change in this branch

`server/routes/reportsLedgerRoutes.ts` correctly includes the original archived #881 voucher entries in the existing `/ledger-monthly/1007` month table and its drilldowns. This is actual posted GL display, **not a reconciliation page or a secondary preview**. It must be merged/deployed for the existing UI to reflect source-corrected monthly entries; the correction SQL by itself will not cause a report that omits legacy #881 to show the right months.
