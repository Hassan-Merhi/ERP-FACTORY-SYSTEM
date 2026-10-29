# Production Targets bonus accounting: phases 5 + 6

Adds an independent direct payout path for approved per-worker production bonus
allocations in factory_production_bonus_allocations. Keep this branch independent
until the other phases' reviewed-award contract is integrated.

## API contract

- GET /api/factory/production-target-bonuses/payment-accounts: current-company Cash/Bank accounts, Admin/Owner
- GET /api/factory/production-target-bonuses/payments?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD: proposals, approvals, payroll conflict, finalized closure and voucher state
- POST /api/factory/production-target-bonuses/payments: { allocationId, cashAccountId, paymentDate, currency: "USD", confirm: true }
- POST /api/factory/production-target-bonuses/payments/:id/reverse: { reversalDate, reason, confirm: true }

Both posting and reversal use one transaction covering voucher, durable
payment row, Daybook and audit. The unique (company_id, allocation_id) key and
locked allocation prevent duplicate and concurrent payments. An identical retry
returns the same posted receipt. Reversal posts a new counter-voucher, retaining
the original and consuming the allocation claim permanently.

## Accounting and eligibility

Direct payout debits Payroll Deposit Expense (PAYROLL_DEPOSIT_EXPENSE), and
credits the selected company-owned, active Cash/Bank ledger account.
It requires a finalized End Production closure for the exact day, an approved
allocation with positive extra bales and amount, and available USD funds.
Non-USD is rejected until confirmed native-currency/FX accounting is designed.

## Phase 6 safeguards

The existing factory payroll attachment query excludes every allocation
already claimed by direct payment (including reversed claims).
Direct payment refuses anything with payroll_id set and refuses any
already approved/paid payroll period for the same worker and production date.
The review GET also exposes the number of related finalized payrolls.

Old free-form employee/worker bonuses have no reliable production-allocation
foreign key and cannot safely be auto-matched. Reconcile them manually before
enabling the feature on production; do not deduce a duplicate solely from
matching worker/date/amount.

## Release gate

Phases 1–4 must supply the verified individual target awards and approval
snapshots, with historical linked/unlinked attribution. This service currently
accepts pre-existing approved factory_production_bonus_allocations IDs.
Phase 8 must integrate the award contract and run real-Postgres financial
integration tests, including concurrency, company isolation and linked workers.
Keep the branch unmerged and undeployed until that certification.
