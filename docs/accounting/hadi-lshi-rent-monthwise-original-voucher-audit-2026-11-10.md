# HADI L'SHI 2026 Rent Expense — source-of-truth month-by-month accounting audit
Date: 2026-11-10. Status: **read-only forensic reconciliation + posted-ledger alias reporting fix; NO historic GL edits executed**.

## Binding owner requirements
- Correct historical **original** rent vouchers/periods; not a new reconciliation view.
- No replacement or newly created historical vouchers; no changes to the original cash/bank payment dates, amounts or accounts.
- Keep Accrued Rent Payable #1021 **$18,000 Cr**, Prepaid Rent #1022 **$7,000 Dr**, and their underlying balances/records unchanged.
- The $35,000 Cr Rent Expense opening should be investigated, not silently accepted or deleted.
- Future ERP and linked Hassan Properties rent posting must avoid repeat accruals/expense debits. The separate unmerged draft PR #3114 addresses preventive source logic and still needs runtime validation.

## Forensic results confirmed against Render PostgreSQL

HADI company 1, expense accounts #1007 (current) and #881 (retired historic), combined 2026 actuals Jan–Nov. The signed monthly booked movement is Dr-minus-Cr; the **$35,000 credit opening is included in January closing only**, not a second posted January voucher. The expected service expense is computed from all active HADI ERP Shop lease monthly rents, active Properties 13 leases linked to HADI, plus six actual posted STAFF HOUSE #26 settlements (four paid in cash and two guarantees), ignoring an **unproven** July STAFF HOUSE $2,000 claim.

| Month 2026 | Booked combined GL incl. opening | Verified service-month expense | To re-period (service minus booked) |
|---|---:|---:|---:|
| Jan | **−10,300** | 32,700 | +43,000 |
| Feb | 19,450 | 34,450 | +15,000 |
| Mar | 19,450 | 34,450 | +15,000 |
| Apr | 19,450 | 37,950 | +18,500 |
| May | 19,450 | 40,950 | +21,500 |
| Jun | 159,050 | 40,950 | **−118,100** |
| Jul | 41,650 | 41,250 | −400 |
| Aug | 43,250 | 43,250 | 0 |
| Sep | 43,250 | 43,250 | 0 |
| Oct | 44,200 | 46,200 | +2,000 |
| Nov | 35,450 | 38,950 | +3,500 |
| **Total** | **434,350** | **434,350** | **0** |

The prior ERP monthly report at `/ledger-monthly/1007` omitted the retired #881's **nonzero monthly historical postings** even though the canonical balance engine and ordinary voucher statement treat #881 as folded into #1007. Their **annual net is zero**, hence the old report still happened to reach the correct closing $434,350. This branch changes the existing backend **monthly statement and its voucher drilldown** to include archived #881 lines when and only when its verified archive state is present. **No new report section, no synthetic expense allocation, and no application UI changes.** This fixes the missing actual original ledger entries; it does not pretend the historical month-date problem is resolved.

## $35,000 credit opening provenance

The DB account audit log and the production-approved archived startup repairs establish:
- 2026-06-08: $10,500 Cr opening added on #1007.
- 2026-11-06: $10,500 -> $31,500 Cr on #1007, plus $3,500 Cr on retired #881 and $24,500 Dr on Prepaid #1022. The 3-part prepaid opening reclassification was deliberately trial-balance neutral.
- 2026-11-06: former #881 $3,500 Cr opening moved to #1007 ($35,000 Cr), #881 set inactive/hidden/0, its 54 historical voucher lines retained.
- Therefore **setting #1007 opening=0 now would add $35,000 to its closing rent expense** and undo the correct trial balance/prepaid reclassification without other *evidence-backed* offsetting original-entry corrections. The ledger now correctly ends at $434,350 Dr. There is no evidence supporting an arbitrary deletion of this opening.

## Original voucher obstacles requiring genuine accounting re-perioding

A year-end *net balance* match does not certify each originally booked month.

- Original **#8787** is a **two-line $227,750** June 1 historic transfer #881 -> #1007. It cannot be spread across January–June by changing a single voucher header date. Any such change just shifts the entire $227,750 at once and must not be used to fabricate allocations.
- Original **#8565** is one June 2 journal of **27 entries ($96,000)**, including **26 debit lines narrating different January–June rent months** and a single $96,000 credit to old payable #922. Its single voucher_date and effective_date (null) cannot represent the distinct service months. Editing the header date changes the **entire** voucher, not its 26 individual lines.
- Original **#6497** is a January 1 $42,000 cash payment covering **January–December** HADI #2 rent. Original **#8870** is a June 8 $31,500 cash payment covering **April–December** HADI #4 rent. Changing either voucher date would also redate the cash movement, prohibited.
- $63,900 of January-dated expense credits are original reclassifications with **Prepaid #1022** counterparts. Changing their dates or accounts alters the user's protected prepaid chronology; do not do so blindly.
- **#15659** is the Phase 2 historical $2,000 residual entered in October, but its STAFF HOUSE July disposition was not documented. Do not simply move it to July because the month difference looks convenient.
- Company 1 **#1021 $18,000 Cr** and **#1022 $7,000 Dr** remain verified correct. No 'difference-clearing' voucher is allowed.

**Feasibility boundary:** PostgreSQL stores posting date on the **voucher header**, not individual voucher_entries. Therefore a full, genuine balanced GL month-by-month historical restatement of composite invoices/accruals **cannot** be delivered by simply re-dating or reclassifying a few existing lines while also preserving the original multi-month cash vouchers, all monthwise payable/prepaid history, and creating zero additional period-specific noncash postings. Legitimate approaches require either (1) the Kinshasa-style original payment corrections **plus separate period-specific balanced noncash recognition entries/vouchers** (owner previously restricted creating new vouchers), or (2) a formally designed and tested per-line accrual/service-period accounting mechanism with balanced offset entries and a database migration shared by **all** ledger, trial balance and statement engines. No workaround should fabricate voucher dates or silently treat a derived preview as real GL.

## Work done on this branch

`server/routes/reportsLedgerRoutes.ts` now includes the original archived #881 voucher entries in both the *existing* `/api/reports/ledger-monthly-summary/1007` and the drilldown `/api/reports/ledger-vouchers/1007/:year/:month` when archived source state is verified. Preserves all original voucher data and the $35,000 Cr opening. No reconciliation section. No SQL/DB changes. The previous preview-only branch `fix/hadi-rent-service-month-reconciliation-20261110` remains unmerged and must **not** be merged as a substitute.

## Execution and rollout status

- This branch is **not merged or deployed**. No production records changed.
- This code change fixes account history visibility, **not** the remaining monthly re-perioding. Do not claim the user-requested full original voucher correction complete.
- Do not run the Phase 2 SQL again; it has already been executed and independently verified.
- For a complete original-voucher period restatement, determine and authorize a balanced accounting treatment for the multi-month composite vouchers. Preserve cash and the two protected account closings and verify every monthly amount.
