# Company 12: completed historical supplier catchup entries — remaining routine screens (2026-11-02)

## Request
The already-completed October 14, 2026 supplier reconciliation must not appear as ordinary Journal Voucher, Daybook or voucher-entry picker records. Existing suppliers' balances are correct and immutable.

## Exact source cohort verified with production SELECT only
Both accessible company-12 databases contain the same 86 active backfill vouchers and 172 balanced voucher-entry legs (debits $389,442.28, credits $389,442.28):
- 38 goods vouchers `FACTORY-IMPORT-<container>-<generation>` with matching historical supplier reconciliation description;
- 48 commission vouchers `FACTORY-COMM-<container>(-<generation>)` created October 14, 2026.

This branch extends **routine presentation filtering** already deployed in PR #2749 to two missed operational lists:

1. **All Daybook / Transaction Journal**: `GET /api/global/transactions` is built by `server/routes/global/globalDaybookFeed.ts` and uses its own combined multi-company voucher feed. The new SQL predicate runs on voucher rows **before** global grouping, counts, summaries and pagination, with an explicit `company_id=12` guard. A same-named current/other-company voucher stays visible.
2. **Account Transfer voucher-entry picker**: `GET /api/voucher-entries/by-account/:accountId` is a selectable/editable *operational transfer list*. The source cohort is now excluded before the unpaginated query and before both page counts and rows. This avoids presenting past catchup journal legs as candidate account-transfers.

Existing ERP/Factory Daybook and /api/vouchers filters continue to apply. No unrelated completed operational vouchers are hidden.

## Critical invariant

**Do not confuse user-facing hiding with accounting deletion.** No INSERT, UPDATE, DELETE, soft deletion, optional flag, voucher type change, debit/credit change, account transfer, supplier statement change, bank/stock entry change, or expense reclassification occurs.

All original 172 ledger lines remain **posted**, and remain available from the authorized General Ledger, trial balance, official supplier/creditor statements, financial statements, voucher detail and audit history. Any source-backed Factory Daybook event remains visible. Audited exports must continue to include them. This change affects routine list surfaces ONLY.

The underlying $389,442.28 is still booked in historical expense accounts and may require a separately evidenced accounting correction. It is not justified to remove the expense from official P&L by hiding its listing. The $15,465.32 November/December future imports are governed separately by the live net-profit as-of cutoff in PR #2750.

## Evidence and validation
Source identity selected exactly 86 vouchers and 172 GL lines in each company-12 database. The global predicate test asserts a per-row company guard, and the existing tests verify the signature and out-of-cohort bypass. No production transactions were modified.
