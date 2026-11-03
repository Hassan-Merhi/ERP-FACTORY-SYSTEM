# Company 12: operational visibility of completed worker-advance GL reconciliation

## Source-backed identity (2026-11-03)

The backend posted and audited two balanced historical reconciliation journals:

| Voucher ID | Number | Accounting date | Lines |
| --- | --- | --- | --- |
| 17122 | JV-12-2026-000023 | 2026-05-17 | DR Payroll Payable $0.01 / CR Worker Advances $0.01 |
| 17123 | JV-12-2026-000024 | 2026-07-10 | DR Opening Balance Equity $51.60 / CR Worker Advances $51.60 |

Both were actually recorded on November 3, with the historical voucher dates
preserved and audit marker #82244. The resulting ledger and worker advances
outstanding both equal **$2,675.00**. Verified Cash is **$76,840.58**, unchanged.

## Presentation classification only

These two identified, completed **system accounting corrections** do not
need to appear as ordinary operator-created journals in routine voucher/daybook
browsing. The existing company-12 internal-catchup filter is extended using
exact company, voucher ID, voucher number, historical date, and full description;
other vouchers, companies, account movements and later changes to the same
accounts remain visible.

The common exclusion is applied at the database predicate level to paginated
and unpaginated operational Voucher and Daybook lists, Factory Daybook synthetic
voucher entries, the cross-company All Daybook feed, and the selectable
Account Transfer voucher-entry picker. The unpaginated /api/vouchers reader
uses the same identity in JavaScript. No underlying accounting data is changed.

**Never suppress these journals from formal accounting or audit.** They must
remain in the posted General Ledger, account balances, trial balance, balance
sheet, financial statements, official exports, payroll source reconciliation,
and authorized direct-voucher/audit history. In particular, the original
$51.61 difference would reappear if the credits were excluded from balance
math. Routine visibility is not a replacement for financial controls.

No changes are made to payroll calculations, worker receivables, Cash,
suppliers, stored vouchers, or journal entries.
