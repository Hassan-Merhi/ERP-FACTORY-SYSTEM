# HMD factory worker advances — backend ledger investigation

Investigation date: **2026-11-03**. Production company **12**, account **796**
(`Factory Worker Advances`). Audit read-only against the actual Render Postgres
instance `erp_db_qscj_64lv_e7rz_8744_2lm3`.

**No UI change, ledger display override, fake balance entry, or automatic
general-purpose adjustment is part of this work.** The ledger and copied/exported
values must reflect real posted, balanced accounting vouchers.

## Source snapshot

| Source | Amount |
| --- | ---: |
| Payroll: five advances outstanding | **$2,515.00** |
| Account #796 opening, Dr | $299.99 |
| Live account #796 debits | $91,201.90 |
| Live account #796 credits | $75,301.95 |
| Account #796 closing, Dr | **$16,199.94** |
| Current mismatch | **$13,684.94** |

The earlier screenshot showed $16,248.33, $48.39 higher. Advance #103
($48.39, paid) and its original payment voucher were deleted on Nov 3 at
06:48:10 UTC. The payroll deduction remained.

## Three independently verified missing accrual credits

| Period start–end | Workers (paid) | Required advances credit | Current credit | Missing |
| --- | ---: | ---: | ---: | ---: |
| 2026-08-01 – 2026-08-31 | 91 | $13,240.00 | $0.00 | $13,240.00 |
| 2026-09-01 – 2026-09-18 | 1 | $33.33 | $0.00 | $33.33 |
| 2026-09-01 – 2026-09-30 | 92 | $18,051.00 | $17,851.00 | $200.00 |
| **Total missing** | | | | **$13,473.33** |

August has 91 payrolls marked PAID with no PAYROLL-GEN accrual. September
18 is also missing its period accrual. The September 30 accrual is for 91
workers even though the payroll table has 92. A separate unposted $0.01
deduction exists in May 2026 and is **not** approved for this repair.

## Backend-only approved repair

`server/startup/runApprovedFactoryWorkerAdvanceLedgerRepair.ts` executes
only when all are true:

- Render service ID equals the production ERP service
  `srv-d6kibgtactks739u7vl0`;
- PostgreSQL current database name is exactly the approved original;
- `FACTORY_ADVANCE_LEDGER_REPAIR_20261103=approved-company-12-accrual-v1`;
- company-12 expected period row counts, saved advance deductions and live
  journal totals match every reviewed before-image.

Under a tenant posting scope and a transaction lock it uses the existing
`rebuildPayrollGenVoucher` service to create/replace **balanced** salary
expense / Payroll Payable / Factory Worker Advances accruals. The same
transaction verifies exactly one correct period accrual and that the worker
advance outstanding amount has not changed; anything unexpected aborts the
whole correction. On a subsequent boot all three periods are already
reconciled and no additional vouchers are written.

There is **no new API write endpoint, UI control, background scheduler,
bank/cash adjustment, supplier-balance adjustment, worker payroll rewrite, or
opening-balance rewrite**.

The repair necessarily changes salary expense and Payroll Payable for the
missing historical accruals. This is not a display-only correction. It must
not be represented as financially neutral to those two accounts.

## Residual exceptions — do not silently plug

If no new unrelated vouchers are posted, the three approved accruals would
reduce the worker-advance account from $16,199.94 to **$2,726.61**, compared
with the operational $2,515.00. **$211.61 remains unresolved.**

Investigations identified:

- Worker #180: $160 original advance, stored paid, no corresponding payroll
  deduction or manual repayment. Needs source confirmation of how settled.
- Worker #72: two $100 advance rows (#267 and #272) but only $100 payroll
  deduction. The earlier advance has no linked cash account and there were
  prior same-day reversals/voids. Do not presume a duplicate payment.
- Worker #111: historical $48.39 advance deleted after screenshot, but the
  associated payroll deduction remains. Undo/restore requires a separate
  verified financial decision.
- Account #796 contains $299.99 opening balance, edited manually July 10.
  Its proper treatment cannot be inferred from the screen comparison.
- Advance payment vouchers are missing for records #3 ($200), #267 ($100,
  no assigned cash account), #274 ($88). A $88 repayment ledger credit may
  also be absent; these should **not** be posted to guessed cash accounts.
- A separate account #897 (`Factory Advance Adjustments`) has $2,052.69 in
  debits; do not combine it with account #796 without source accounting review.

**Current status:** Back-end repair is coded and opt-in, but no production
database write occurred during this investigation. Do not claim that the
figures match until a live post-apply check confirms every accounting source.

## User constraint superseding original dated voucher proposal

Owner instruction (November 3): **Cash is correct; do not change it.** Previous PR
#2785 was closed, unmerged, and never enabled because its proposed historical
payment vouchers would have credited Cash $248.39.

The replacement backend-only `runApprovedNoCashAdvanceSourceRepair` performs
**source-record correction only**, not financial posting:

- **2026-05-16:** restore advance #103 ($48.39, fully recovered by PAID May
  payroll #686). The original PAYMENT voucher #7838 remains retired;
  no replacement voucher and no Cash movement.
- **2026-06-15:** void duplicated/unvouchered advance #267 ($100); preserve
  advance #272 with its original cash voucher #9849 and payroll #783 deduction.
  Void the June 15 daybook row with a zero amount on its existing date.
- **2026-07-16:** reopen the existing $160 receivable on advance #277.
  The original July 16 voucher #10739 remains unchanged, and July payroll
  #931 has zero recovery. No Cash movement.

Before exact reconciliation: original advances $91,589.90, operational
outstanding $2,515.00, ledger $2,726.61. Source-only after-image must be
original advances $91,538.29, operational outstanding $2,675.00, with the
**Cash debit, credit, and opening balance exactly unchanged**, the whole
ledger unchanged at $2,726.61, and payroll deductions/manual repayments
unchanged. A **$51.61 residual** is deliberately left for a separately
documented accounting determination. Posting it against Cash, Payroll Payable,
a supplier, or a generic adjustments account without evidence is forbidden.
No financial voucher is dated today or created by this source repair.

The code runs within one transaction with original voucher checks, original
worker/date/amount checks, closed-period protection, original-date daybook
annotation, audit history, a one-time marker and before/after assertions.
The only activation switch is
`FACTORY_ADVANCE_SOURCE_REPAIR_NO_CASH_20261103=approved-company12-historical-source-only-v1`.
It must not be enabled unless the merge checks and live preconditions pass.


## Dated $51.61 ledger correction — verified source analysis (November 3)

After the source-only no-Cash repair (audit #82191, #2786), original worker
advances total **$91,538.29**, repayments **$173.00**, payroll deductions
**$88,690.29**, and worker outstanding receivables **$2,675.00**. The posted
worker-advance ledger still has a $299.99 debit opening, $91,201.90
in active voucher debits and $88,775.28 credits, net **$2,726.61**.

The $51.61 overstatement is supported by *two different causes*, and is
NOT resolved by new cash receipts or payments:

1. **May 17, 2026 — $0.01 payroll recovery:** worker advance #131
   was issued for $239.36 on May 16. PAID payroll #669 recovered
   $239.35 for May 1–16, and PAID payroll #672 recovered the remaining
   $0.01 for May 17 (with net salary -$0.01). Accrual voucher #7904
   on May 1 covered the May 16 payroll. No May 17 recovery voucher
   exists. Post May 17 **DR Payroll Payable $0.01 / CR Worker Advances
   $0.01** to record the exact existing paid payroll recovery.
2. **July 10, 2026 — $51.60 unsupported prior opening:** developer
   audit #3659 changed Worker Advances opening from zero to $180.01,
   and #3660 changed it to $299.99 approximately 43 seconds later.
   Original advance #3 ($200 dated March 12) has no surviving active
   disbursement voucher, and the original May 16 $48.39 voucher for
   advance #103 was retired after deletion, leaving total missing
   active debits **$248.39**. The opening balance exceeds those source
   debits by **$299.99 − $248.39 = $51.60**. This is an overstatement
   of opening worker receivables after source reconciliation, not a
   new expense or payment. Post a backdated July 10 **DR Opening
   Balance Equity $51.60 / CR Worker Advances $51.60**; account
   #3746 is a dedicated, active Equity ledger with no current postings.

The original $299.99 ledger master opening is *preserved*, rather than
rewriting history. The dated July 10 journal explicitly neutralizes
the unsupported excess with its true opening equity counterpart.
The March/May historical source records and the archived May voucher
remain unchanged. Cash #707, suppliers, customer balances, payroll
records, worker advances, manual repayments, and all other vouchers
are unchanged. The corrections have their actual processing time in
the audit log and their historical effective dates in the GL.

Expected postcheck: Worker Advances $2,675.00 = worker receivables
$2,675.00, difference $0.00; no change to Cash (as verified by
opening, total posted debits and total posted credits), source
advances, and payroll source totals. Payroll Payable debit +$0.01,
Opening Balance Equity debit +$51.60. The two vouchers together
are balanced: total DR $51.61, total CR $51.61. A single atomic
transaction blocks a partial repair; every required historical
source and before-image is rechecked. Exactly-once protection uses
a stable posting source and an audit marker.

Explicit one-time production switch:
`FACTORY_ADVANCE_GL_NONCASH_RECONCILE_20261103=approved-company12-may17-july10-original-dates-v1`.
This opt-in is **distinct** from the now-complete source-record
correction and is disabled except for its authorized one-time run.
