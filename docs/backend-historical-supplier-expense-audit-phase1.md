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

### Follow-up production SELECT-only verification (November 2, 2026)

- All 86 backfill vouchers are balanced individually (zero unbalanced journals).
- The supplier-credit lines of those vouchers sum to USD 389,442.28. **This does not mean a supplier liability increase of this amount in the combined operational+GL balance**: the original backfill code checks combined balances, but a historical before-and-after snapshot was not recovered.
- **Four** vouchers were entered with voucher dates later than their October 14 creation timestamp: FACTORY-IMPORT-102-1 (Dec 11), FACTORY-IMPORT-115-1 (Nov 11), FACTORY-IMPORT-113-1 (Oct 16), and FACTORY-COMM-68 (Oct 20). The first two remain future dated as of Nov 2.
- All 48 commission source containers explicitly identify commission supplier **27 (NASRA)** and currency **USD**, distinct from some containers' purchase-goods suppliers. The audit now correctly resolves both supplier identities and checks source-versus-voucher mappings.
- For MSBU7553572 and MSNU8402330, recorded offloads occurred in June and July respectively, well before their saved November/December arrival dates. Their historical import expense postings cannot be assigned an accurate earlier business date from the ETA alone.
- Factory freight vouchers for those two containers exist in June/July. The underlying freight debit accounts and subsequent reclassifications differ from the October import journal. These are review candidates, **not proof of a duplicated import purchase**.


Two vouchers remain future-dated as of Nov 2, 2026: MSNU8402330 (Nov 11), MSBU7553572 (Dec 11). Earlier read-only checks found no applied company-12 inventory cutover or GL-FACTORY-STOCK journal to establish that costs were capitalized.

## Later correction gate (NOT implemented)

Only after independent invoice, historical inventory, COGS and accounting-offset proof should a separate reviewed, auditable GL-only journal be considered. Correction must have no supplier, customer, bank/cash or stock movement lines, and must preserve supplier balances, openings, advances and payments. Already consumed goods must not be capitalized as current inventory. Neither deleting vouchers nor hiding expense accounts is acceptable. This audit cannot and does not post any correction.
### Raw-material valuation correction (read-only verification)

The first audit draft incorrectly used the legacy `factory_raw_stock.quantity_kg` as the remaining amount. The actual factory stock valuation uses **each positive `received_kg - used_kg` row**, multiplied by the saved USD cost per kg; it excludes overused negative rows from the raw asset. The private audit now follows that exact rule and reports negative overusage separately.

The 38 historical goods containers, checked on November 2, have:
- 30 containers with no positive raw balance.
- 8 containers with **136,971 kg** of positive raw balance across active raw rows, valued at **USD 124,451.43** using the currently saved cost/kg.
- One separate overused source (container 23 / Germany), **3,516 kg** below zero. This must be diagnosed separately, not subtracted from remaining raw stock.
- Netting the positive and negative quantities yields 133,455 kg, but that is **not the valuation method** and must never be used to book stock or expense.

This is current operational stock valuation, not historical proof of the October 14 inventory balance or a proven USD 124,451.43 expense overstatement. Do not post a capitalization/correction based on this snapshot alone.
