# Unified Accounting — Phase 4: Cash and Bank Reconciliation

**Branch:** `feature/unified-accounting-erp-factory-rentals`
**Modules:** ERP, Factory, Rentals / Properties
**Status:** Implemented and committed. No CI/test execution, independent certification, merge or deployment performed; Claude owns checks.

## Architecture and ownership

Phase 4 uses the existing vouchers, voucher entries, Cash/Bank ledger accounts,
bank-account masters, accounting date conventions, and the central posting engine.
It introduces **only statement evidence and matching metadata**. No balancing
voucher, exchange gain/loss, bank fee, cash movement, or GL adjustment is posted
from reconciliation screens or import.

A bank master can hold direct `bank_account_id` voucher lines **or** be
connected to a Bank/Cash `ledger_accounts` row via
`bank_accounts.linked_ledger_id`. Cash/Bank ledger accounts that belong to a
bank master are not offered as separate reconciliation targets. Customer-owned
linked ledger accounts are not offered as cash accounts. For the bank target,
direct bank lines (where `ledger_account_id` is absent) and linked ledger
lines (where it is present and belongs to the bank) are selected **once each**.
This preserves the existing ledger priority
(`ledger_account_id` before `bank_account_id`), rather than counting one
posting twice.

The selected company's identity is sourced only from the authenticated
session, validated on the PostgreSQL transaction scope, and enforced through
tenant RLS on the three new tables. Admin/Owner/Developer roles can use these
routes. Factory requests additionally require the Factory Accounts page access
and View Accounts tab permission. No caller-supplied company ID is accepted.

## Additive schema

`server/services/accounting/ensureCashBankReconciliationSchema.ts`
creates these tables during the always-on schema initialization, which runs
even when production disables bulk migrations:

- `accounting_cash_bank_statements`: company, kind/id of account, currency,
  inclusive period, supplied opening/closing, SHA-256 content fingerprint,
  filename and import actor/time.
- `accounting_cash_bank_statement_lines`: dated bank/cash movements, signed
  amounts, description/reference, optional running balance and auditor review
  category/note.
- `accounting_cash_bank_matches`: one bank statement movement ↔ one live,
  posted voucher entry. A partial unique index prevents an active movement or
  a voucher entry from being matched more than once across any statements.
  A cancellation is a timestamped **void**, with actor/reason retained.

The only initialization writes are schema statements; old balances/vouchers
are not migrated or rewritten. No new bank master or chart account is created.

## Import

Users can upload CSV or XLSX files with the following headers (case-insensitive):

```csv
Date,Amount,Description,Reference,Balance
2026-10-01,1000.00,Customer deposit,DEP-1,1000.00
2026-10-02,-25.00,Bank fee,FEE-1,975.00
```

An alternative is `Date,Debit,Credit,Description,Reference`, where Debit and
Credit must be non-negative, at most one positive per row. Positive Amount
means money in; negative Amount means money out.

Dates must be `YYYY-MM-DD` or explicit `DD/MM/YYYY` (not silently parsed
as month-first). Up to 5,000 transactions, file limited to the existing
10 MiB upload maximum. All transaction amounts use exact `Decimal` math and
at most 6 decimal places.

An import requires an existing bank/cash target, currency, start/end, opening
and closing balances. Before saving, every entry must fall in the statement
period, and:

`opening balance + sum of signed movements = supplied closing balance`

The preview endpoint returns a calculation and does not persist anything.
A duplicate SHA-256 file for the same company and account returns the
existing statement when metadata agrees, and rejects conflicting
period/currency/balance settings. Statement lines remain immutable evidence.

## Reconciliation

A statement detail returns:

- original statement opening, closing and net movement;
- cash/bank book opening at the selected period start, including prior posted
  voucher movements, and the book closing through period end;
- unmatched bank statement entries (including stale matches to retired
  vouchers);
- outstanding/unmatched book entries, such as uncleared payments and deposits;
- adjusted book amount and unexplained residual, **as explanatory values only**;
- exact voucher IDs, voucher numbers, source effective dates and native
  transaction currency validation;
- an explicit `reconcilable` state only when there are no unmatched items,
  other-currency entries or unverifiable money and closing balances agree.

The existing master opening side is preserved. Native opening balance values
are used when historical/native metadata confirms the currency. If a
non-USD opening cannot be valued reliably, the reconciled book totals are
**withheld**, not guessed. Likewise, legacy non-USD vouchers without native
amount evidence are reported as unverified; FX is never inferred.

Matching requires:

1. the same company and selected Bank/Cash target;
2. both the bank statement line and voucher entry be eligible and unmatched;
3. the posted entry be live, nonoptional and dated on/before period end;
4. its original currency be verified and identical to the statement currency;
5. the signed money movement be exactly equal.

Exact repeat of the same active match returns its original matching record;
a conflicting repeat, cross-company match, old deleted voucher, different
currency or different amount fails closed. Mutations are atomic, scoped and
audited. No auto-matching is applied without a deliberate selection. These
initial matching rules intentionally support **one statement movement to one
voucher line**. Bank statement splits, aggregate settlements, cross-currency
netting and FX settlement vouchers are beyond this safe initial posting
boundary; they require a controlled accounting policy, not guesswork.

Unmatching requires a reason, marks the match void and retains both original
statement and voucher entries. Neither matching nor unmatching touches the
cash/bank account ledger balances. Closed-period enforcement is respected on
the *metadata action date*.

### Unmatched bank fees, transfers, receipts and payments

Accountants can mark an unresolved statement line as:
`bank_fee`, `transfer`, `unidentified_receipt`,
`unidentified_payment` or `other`, and store an investigation note.
The categorization is audited and does **not** make a voucher. The screen
links to the existing Create Voucher flow; users can post a real bank fee or
transfer through the normal validated accounting workflow and match it
afterward. No duplicate expense, income, cash receipt or transfer entry is
created automatically.

## API and UI

All API routes are company-scoped, authenticated and privileged.

| Method | API | Purpose |
| --- | --- | --- |
| GET | `/api/accounting/cash-bank/accounts` | Eligible Bank and Cash accounts |
| GET | `/api/accounting/cash-bank/statements?accountKind=bank&accountId=1` | Recent imported statements |
| GET | `/api/accounting/cash-bank/statements/:id` | Lines, book candidates, balances |
| POST multipart | `/api/accounting/cash-bank/preview` | Parse + balance preview |
| POST multipart | `/api/accounting/cash-bank/import` | Persist one idempotent statement |
| POST | `/api/accounting/cash-bank/lines/:id/review` | Categorize unexplained movement |
| POST | `/api/accounting/cash-bank/matches` | Match a statement line to a voucher entry |
| POST | `/api/accounting/cash-bank/matches/:id/void` | Cancel a match with a reason |

UI page `client/src/pages/CashBankReconciliation.tsx` is shared by all modules:

- ERP: `/accounting/cash-bank`
- Factory: `/factory/accounting/cash-bank`
- Properties/Rentals: `/properties/accounting/cash-bank`

Both ERP and Properties navigation have entries. The existing Accounts screen
in **all three modules** links to this page. Factory inherits the established
Accounts page access instead of inventing a separate unrestricted page key.

## Existing accounting rules preserved

- ERP and Factory cash/bank postings stay in the established central posting
  and voucher-lifecycle engines.
- Rental cash postings continue to use their existing monthly contract
  allocation, posted payment and voucher flows.
- FX transaction values and historical rates remain original.
- The bank statement import does not affect GL, payable, receivable,
  inventory, bale profit, customer statements, Factory supplier inside/outside
  balances, Net Position, or month-close journal entries.
- Nothing has been applied to production records, merged to main or deployed.

## Claude certification handoff (NOT executed here)

At minimum, Claude should independently certify: TypeScript build, all
route/role/Factory-access boundaries, RLS with multiple company scopes,
CSV with quoted columns/BOM, XLSX with Date cells, debit/credit signs,
duplicate import replay, overlapping periods, same voucher across two
statement files, debit/credit mixed voucher lines, direct bank vs linked
ledger posting, opening FX evidence, unverified legacy foreign currency,
closed periods, retired voucher stale matches, review metadata audit,
and UI behavior in ERP/Factory/Properties.

This is code-complete for Phase 4's stated workflow **but unverified** until
Claude performs those independent checks. Merge, deployment, production
backfill and accounting adjustments are expressly excluded.
