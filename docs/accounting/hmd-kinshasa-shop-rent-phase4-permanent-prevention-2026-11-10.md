# HMD KINSHASA ERP shop rent — Phase 4 permanent prevention

**Date:** 2026-11-10.  
**Branch:** `fix/hmd-kinshasa-phase4-permanent-rent-accounting-20261110`, based on production-verified Phase 3.  
**Scope:** reusable rental-accounting posting logic and reconciliation across ERP/Factory/Properties, with HMD KINSHASA historical data preserved.

## Fixed defects and protections

1. **Proof-based payable settlement.** `rentalPaymentPostingService` no longer treats any non-null `accrual_voucher_id` as a payable. It validates the actual existing, live, same-company Journal and its Accrued Rent Payable liability credit. Deleted/optional, advance-only and held records cannot be used to make an unsupported AP debit.
2. **Full-month recognition on first partial due payment.** An initial $200 payment of a newly due $500 month posts its normal $200 payment voucher plus `ADV-REC` recognition: Dr Rent Expense $500; Cr Advance Rent Paid $200 and Cr Accrued Rent Payable $300. A later $300 payment clears Dr AP $300 / Cr Cash $300 without another rent-expense recognition. Previously only $200 expense was recognized, no $300 liability was created, and the month was marked accrued.
3. **Prepaid due-date settlement.** If $200 was properly prepaid before billing and $300 is paid after the billing date but before the scheduler's normal recognition, posting verifies prior live payment-voucher evidence, atomically recognizes Dr Rent Expense $500 / Cr Prepaid $200 / Cr AP $300, then clears the $300 AP with the new payment. A stale/ambiguous source refuses to post; no historical payment or asset is edited automatically.
4. **Guarded scheduled and split posting.** Row locking covers the entire payment group; the same contract-level advisory lock used by immediate payments serializes concurrent scheduled postings. Before booking, each scheduled split rechecks existing live posted rent against the expected month's capacity under row locks. Stale overbooked periods, mixed POSTED/SCHEDULED state, prior voucher IDs, mismatched amounts/dates/contract/cash accounts, invalid dates and partial/truncated allocation groups refuse to post. All or nothing is committed. Requests cannot silently mark payment rows POSTED with a null cash voucher.
5. **Vouched allocations, separate guarantees.** Allocation capacity is computed from live POSTED payment vouchers with a monthly-ledger target. Guarantee-only receipts and deleted/no-voucher rows cannot consume ordinary rent. Contracts with unreconciled POSTED rental vouchers are blocked pending manual review rather than silently creating duplicate money. The date-aware earliest outstanding month now uses the contract rent if a stored prepaid month is still held at zero expected rent.
6. **Prepaid scheduler verification.** The due recognition pass row-locks its months and verifies its claimed `paid_amount` against the sum of real POSTED pre-billing rental payment vouchers. It refuses changed rows and mixed prior/post-billing totals; it cannot overcredit Prepaid Rent on a stale cache.
7. **Actual liabilities in reconciliation.** The `balances` response separates module-specific tenant payable, landlord receivable, real posted rent applied against due months, and pre-paid future allocated money. `netOutstanding` is the sum of each due month's positive remainder, never netted against a different customer's or month's excess. `totalAccrualPayablePosted` now reflects the actual **company-wide GL credit-minus-debit balance** on the canonical accrued rent control accounts as of the effective voucher date, not simply the sum of expected amounts stamped with an accrual link.
8. **Additional reconciliation alerts.** Type G flags POSTED rental allocations with missing/retired vouchers. Type H flags payments failing to settle an actual accrued payable, while respecting original valid AP-CLEAR entries and the payment group's own initial ADV-REC journal. Existing A–F alerts remain.
9. **Control accounts fail closed.** Inactive or incorrectly typed rent payable/advance/prepaid/deferred control accounts cannot be selected silently. Nothing auto-reactivates, retypes, creates a new balancing voucher, or rewrites the history to bypass a mismatch.
10. **Explicit billing dates.** Payment and scheduled-posting dates must be real `YYYY-MM-DD` calendar dates; due dates still use the contract's billing day capped at month-end.

## Automated coverage added (not run; owner requested no CI)

- `tests/hmd-kinshasa-rent-phase4.test.ts` — original voucher evidence, hold selection, strict dates and per-month positive-only outstanding.
- `tests/rental-payment-accounting-reconciliation.test.ts` — first $200 due payment against a $500 month, second $300 payable settlement, partial prepaid then due settlement, two competing scheduled payment groups, missing-voucher alerts, refusal to create cashless payments or invalid dates, and guarantee exclusion.

### Live source baseline confirmed by independent read-only Render queries

| Production HMD KINSHASA control | Verified 2026-11-10 |
|---|---|
| Company ID / ERP contracts | 8 / 15, 16, 17 |
| January–November 2026 months | 33 |
| Expected rent and cached paid | $149,160 / $149,160 |
| Valid POSTED rental-month voucher links | 33 |
| Deleted/missing posted rental-month vouchers | 0 |
| January–May reviewed recognition holds | 15 |
| Remaining references to deleted accrual #8534 | 0 |
| Rent Expense #877 | $149,160 Dr |
| Accrued Rent Payable #1401 | $81,360 Dr / $81,360 Cr, net $0 |
| Obsolete payable #918 | no remaining company-8 entries |
| Original rent payment vouchers/cash/guarantees | untouched |

## Deployment, operational and historical safety

- **This Phase 4 branch has not been merged or deployed.** Phase 3 remains completed and live. No production data modifications, migrations or SQL were executed to implement Phase 4.
- **No TablePlus SQL is required.** This is application code and regression tests only.
- No historical voucher (January–November 2026), amount, customer payment, cashbox, prepaid asset, guarantee, monthly hold or audit record was changed.
- Future legitimate payments, accruals and prepaid recognition **will still generate their ordinary accounting vouchers**. The prohibition on new vouchers applies to historical correction work, not to future transactional bookkeeping.
- Existing prepayment paths fail closed on mismatched recorded payment evidence; operators should reconcile such conflicts instead of disabling checks or manufacturing adjusting journals.
- For deployment, review the PR, optionally run the focused tests outside CI, merge, then manually deploy Render service `system` (autoDeploy off). Verify the deployed main commit and the rental APIs.
- Do not run earlier Phase 2/3 historical repair SQL again. The Phase 3 row holds already persist and are respected by both scheduler and posting guards.

## Remaining verification gate

The implementation and tests are committed but **runtime test execution and production rollout are not yet verified**. The user must explicitly authorize the merge/deployment step; this report must not imply those actions occurred.
