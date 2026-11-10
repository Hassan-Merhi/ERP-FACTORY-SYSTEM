# HMD KINSHASA — Phase 3 33-month reconciliation and historical payable controls

**Company:** HMD KINSHASA, company 8, ERP Shop Rentals, USD.  
**Branch:** `fix/hmd-kinshasa-rent-historical-ledger-20261110` (continues Phases 1–2).  
**Date:** 2026-11-10.  
**Production access:** read-only through Render connector. Historic SQL corrections were prepared in GitHub, not executed by the assistant. No merge or deployment.

## Verified production source facts

- Three active ERP SHOP contracts: #15 / KINSHASA #1 $4,400 per month, #16 / KINSHASA #2 $6,660, #17 / STAFF HOUSE $2,500.
- 33 month-allocations January–November 2026; each month paid once and completely (`POSTED`, valid payment voucher). Expected, cached paid and posted paid totals are **$149,160**. No outstanding or advance/guarantee allocation counted as rent.
- Separated guarantees $26,400 + $39,600 + $7,500 = **$73,500**.
- Phase 2 July corrections persist: Rent Expense #877 has debit $158,320, credit $9,160, **$149,160 debit net**. Accrued Rent Payable #1401 currently has debit $67,800, credit $67,800, **$0 net**.
- Existing July voucher IDs, payment allocations and original cash credits were verified unchanged after Phase 2.

### January–May historical duplicate accrual #8534

- The 15 monthly rows for January through May 2026 still refer to voucher ID **8534**. Each row's expected amount equals the fully posted rent. Total **$67,800**.
- The original six cash payment vouchers (#6470/#6475/#6476 covering Jan–Apr and #7478/#7479/#7480 for May) already debited Rent Expense #877 and credited CASH #352, $67,800 on each side; all original payment vouchers and allocations are valid.
- Audit record **#1549** proves voucher **#8534**, `ACCR-RENT-1780351725220-626k`, was deleted by `dev` on **2026-06-02 08:11:32 UTC**. The audit captured its duplicate $67,800 Dr Rent Expense / Cr Accrued Rent Payable entry. The voucher no longer resolves in company 8.
- **Do not recreate #8534, relink these rows to unrelated payment vouchers, post a replacement journal, or simply clear the links on the currently deployed system.** The ordinary monthly scheduler can re-recognize already paid rent if stale links are cleared and another month later becomes unpaid.

### June historical account #918

- June accrual voucher **#8537** posted $13,560 Dr Rent Expense #877 / Cr legacy account **#918** (entry **29370**).
- June voucher **#8722** paid $4,400 Dr #918 (entry **30027**) / Cr CASH #352. June AP-clearing journals **#8802** ($6,660, entry **30308**) and **#8804** ($2,500, entry **30312**) debit #918 against matching rent expense credits. These four entries **Dr $13,560 / Cr $13,560** and net **$0**.
- Ledger account ID 918 is not present in current company-8 ledger-account reads, although its four historical entries still exist. A tightly guarded reclassification moves only these **four original voucher-entry account links** to current Accrued Rent Payable #1401. This does not change rent expense, cash, amounts, the June accrual, or net payable balance. Afterwards account #1401 gross debits and credits are each **$81,360**, with net **$0**, and no company-8 entry remains on #918.

## Branch safeguards implemented

1. **`server/services/rental/rentRecognitionHold.ts`:** shared pure rule `isRentMonthReadyToRecognize` excludes explicitly reviewed, held historical months.
2. **`server/routes/rental/shared/accrual.ts`:** standard accrual and advance-recognition queues both skip held months. Later genuinely due, unheld months remain eligible. Transaction-level `postAccrualPassTx` already refuses held rows.
3. **`server/routes/rental/rentalAccrualConfigRoutes.ts`:** the **re-accrue** action fails with 409 before posting any phantom/orphan correction journal when deleted/missing accrual links exist. It uses the company's reconciliation results.
4. **`scripts/repair-rental-payment-accounting.ts`:** generic Type E orphan cleanup is **report-only**, including with `--apply`; no more indiscriminate clearing of deleted accrued links.
5. **`server/services/rental/rentalReconciliationService.ts`:** validates old voucher references inside the owning company and flags optional/deleted/missing vouchers.
6. **`tests/hmd-kinshasa-rent-phase3.test.ts`:** regression tests for held Jan–May months and permitted future due-month recognition.

## Guarded production SQL deliverables and mandatory order

- **A. June original-entry repair (safe before branch deploy):** [`2026-11-10-hmd-kinshasa-phase3-june-legacy-payable.sql`](../../scripts/repairs/2026-11-10-hmd-kinshasa-phase3-june-legacy-payable.sql). It changes exactly 4 `voucher_entries.ledger_account_id` fields 918→1401, with immutable voucher IDs, no new journals and in-transaction audit.
- **B. Deploy the branch safeguards BEFORE repairing January–May references.** Until the updated code is live, avoid the legacy `re-accrue` action and the generic rent repair Type E `--apply` command. Do not run the Jan–May cleanup early.
- **C. Jan–May source-backed cleanup (after safeguard deploy ONLY):** [`2026-11-10-hmd-kinshasa-phase3-jan-may-stale-links.sql`](../../scripts/repairs/2026-11-10-hmd-kinshasa-phase3-jan-may-stale-links.sql). The file intentionally starts with `DEPLOY_NOT_CONFIRMED` and refuses to execute until an operator checks deployment and changes that token to `DEPLOY_CONFIRMED`. Under exact source, 15-row, GL, audit-provenance and paid-payment guards, it changes only those 15 `property_monthly_ledger` rows: stale deleted pointer `8534 → NULL`, plus persisted `[RENT_RECOGNITION_HOLD]` reason note. Never changes voucher, payment, rent amount, CASH or guarantee records.
- **D. Run [Phase 3 read-only verification](../../scripts/repairs/2026-11-10-hmd-kinshasa-phase3-verify.sql):** verify all 33 months; rent expected=actual paid=$149,160; 15 protected Jan–May months and 0 dangling links; 4 corrected June voucher entries and 0 remaining on #918; account #877 net $149,160 Dr and account #1401 net $0; cash and guarantees intact; audit records exist.

All mutations use guard conditions, exact voucher/entry identities, business-date period validation, atomic transactions and audit entries, and refuse mixed/changed states.

## Read-only preflight completed 2026-11-10

| Check | Preflight result |
|---|---|
| June original vouchers #8537/#8722/#8802/#8804 | All 4 active, USD |
| June 4 account-entry targets | All 4 still on account #918 |
| June original voucher line count | 10 total, as expected |
| January–May source monthly rows | 15, paid/expected $67,800 |
| January–May payment vouchers | 12 lines, $67,800 Dr Rent Expense and $67,800 Cr CASH |
| Voucher #8534 deletion provenance | Audit #1549 matched |
| Closed company-8 fiscal periods | None matching the historical correction date |
| Phase 2 expense/payable GL | $149,160 Dr and $0 |

**Implementation status as of 2026-11-10: COMPLETE IN PRODUCTION.** PR #3108 was merged to main (commit `86481ec3a7d7a0f3a6c00443da410728717afafc`) and Render production service `system` deploy `dep-dbpg6m8n74is73ds89ag` reached `live` on 2026-11-10 at 11:45:22 UTC. The owner executed both Phase 3 guarded repair scripts via TablePlus. All results were independently checked with read-only production queries.

## Final independent verification — completed 2026-11-10

- **June voucher correction:** 4 original debit/credit entries `29370`, `30027`, `30308`, `30312` reclassified from obsolete account `918` to existing liability `1401`; no company-8 historical ledger entries remain on account `918`. Audited by explicit repairs `88682`–`88685` and row-update records `88678`–`88681`.
- **January–May stale-link cleanup:** exactly **15** monthly rows now have `accrual_voucher_id IS NULL` and `notes LIKE '[RENT_RECOGNITION_HOLD]%'`; **0** references to deleted `8534` remain. Each is fully paid. All 15 repair audit entries persisted on **2026-11-10 at 11:52:17 UTC**.
- **Rent reconciliation:** **33** monthly rows, **33** matched POSTED payments (one per row); rent expected **$149,160**, cached paid **$149,160**, actual posted **$149,160**; no payment count or amount discrepancies; outstanding **$0**.
- **Rent Expense / payable GL:** account `877` debit **$158,320**, credit **$9,160**, net **$149,160 Dr**. Account `1401` debit **$81,360**, credit **$81,360**, net **$0**.
- **Original vouchers:** January–May payment vouchers `6470`, `6475`, `6476`, `7478`, `7479`, `7480`; June accrual/payment/AP-clearing vouchers `8537`, `8722`, `8802`, `8804`; July accrual/payment vouchers `9960`, `10579`, `10580`, `10581` remain live, non-optional. Deleted original accrual voucher `8534` was **not** recreated.
- **Cash:** account `352` entries and total company-wide balance were not directly altered by the Phase 3 SQL; original rent payment entries preserved.
- **New vouchers:** **none** created by either repair. Both SQL scripts updated only existing entries or monthly ledger notes/references; the safeguards remain deployed.

**Phase 3 is closed.** No further production SQL is required for these January–November 2026 HMD KINSHASA rent records.

