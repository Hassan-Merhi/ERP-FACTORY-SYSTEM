# Phase 8 — Accounting cancel/reverse flows

This phase verifies cancellation and exact-reversal behavior for Payment, Receipt and Journal vouchers.

## Covered behavior

- Payment, Receipt and Journal soft-delete/cancel paths execute once and return a replay result on an already-cancelled retry.
- Retrying a cancellation cannot duplicate audit evidence or alter the preserved balanced voucher-entry tombstone.
- Exact reversal is append-only and swaps every debit/credit side while preserving account targets.
- Original plus exact reversal nets to zero per ledger account.
- Retrying exact reversal replays the first reversal instead of creating a second one.
- Reversal-of-reversal is refused.
- Exact reversal of an already-cancelled voucher is refused and creates no voucher or posting marker.

The behavioral evidence lives in `tests/accounting-cancel-reverse-phase8.test.ts` and uses the real Express routes with seeded PostgreSQL rows.
