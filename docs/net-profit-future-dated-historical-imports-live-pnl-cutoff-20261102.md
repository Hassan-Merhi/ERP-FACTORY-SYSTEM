# Net profit live as-of report fix — 2026-11-02

## Problem and evidence

The current `GET /api/stats/net-profit` endpoint used `toDate=null` for its unfiltered live report. Its grouped ledger query previously had **no date cutoff** when `toDate` was null, so future-dated posted import vouchers were included in today's P&L.

Company 12 independently verified in both databases at the November 2, 2026 reporting date:
- `FACTORY-IMPORT-115-1` effective November 11, 2026 — **USD 7,676.14** expense debit.
- `FACTORY-IMPORT-102-1` effective December 11, 2026 — **USD 7,789.18** expense debit.
- **USD 15,465.32** total future-dated debits to `FACTORY_IMPORT_COST`. There are no other future-dated income/expense ledger rows in the inspected dataset.

The historical goods and commission entries remain fully posted and must **NOT** be reversed, rescheduled, reclassified or deleted merely to fix the live as-of report. Supplier and named-creditor balances are authoritative and immutable.

## Scope of the fix

The report already computes the current business date in `Asia/Beirut`. The endpoint now passes that date into the existing loader as a separate **live P&L cutoff**.

In the grouped read query, debit/credit amounts for nonclosing voucher entries effective after the business date are subtracted **only** when building the P&L account-balance map. The unchanged, complete activity remains the source of `accountBalances`, which existing supplier/creditor/net-position paths consume.

- Explicit `?toDate=YYYY-MM-DD`: retains its existing inclusive as-of date for both maps.
- Unfiltered live report: keeps original all-time account and supplier balance map, while profit-and-loss account movements exclude future-dated income and costs.
- Legacy two-argument loader callers retain their existing behavior; they do not automatically receive the live cutoff.
- Both the historical base-currency aggregate and its legacy debit/credit fallback receive identical treatment.
- No voucher, supplier, creditor, company, stock-cost, date, exchange rate, or ledger metadata changes. No automatic posting, cron or migration is added.

The live P&L will **not** treat the two later import debits as November 2 expense. They still appear in their future accounting periods and in the authorized official posted ledger and audit evidence. This is a reporting fix, **not proof that all historical imports were wrongly expensed**, and not permission to suppress a posted expense from an appropriate financial statement.

## Validation

Source date and 2026-11-02 balance-impact SQL verified against both production instances without writes. A pure policy test covers current vs historical and legacy callers. Full type/build/CI tests still require actual runner confirmation.
