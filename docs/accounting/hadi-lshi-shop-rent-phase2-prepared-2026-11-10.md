# HADI L'SHI — Phase 2 original-voucher reclassification, protected closings
**Date:** 2026-11-10. **Company:** HADI L'SHI, ID 1. **Prepared branch:** `audit/hadi-lshi-rent-phase1-20261110`.
**SQL:** `scripts/repairs/2026-11-10-hadi-lshi-phase2-original-rent-vouchers.sql`.

## User-protected accounting figures
User explicitly states that **both** Prepaid Rent **#1022 $7,000 Dr** and Accrued Rent Payable **#1021 $18,000 Cr** are already correct and **must not change**. The repair also preserves the existing Rent Expense #1007 closing of **$434,350 Dr**, cash/bank movements, all other ledger-account debit and credit totals, posted rental payments and contract ledgers.

**Scope and state:** Original-voucher correction prepared, guard/preflight inspected live at 2026-11-10 12:36:25 UTC; **not executed in production**. Render's Postgres query action is read-only. Owner must execute entire SQL transaction in a write-enabled TablePlus session. No merge or deployment is implied. No new voucher/journal or deletion is permitted.

### Mathematical reconciliation of original voucher lines
- Eight originally misclassified July payment DEBITS, $14,650 in original vouchers: 9993/34317 $200; 10234/35045 $1,200; 10235/35047 $2,000; 10236/35049 $1,750; 10237/35051 $1,500; 10238/35053 $1,500; 10328/35383 $4,200; 10703/38389 $2,300.
- Three existing owner-paid/shared rental journal DEBITS, $54,000 in vouchers: 13386/47200 $18,000; 15110/53014 $18,000; 16664/58242 $18,000. Each corresponds to recorded owner-company 13 rent receipts for August, September, October; original counterpart credits on #1197 (Transaction Account) and #867 (HP's Rent Credit) are retained.
- Move all eleven original debit-entry ledger_account_id values from #1007 Expense to #1021 Payable; preserve original IDs, amounts, dates, names, currency rates and counterpart entries.
- Reduce original manual clearing voucher #15659's existing debit entry 55192 (#1021) **from $70,650 to $2,000** and existing credit entry 55193 (#1007) **from $70,650 to $2,000**. Update existing #15659 header total from $70,650 to $2,000. Never create any extra voucher or GL entry. Residual $2,000 left untouched pending STAFF HOUSE historical settlement evidence.

### Protected GL projections

| Ledger | Original debits | Original credits | Corrected debits | Corrected credits | Closing after |
|---|---:|---:|---:|---:|---|
| #1007 Rent Expense | 611,600 | 142,250 | 542,950 | 73,600 | **434,350 Dr**, including 35,000 Cr opening |
| #1021 Accrued Rent Payable | 157,350 | 175,350 | 157,350 | 175,350 | **18,000 Cr** |
| #1022 Prepaid Rent | 67,400 | 84,900 | **UNTOUCHED** | **UNTOUCHED** | **7,000 Dr**, including 24,500 Dr opening |
| #881 Old Rent Expense | 323,750 | 323,750 | unchanged | unchanged | 0 |

All cash/bank and other account debit+credit totals unchanged. **AP historical individual lines/period turnover change**, but whole-ledger debit/credit totals and *closing* do not. No prepaid entries change.

### Preflight and execution gates
- Read-only live preflight verified 11/11 original source debit lines on #1007, 0/11 already reclassified; $68,650 aggregate; voucher #15659 current Dr $70,650 / Cr $70,650; expense $434,350 Dr, payable $18,000 Cr, prepaid $7,000 Dr.
- All twelve original vouchers must be company1, posted, nonoptional, USD, matching dates, amounts, 24 original journal lines; eight July payment allocations must still point to existing original accruals; company1 #1007, #1021, #1022 identity and openings must match.
- Abort if closed fiscal period exists, protected before-balance differs, cost-centre allocation touches any edited line, unexpected line count or partial state occurs.
- Lock original headers and lines; set SERIALIZABLE transaction; exact line+amount+account predicates and rowcount guards; database voucher-balance and audit triggers remain enabled.
- The transaction checks untouched counterpart-row fingerprints and a hash of **every other ledger account's** Debit/Credit totals, and the three protected closing balances exactly after each update.
- Reruns after a successful commit yield a no-op and no duplicate audit entries.
- Successful output must say `HADI PHASE 2 DONE...` and the final verification SELECT must return `phase2_status=PASS`, `corrected_original_lines=11`, `old_clearing_amount=2000`, expense 434350, AP 18000, prepaid 7000.
- If any guard fails, PostgreSQL rolls back the entire transaction; do **not** remove the guard or manually run partial SQL.

### Unresolved separate historic treatment
Ended STAFF HOUSE July company1 rental #26 has a $2,000 accrued rent month without rental payment. Original guarantee and equity journals do not document its legal final status. The proposed $2,000 residual in JV #15659 leaves all verified balances untouched. An eventual change requires evidence, not a blind payable/expense adjustment.

**Next execution step:** Run linked SQL in TablePlus against production ERP database `erp_db_qscj_64lv_e7rz_8744_2lm3`. Then capture the final `PASS` row and independently verify accounts and cash. This artifact is a proposed repair, not evidence that any live voucher has changed.

## Phase 2 execution completed and independently verified — 2026-11-10 13:08:35 UTC

The user ran the full original-voucher repair transaction in an authorized TablePlus production session and reported successful PostgreSQL completion:

```
NOTICE: HADI PHASE 2 DONE: 11 ORIGINAL debit lines reclassified ($68,650);
ORIGINAL #15659 reduced to $2,000; original cash/other balances untouched;
expense $434350 Dr, AP $18000 Cr, prepaid $7000 Dr; ZERO new vouchers.
PASS  11  2000.00  434350.00  18000.00  7000.00
```

An independent **read-only production Render database check** at 2026-11-10 13:08:35 UTC confirmed:
- All **11/11** exact original debit entries now reference payable ledger **#1021**; **0** remain on expense ledger #1007; amount **$68,650**.
- Existing voucher **#15659** has **2** original lines with Dr **$2,000**, Cr **$2,000**, header total **$2,000**.
- **12/12** affected vouchers remain double-entry balanced, equal to their header totals, with 2 original lines each; **0** failures.
- **12** manual repair action rows exist in `audit_log` for actor `system:hadi-lshi-rent-phase2-20261110`.
- Expense #1007 posted Dr **$542,950**, Cr **$73,600**, Cr opening **$35,000**, closing **$434,350 Dr**.
- Accrued Rent Payable #1021 Dr **$157,350**, Cr **$175,350**, closing **$18,000 Cr**.
- Prepaid Rent #1022 Dr **$67,400**, Cr **$84,900**, Dr opening **$24,500**, closing **$7,000 Dr**. **No prepaid posting changed**.
- Historical Rent Expense #881 remains Dr/Cr **$323,750/$323,750**, closing **$0**.

**Status: Phase 2 production database correction COMPLETE and VERIFIED.** Historical ledger *classifications and turnover* corrected, while closing balances remain unchanged. No app merge/deploy performed. The historical STAFF HOUSE $2,000 is still pending documentary resolution; do not assume waived/paid. Future posting protection, multi-company settlement handling and regression tests are **Phase 3**, not claimed done by this database repair.

