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

## Production execution certificate — 2026-11-10 16:27 UTC

The owner ran the full guarded SQL transaction in production TablePlus and reported:

```
PASS 434350.00 18000.00 7000.00 11
NOTICE: PASS: HADI 2026 Jan-Nov month-by-month real GL restatement;
11 dated journals; no cash movements; #1007 $434350 Dr,
#1021 $18000 Cr, #1022 $7000 Dr; both artificial openings ZERO;
timing account closing ZERO.
```

An independent *read-only live Render Postgres check* at **2026-11-10 16:28:40 UTC** confirmed the following:

- **January through November 2026:** all eleven exact monthly real GL net expense movements match the pre-reviewed source schedule; **eleven $0 monthly variances**. Actual: Jan $32,700, Feb $34,450, Mar $34,450, Apr $37,950, May $40,950, Jun $40,950, Jul $41,250, Aug $43,250, Sep $43,250, Oct $46,200, Nov $38,950; total **$434,350 Dr**.
- Current Rent Expense #1007: **opening $0**, posted debits **$633,450**, posted credits **$199,100**, closing **$434,350 Dr**. Retired account #881 original posted movements **$323,750 Dr / $323,750 Cr**, closing $0.
- Accrued Rent Payable #1021: **opening $0**, posted debits **$172,050**, posted credits **$190,050**, closing **$18,000 Cr**.
- Prepaid Rent #1022: **opening $0**, posted debits **$95,400**, posted credits **$88,400**, closing **$7,000 Dr**.
- Dedicated timing control #4282, code `HADI-RENT-2026-TIMING`: opening **$0**, debits **$87,000**, credits **$87,000**, closing **$0**.
- **Exactly 11 correction journals** #17510–#17520, all correctly balanced, original `voucher_date` and `effective_date` in Jan–Nov 2026, historical date is not misrepresented as the actual entry creation date; `created_at` 2026-11-10 16:27:09 UTC.
- Original payment voucher #6497: 2026-01-01, 2 original lines: entry #23178 Dr #881 $42,000; #23179 Cr legacy #276 $42,000, preserved.
- Original payment voucher #8870: 2026-06-08, 2 original lines: entry #30535 Dr #1007 $31,500; #30536 Cr SAFE #112 $31,500, preserved.
- Obsolete legacy payable #1002 posted net now **$0**; original June accrual line #30193 and payment-clearing line #30204 now reference real payable #1021.
- HADI #2 November 2026 rental-month row #128505 now links to recognized voucher **#17512** and has `used_prepaid_account=true`.

**Status: historical 2026 production GL restatement COMPLETE and independently VERIFIED.** Do **not** rerun correction SQL. Database posting is finished.

**Outstanding:** This PR's source change to the existing monthly ledger/drilldown still requires merge/deployment to display the original archived #881 transactions correctly. Separately, future rent protection work in draft PR #3114 requires code review, runtime tests, authorized merge, and deployment; successful historical DB correction does not prove future code is live. Do not create a new reconciliation section.

## Monthly Rent Expense debit-only presentation — 2026-11-10

Owner requested that the existing Rent Expense monthly summary show the **net recognized rent under Debit** instead of confusing gross Debit and Credit correction turnover (like the other rent ledgers), without adding any reconciliation section or changing the already certified voucher restatement.

- `server/routes/reportsLedgerRoutes.ts` continues to return full original gross debit/credit data (and includes retired #881 original voucher entries) but now sets `presentation:"net-expense"` only for HADI company #1 account #1007 with archived #881 verified.
- `client/src/lib/monthlyRentExpensePresentation.ts` uses cent-precision netting: each month displays `max(debit-credit,0)` under Dr and `max(credit-debit,0)` under Cr. This makes a true net-credit month visible instead of hiding it; it doesn't falsify the audit trail.
- `client/src/pages/LedgerMonthlySummary.tsx` applies this net presentation to its existing monthly table, grand total and chart. Raw API amounts, voucher drilldown, posted original entries, cash, rent account balances and timing journal metadata remain **unchanged**. The explanatory text explicitly identifies presentation-only netting.
- `tests/hadi-rent-net-monthly-presentation.test.ts` covers all 11 verified 2026 gross month pairs; expected monthly displayed amounts are January $32,700 Dr through November $38,950 Dr, annual $434,350 Dr and $0 Cr. Also checks cents precision, original input immutability and negative net months.
- Existing monthly API consumers continue receiving actual gross journal amounts; this client-only display mode cannot cause a false voucher accounting report outside the requested monthly summary.
- **No new SQL or new vouchers required.** The PR remains unmerged/undeployed; the visible production screenshot will remain gross until deployed.


## January 2026 original-voucher correction — prepared, **not executed** (Nov 10, 2026)

User rejected any net-debit display-only masking: correct underlying historical voucher entries *month by month*. The previously added UI net-presentation helper was **reverted**, and no new reconciliation section is added.

The first source audit (live read-only preflight **16:52:07 UTC**) found:
- Original six January Payment vouchers **#6479, #6481, #6483, #6486, #6493 and #6497** total $86,600: $15,700 actual January rent expense and $70,900 paid in advance for February–December; individual future amounts $4,500/$4,500/$6,000/$9,000/$8,400/$38,500, respectively.
- January #6487 STAFF HOUSE $2,000 expense remains entirely untouched.
- Exactly **24** January 1 prepaid reclassification Journals totaling **$70,900** (23 historical original corrections plus original dated repair #17510 $7,000), each existing with **two** rows Dr Prepaid #1022 / Cr Expense #1007. No linked rental-month accrual or rental payment records or cost-center allocations refer to these reclassification vouchers.
- Historical June #8787 currently Dr #1007 $227,750 / Cr #881 $227,750. On reclassifying the six original January payments directly into prepaid, this transfer must be reduced by precisely $70,900 to **$156,850 on the same two original rows**, so archived ledger #881 retains a **zero closing balance** and active #1007 also remains unchanged.
- Expected actual January gross real GL after this distinct correction: **Dr $32,700 / Cr $0**. January net and the other ten verified monthly net movements remain unchanged; closing #1007 $434,350 Dr, #1022 $7,000 Dr, #1021 $18,000 Cr, old #881 $0.
- Original **credit counterpart lines** on all six January Payment vouchers stay completely unchanged (cash, SAFE, and legacy credit #276), and **original payment voucher dates and totals are unchanged**. Each original payment retains its receipt and gets a *new prepaid debit* as its existing expense debit is reduced to the true January portion. These are edits to the **original voucher classifications**, not new payment vouchers.
- The **24 now-redundant reclassification Journal headers** are marked `deleted_at` / superseded, **not physically deleted**: all original voucher entry rows and voucher IDs stay available in history and special `audit_log` records explain every action. They are excluded from the posted GL so the original payment debits recognize prepaid directly instead of twice.
- Month voucher #8787 (a noncash legacy expense consolidation) is adjusted in place as above. No new accounting vouchers or general ledger accounts are created.
- Cash-counterpart fingerprints are compared before and after; all six Payment vouchers must balance to their original totals with 3 lines; no fiscal year can be closed.
- All 11 **actual posted** month totals must pass, alongside zero archived-account balance and protected expense, payable, prepaid closing invariants. The repair refuses a rerun if prior state has changed.

**Delivery:** January-only TablePlus script is provided as `HADI_JANUARY_ORIGINAL_VOUCHERS_TABLEPLUS.sql` in the same conversation. It uses one serializable transaction and standard single-quoted `DO '...' LANGUAGE plpgsql` rather than the prior dollar-quote syntax that TablePlus split. **It is not run yet; running it requires the owner's authorized TablePlus session and a production backup.** This script is January ONLY. February through November may still have gross debit and credit turnover in the true books; deal with these in individually reviewed subsequent passes, never by blindly hiding credits.

### UI status

The client-side net-only expense presentation commits from 2026-11-10 were explicitly **reverted**. The server-side #881 historical account inclusion in the existing original monthly ledger and voucher drilldown remains. On `main`, that source change still requires a merged PR and deployment to show all the real original #881 transactions.


## Final source consolidation proposal: all original rent posted under #1007

Owner clarified 2026-11-10 that **all historical original rent transactions should belong to the surviving ledger #1007 from the beginning**, rather than remaining split with retired #881 or being visually netted.

Read-only production preflight at 2026-11-10 17:09 UTC confirmed:
- Exactly **54** posted voucher entry rows still directly reference retired #881. The source rows, excluding the one historic consolidation transfer credit, are **53 original entries across 28 balanced historical vouchers**. Those contain **$252,850 gross debits / $96,000 gross credits**, net **$156,850 Dr**.
- Existing noncash transfer voucher **#8787** (June 1, 2026) is still Dr #1007 **$156,850** / Cr #881 **$156,850**. It was needed only while original entries remained in #881. Once originals move to #1007, it must be **soft-retired**, never counted twice.
- No linked rental-month entry, rental payment, or cost-center allocation depends on that transfer; all 28 source vouchers currently have matching debit/credit sums and headers, and **no 2026 fiscal period is closed**.
- Immutable account-row source fingerprint for the 53 original posted legacy lines: `84f9c8b06f39c68149e8ca4037c3f6c8`. A strict guarded transaction refuses altered source identities and a repeat run.
- The consolidated ledger includes original receipt dates from January–June without modifying actual cash/bank, SAFE, landlord, transfer account counterparts, voucher header dates, or amounts.
- Preflight simulation of **reassigning the 53 source account links to #1007 and soft-deleting #8787** confirms all 11 monthly net movements exactly: Jan 32,700, Feb 34,450, Mar 34,450, Apr 37,950, May 40,950, Jun 40,950, Jul 41,250, Aug 43,250, Sep 43,250, Oct 46,200, Nov 38,950; year-to-date **$434,350 Dr**.
- Expected after-state: **zero active voucher entries referencing #881**; #881 **$0**, #1007 **$434,350 Dr**, #1021 **$18,000 Cr**, #1022 **$7,000 Dr**, timing account #4282 **$0**. January direct #1007 Dr $32,700 / Cr $0 without any display override. **0 new vouchers**; 53 original line edits + one soft-supersession of historical transfer.
- Existing historical/deleted transfer voucher lines are **retained for audit**, no physical DELETE. Exactly 54 explicit `audit_log` repair records required.
- Follow-up distinction: consolidating #881 into #1007 is a **ledger-account ownership correction**, not a gross Debit/Credit erasure. February will still show $37,950 Dr / $3,500 Cr and June $259,250 Dr / $218,300 Cr in actual vouchers, each netting to their correct monthly expense. Review those historical gross reclassifications **one-by-one**, not by hiding them on screen.

The user-facing guarded SQL and instructions:
`HADI_ALL_ORIGINAL_RENT_TO_1007_TABLEPLUS.sql`,
`HADI_ALL_ORIGINAL_RENT_TO_1007_COPY.txt`,
`HADI_ALL_ORIGINAL_RENT_TO_1007_README.txt`.
These were prepared in the conversation's working files. They use one SERIALIZABLE transaction and a standard single-quoted `DO '...' LANGUAGE plpgsql` block compatible with TablePlus's **Run All**, with source-row fingerprint checks and unconditional postconditions. They have **not been executed** by ChatGPT, whose production PostgreSQL connector is read-only. The old narrower `HADI_JANUARY_15000_TO_32700` SQL is superseded and should NOT be applied before/after this full consolidation unless explicitly reassessed.

## February 2026 original-voucher correction — prepared, not yet executed

The owner confirmed all 53 surviving original legacy #881 postings were reclassified to #1007 and redundant June transfer #8787 was soft-retired. A live Render read-only query confirmed **zero posted #881 entries**, historical transfer `deleted_at` present, and all 11 monthly amounts unchanged, with **#1007 434,350 Dr**, **#1021 18,000 Cr**, **#1022 7,000 Dr**, period timing #4282 zero.

The next target is February. Original Payment **#6478** (February 1, 2026) is $5,250, for February–April small shop rent: original debit entry **#22755 Dr #1007 $5,250** and cash counterpart **#22756 Cr KOLWEZI CASH #6 $5,250**. Exact economic split is February rent $1,750, March/April prepaid $3,500. Two already-existing February 1 Journal vouchers **#12990** and **#13004**, each Dr Prepaid #1022 $1,750 / Cr Expense #1007 $1,750, reclassified those future months from February rent expense. They have **no** property-month accrual links, rental payment links, or cost-center allocations.

Therefore the prepared February-only repair:
1. Updates **original entry #22755** on Payment #6478 to Dr #1007 **$1,750** (old $5,250).
2. Adds a new Dr Prepaid #1022 **$3,500** **entry on the same original Payment #6478**. The original **KOLWEZI CASH Cr $5,250** line #22756, payment date, total, and voucher ID remain unchanged.
3. Soft-retires historical duplicate reclassification voucher headers #12990 and #13004 while preserving all their original entry records and adding explicit audit reasons. These 2 JVs no longer influence posted general ledger.
4. Asserts February **actual posted** Dr #1007 $34,450 / Cr #1007 **$0**, January stays Dr $32,700/Cr $0, all Jan–Nov net monthly expense amounts unchanged, Expense #1007 $434,350 Dr, Prepaid #1022 $7,000 Dr, Payable #1021 $18,000 Cr, old #881 $0, timing #4282 $0.
5. The script refuses changed sources, any closed periods, duplicate run, or missing previous consolidation audit; validates immutable original KOLWEZI CASH entry fingerprint `421ec07ee9d2214999d53932fffb1985`. In total three new repair audit rows and **zero new vouchers**. Original journals are retained for audits, not erased.

A fresh read-only preflight on 2026-11-10 found all exact expected original rows, source header identities, the completed **54 prior consolidation audit rows**, zero February repairs already run, and zero closed periods or dependent allocation/lease-payment links.

User-facing file: `HADI_FEBRUARY_ORIGINAL_VOUCHERS_TABLEPLUS.sql` (plus copy-text and README), generated in current ChatGPT workspace. It uses a **single standard-quoted DO** and SERIALIZABLE transaction for TablePlus Run All, with final independent read-only query; the actual correction remains **UNEXECUTED** until the owner runs the file in TablePlus and reports `PASS HADI FEB ORIGINAL`.

Future pending gross credits: June $218,300, July $400, October $2,000, to be assessed **one by one**, not visually netted and not automatically erased without corresponding financial source evidence. Separate unfinished future-posting PR #3114 needs testing and deployment.
