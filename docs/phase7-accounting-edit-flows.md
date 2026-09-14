# Phase 7 — Accounting edit flows

This phase verifies deterministic replacement accounting for the major editable accounting documents.

## Covered behavior

- Payment edits replace the payment account, contra account, amount, date and particulars.
- Receipt edits replace the payment account, contra account, amount, date and particulars.
- Journal edits replace accounts, amount, currency/rate, date and particulars.
- Old voucher-entry row identities must disappear after an edit; edits may not append duplicate accounting legs.
- Every edited voucher must remain balanced in historical base currency.
- Repeating the same supported edit must leave exactly one balanced accounting representation.

The behavioral evidence lives in `tests/accounting-edit-flows-phase7.test.ts` and uses the real Express routes with seeded PostgreSQL rows.
