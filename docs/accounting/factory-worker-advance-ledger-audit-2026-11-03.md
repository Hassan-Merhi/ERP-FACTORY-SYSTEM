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
