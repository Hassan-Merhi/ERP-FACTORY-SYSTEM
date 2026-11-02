# Private backend supplier expense audit — Phase 1

Non-invasive review of the company 12 historical supplier backfill created October 14, 2026. No ERP UI, API route, background scheduler, automatic repair, database migration, accounting journal, or write operation is introduced.

## Running

From a trusted backend shell with authorized database credentials:

    npx tsx scripts/audit-historical-factory-suppliers-20261102.ts

The command rejects all arguments including --apply. It uses one dedicated database connection and begins a REPEATABLE READ READ ONLY PostgreSQL transaction. Company 12 is scoped inside the same connection and transaction. It executes SELECT queries only and emits private JSON to stdout. No report is stored in the ERP database.

The audit fails closed if the matching historical set is not exactly 38 goods vouchers and 48 commission vouchers, or if source containers are missing.

## Report evidence

- All 86 source voucher dates, currencies, supplier-linked lines, amounts and expense GL lines.
- Container status, supplier, arrival/creation date, rates, received/used/remaining KG and legacy receipt coverage.
- Other factory-prefixed expense lines associated with the same container (possible overlap, not confirmed duplication).
- Stock journal and perpetual-inventory cutover evidence.
- Flags for future dates, recorded-after dates, amount mismatch, consumed material and expense overlap.
- Each record explicitly sets proposedCorrection to null and reviewStatus to NOT_PROVEN_DO_NOT_POST.

## Verified baseline (read-only production inspection)

| Category | Amount |
| --- | ---: |
| 38 historical goods Direct Expense debits | $356,942.28 |
| 48 historical commission Direct Expense debits | $32,500.00 |
| Combined Direct Expense debits | $389,442.28 |

These figures represent posted expense debits, **not** proven duplicate or overstated amounts. Their exact financial correction remains unknown.

Two vouchers remain future-dated as of Nov 2, 2026: MSNU8402330 (Nov 11), MSBU7553572 (Dec 11). Earlier read-only checks found no applied company-12 inventory cutover or GL-FACTORY-STOCK journal to establish that costs were capitalized.

## Later correction gate (NOT implemented)

Only after independent invoice, historical inventory, COGS and accounting-offset proof should a separate reviewed, auditable GL-only journal be considered. Correction must have no supplier, customer, bank/cash or stock movement lines, and must preserve supplier balances, openings, advances and payments. Already consumed goods must not be capitalized as current inventory. Neither deleting vouchers nor hiding expense accounts is acceptable. This audit cannot and does not post any correction.