# Phase 2 — HMD KINSHASA historical rent vouchers (execution handoff)

**Branch:** `fix/hmd-kinshasa-rent-historical-ledger-20261110`  
**Date:** 2026-11-10  
**Production status:** **APPLIED by the owner in TablePlus at 2026-11-10 11:08:50 UTC and independently verified read-only against Render production on November 10, 2026.** No new vouchers, journals or cash changes. The available Render connector was only used for read-only verification; the owner executed the provided SQL.

## Phase 2 deliverables

1. [Guarded production repair](../../scripts/repairs/2026-11-10-hmd-kinshasa-july-rent-inplace.sql): updates the `ledger_account_id` only for July 13, 2026 debit entry IDs **37980, 37982, 37984**, company **8**, from Rent Expense **877** to Accrued Rent Payable **1401**; keeps existing vouchers **10579, 10580, 10581**, their CASH **352** credit lines, and the July accrual voucher **9960** unchanged.
2. [Read-only verification](../../scripts/repairs/2026-11-10-hmd-kinshasa-july-rent-verify.sql): report before/after gross and net account balances, actual debit targets, untouched cash credit entries, payment-month links and recorded audit rows.
3. [Phase 1 evidence](./hmd-kinshasa-shop-rent-phase1-audit-2026-11-10.md): original voucher IDs, live account balances, and why no new voucher is appropriate.

## Latest production preflight

- Active HMD KINSHASA company ID 8 and exact account identities verified.
- All 4 exact July voucher identities/amounts matched production.
- The 3 July monthly rows each retain their original paid amounts and reference accrual voucher 9960.
- Payment IDs 303–305 are POSTED and linked to original vouchers 10579–10581.
- Original debit entries 37980, 37982, 37984 still point to account 877. Cash credit entries 37981, 37983, 37985 still point to account 352.
- No company 8 fiscal period closure through July 13, 2026 found.
- Earlier read-only ledger totals: account 877 $171,880 Dr and $9,160 Cr = **$162,720 Dr**; account 1401 $54,240 Dr and $67,800 Cr = **$13,560 Cr**.

## Execution instructions

Use a direct, authorized production SQL session (e.g. TablePlus) connected to **exactly** `erp_db_qscj_64lv_e7rz_8744_2lm3`, NOT its test copy or another company. Review the repair file, run its full contents as one script (it contains BEGIN/COMMIT), and inspect the completion NOTICE.

The script fails closed with RAISE EXCEPTION and rolls back all edits if voucher/ledger/payment entries, account IDs, closed periods or expected live balances have drifted. It performs three audited in-place entry reclassifications only. It never inserts a voucher, journal or payment, and does not delete any historical record.

After the script commits, run the read-only verification file against the same connection. Confirm:

| Check | Expected after Phase 2 |
|---|---|
| Account 877 Rent Expense - ERP Shops | $149,160 Dr (total debit $158,320; existing credit $9,160) |
| Account 1401 Accrued Rent Payable | $0 net (total debit $67,800; total credit $67,800) |
| July debit entry IDs 37980, 37982, 37984 | All classified to account 1401 |
| CASH credit entry IDs 37981, 37983, 37985 | All still account 352 and same original amounts |
| Voucher IDs 9960, 10579, 10580, 10581 | All retained; no new or retired vouchers |
| Monthly ledgers/payments/guarantees/prepaid | Unchanged |
| Audit log | Three new repair records (in addition to any database-triggered audit rows) |

The correction script is idempotent: a second run with all three entries already corrected and expected post-balances will exit without altering anything. Partial modifications or unexpected data refuse to proceed.

**Phase 2 source implementation committed and read-only preflight checked. Production execution remains required for the live accounting repair to be complete.** No merge or deployment has been performed.

## Verified production result — 2026-11-10

The owner executed the full guarded SQL and reported:

`NOTICE: HMD KINSHASA July rent corrected in place: entries 37980,37982,37984; expense=149160.00, payable=0.00; CASH unchanged. No new vouchers.`

Independent read-only verification using the Render production Postgres connector confirmed the persisted committed state:

| Check | Verified production result |
|---|---|
| Rent Expense #877 | Dr **$158,320** / Cr **$9,160** = **$149,160 Dr** net |
| Accrued Rent Payable #1401 | Dr **$67,800** / Cr **$67,800** = **$0** net |
| Entry #37980 / voucher #10579 | Dr **$4,400**, account **1401** |
| Entry #37982 / voucher #10580 | Dr **$6,660**, account **1401** |
| Entry #37984 / voucher #10581 | Dr **$2,500**, account **1401** |
| Cash entries #37981, #37983, #37985 | Retained original **account 352**, cash credit $4,400/$6,660/$2,500 |
| July accrual #9960 | Still live and unchanged, July 2, 2026, **$13,560** |
| Original payment vouchers | #10579, #10580, #10581 still live, non-optional, dated July 13, 2026 |
| July payment allocations | Payment IDs 303,304,305 still POSTED; same amounts and original voucher links |
| Rental-month references | July rows 637546,113144,637539 still paid and linked to accrual #9960 |
| Guarantees | Contract 15 $26,400, contract 16 $39,600, contract 17 $7,500; unchanged from Phase 1 |
| Explicit audit records | #88581, #88582, #88583 each action `repair` |
| Database-triggered audit records | #88578, #88579, #88580 each action `row_update` |

Audit timestamp: **2026-11-10 11:08:50 UTC**. All six audit rows belong to company 8 and reference the original three voucher entry IDs. No new repair vouchers were generated.

**Phase 2 is completed in production.** The January–May dangling historical link and legacy June account 918 questions remain separately scoped Phase 3 diagnostics, not reasons to undo the July repair.
