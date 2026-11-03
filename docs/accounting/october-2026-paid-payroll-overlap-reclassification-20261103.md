# October 2026 factory payroll — owner-approved, auditable backend reconciliation

**Company:** HMD factory Lebanon, company 12. **Source:** Render production original ERP database.
**Scope:** 2026-10-01 through 2026-10-31. **No frontend work.**

## Verified journal and payroll evidence

A read-only tenant-scoped startup investigation found seven live October salary
expense vouchers, totaling **$47,182.95**: six period-specific `PAYROLL-GEN`
vouchers totaling $47,148.76 plus one legacy voucher
`PAYROLL-GEN-1791350014361` for the remaining draft $34.19. The journals
are balanced and no posted amount was missing.

94 October full-month PAID payroll rows total **$45,070.66** gross (net cash
$26,476.66 + deducted advances $18,594). Eight former workers' PAID partial
payrolls total **$1,094.22**, which must remain in wages and cash records.

### Independently verified duplicate earned days

| Worker | Earlier period | Duplicate days already in month | Earlier gross | Earlier cash | Advance deducted | Full-month payroll |
| --- | --- | --- | ---: | ---: | ---: | --- |
| #69 | October 1–9 | 9 of the 18 full-month present days | $145.16 | $145.16 | $0.00 | #1202 |
| #140 | October 1–17 | 13 present + 2 half days = 14 of 20 month-equivalent days | $239.36 | $9.36 | $230.00 | #1204 |
| #224 | October 1–17 | 3 of the 14 full-month present days | $51.29 | $1.29 | $50.00 | #1276 |
| **Total** | | | **$435.81** | **$155.81** | **$280.00** | |

The prior PAID payrolls #1180, #1183, #1185 and their full-month payrolls
#1202, #1204, #1276 each have one posted payment journal debiting Payroll
Payable and one matching Daybook cash record. The full-month run was
created on **November 3**, with October 31 as the payment date; the earlier
runs already existed. Therefore the extra $435.81 is not an additional
earned wage for new attendance days. **Do not delete/reverse their genuine
cash payments or wipe the advance deductions.**

## Approved accounting correction

Post two fully balanced, auditable company-12 October Journal vouchers
using the central posting engine, with source identities:
- **October 17, 2026:** Debit `Payroll Overpayments Receivable - October 2026`
  $145.16; credit worker #69's Salary Expense $145.16.
- **October 31, 2026:** Debit the same receivable $290.65; credit
  worker #140's Salary Expense $239.36 and worker #224's Salary Expense
  $51.29.

This reclassifies actual duplicate paid wages as an identified employee
overpayment receivable, to be reviewed for recovery/offset later. It is NOT
a cash transaction, worker advance account change, payroll or Daybook
rewrite, or an untraceable removal of historical vouchers.

**Before:** salary expense $47,182.95.
**After successful posting:** salary expense **$46,747.14** and additional
payroll-overpayment receivable **$435.81**.

The remaining **$582.26** salary-expense/paid-salary difference is composed
of **three DRAFT payroll accruals**, $76.26 unpaid net wages and $506 in
historic advance deductions. Those workers have recorded October attendance.
These drafts have **no payment vouchers** and must not contribute to
"Paid Salary", but earned/unpaid salary accrual is a separate legitimate
accounting category and is **not removed** simply to make an expense ledger
match cash/settled wages. Any subsequent approval/settlement is a distinct
workflow, not assumed here.

## Controls

Execution is opt-in through
`OCTOBER_2026_PAYROLL_OVERLAP_RECLASS=approved-company12-backdated-overpayment-v1`
on Render service `srv-d6kibgtactks739u7vl0` and the verified production
database only. Pre-transaction checks revalidate payroll amounts, statuses,
periods, paid dates, both payment vouchers and Daybook entries for all six
payrolls, matching attendance day counts and monthly rate, per-worker
salary-expense account totals, entire October salary expense, and existing
journal identities. A company-scoped transaction and advisory lock post
exactly two October-dated journals or roll back everything. Postcondition
verifies expected October salary expense, unchanged worker operational
advance balances, and unchanged six-payroll Daybook cash total.

If any source has changed or the period is closed, no correction is posted.
No RLS, audit, fiscal close or cash ledger safeguards are bypassed. All
adjustments remain visible in the normal accounting audit trail.
