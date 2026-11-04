# Properties rent cashbox — safe changeover (2026-11-04)

## Scope
Only Properties landlord rental receipts and guarantee cash movements. ERP and Factory tenant-rental posting policies are unchanged.

## Historical boundary
- **Do not rewrite historical tenant balances, monthly ledgers, receipt vouchers, journal entries, guarantees or intercompany transfer legs.**
- Existing linked intercompany transfers remain auditable and reversible through the original reversal/deletion flow.
- No automatic opening-balance journal, transfer migration, historical backfill or offset is created.
- Original payments remain associated with their original cash accounts.
- Properties “Total Paid” historical snapshot logic remains unchanged.

## New cashbox
- In Properties → Rentals, Admin/Owner/Developer clicks **Create Properties Cashbox**. This invokes the idempotent company-scoped `POST /api/properties/rental/cashbox/ensure`.
- Creates ledger code `PROP-RENT-CASH`, name `Properties Rent Cashbox`, type **Cash**, opening balance **0**, company-scoped. If a deleted or incompatible ledger occupies the code, setup refuses instead of modifying it.
- A new Properties rent receipt must choose an active, undeleted current-company cash/bank/asset ledger. The new cashbox is the UI default; explicit account selections remain allowed.
- Rent and guarantee cash receipts increase the selected local cash ledger through the existing balanced vouchers. Refunds paid from the cashbox decrease it. Rent revenue and tenant deposit recognition retain the existing posting engine.
- New Properties rent/guarantee cash receipts **do not auto-transfer** to another company. Explicit developer-operated cash transfers remain separate manual actions.

## Perspective-only labels
- Tenant arrears (`outstanding`): **green / To Collect**.
- Tenant prepayments (`prepaidCredit`): **red / Owed To Tenants**.
- Refundable guarantee held: **red / Guarantee Held**.
- **Do not negate, swap, or mutate any underlying numeric balances.**
- ERP and Factory rental screens retain their earlier meanings and colors.

## Pre-production checks
1. Snapshot each company's property unit balances, posted payments, cash ledger balances and linked historical intercompany vouchers.
2. Run typecheck, lint, unit tests and the rental payment/reversal integration tests in an isolated test database.
3. On a test company, create the zero-opening cashbox and post a new $100 receipt. Verify one Properties receipt voucher (Dr selected cash, Cr relevant rent/deferred account), no intercompany transfer/voucher, and cash increases $100.
4. Repeat as scheduled and bulk rent receipts and guarantee move-to-cash. Verify no intercompany leg.
5. Refund $20 and verify local cash decreases $20 and tenant deposit liability changes according to the existing refund flow.
6. Check that editing/deleting the new payment reverses the local voucher and tenant allocations without touching old linked intercompany transfers.
7. Compare historical balances against the snapshots. The new cashbox must start at zero, not inherit any previous company cash balance.
8. Reconcile currency-specific posting when receipt currency differs from the account currency.
9. Only then approve release and click **Create Properties Cashbox** in the live Properties company (once). Do not merge or deploy before the tests are satisfactory.
