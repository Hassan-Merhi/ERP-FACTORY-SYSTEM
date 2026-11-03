# October 2026 HMD factory salary expense / paid payroll reconciliation

**Scope:** HMD Beirut factory, company 12, 2026-10-01 through 2026-10-31.
**Source:** Render production Postgres, read-only as of November 3, 2026.
**Safeguards:** Do not modify posted cash, salary advances or GL without
verifying the balanced journal treatment and individual worker payment history.

## Source-level reconciliation

| Population | Records | Net cash wages | Settled salary advances | Total |
| --- | ---: | ---: | ---: | ---: |
| Active workers, complete PAID October period | 94 | $26,476.66 | $18,594.00 | $45,070.66 |
| Inactive/former workers, legitimately PAID partial period | 8 | $894.22 | $200.00 | $1,094.22 |
| Active workers, overlapping additional PAID partial period | 3 | $155.81 | $280.00 | $435.81 |
| DRAFT partial period, no payment evidence | 3 | $76.26 **not paid** | $506.00 recorded deductions | $582.26 **not cash paid** |
| **Total all payroll records** | **108** | — | — | **$47,182.95** |

The salary-expense Analytics account screenshot showed $47,182.95, matching
the gross sum of these records, not proof that the journal entries have been
individually verified. This is an *accrual expense*, distinct from actual
paid cash. All 11 partial PAID payrolls have individual matching Daybook
`PAYROLL_PAYMENT` records (sum $1,050.03 net cash). The 3 DRAFT payrolls
have none. Full-month PAID workers have 94 matching payment entries totaling
$26,476.66 net cash.

The authoritative reconciliation categories are:
- **$46,164.88** canonical fully paid wages + already settled advances for
  94 active and 8 former workers, with overlapping paid periods selected only
  once per worker.
- **$435.81** PAID overlap requiring manual characterization before
  reclassification: payroll IDs **1180, 1183, 1185** (worker IDs 69, 140, 224).
  These payments and associated $280 advance deductions must not be erased.
- **$582.26** DRAFT salary accrual requiring status/advance-ledger review:
  payroll IDs **1174, 1182, 1184**. They are not cash payments and must never
  contribute to a "paid salary" KPI. Draft advance deductions total $506.
- **$1,094.22** genuinely paid partial payroll for former workers should stay
  as valid payroll and Daybook expenses: payroll IDs
  **1175, 1176, 1177, 1178, 1179, 1181, 1186, 1187**.

$47,182.95 - $46,164.88 = **$1,018.07** requiring accounting review
($435.81 overlapping paid periods + $582.26 draft accruals).
The correct cash total across *all* PAID workers in these exact payroll
periods is **$27,526.69** (including $155.81 of overlapping cash).

## Backend prevention and visibility
The attendance API now exposes a read-only `payrollReconciliation` object
with separated active paid, former paid, overlapping paid, DRAFT unpaid,
other unpaid, cash paid and missing Daybook evidence. The existing 94-worker
attendance grid is unchanged.

Both factory payroll generation paths reject overlapping periods per worker
(including outstanding drafts) with HTTP 409 before posting accounting
entries or applying salary advances. The company-wide advisory transaction
lock serializes concurrent generation.

## No unauthorized ledger reclassification
A PAID payroll with a matching Daybook voucher cannot be removed to make a
report equal another report. Reclassifying the $435.81 requires establishing
whether the overpayment is recoverable, allocated to a later payroll, or a
legitimate additional wage; it might change employee receivables or worker
advances. Removing the $582.26 draft accrual requires reviewing and
restoring the $506 operational advance deductions together with the proper
liability/expense entries. Such adjustments have **not** been posted.

This report is intentionally not a hidden analytics override: no cash/bank,
supplier, advance, ledger account or voucher has been modified.
