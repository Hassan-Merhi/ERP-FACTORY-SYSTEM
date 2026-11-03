# Company 12 October payroll overpayment — management reporting exception

Scope: **HMD Factory Lebanon (company ID 12)**, exact ledger name
`Payroll Overpayments Receivable - October 2026`.

The owner requested that this $435.81 receivable not appear in **Accounts**
or **Analytics** account lists and not count toward the **management Net Position**
totals, detail lines, category totals, or exported management Net Position. This
applies across current and historical date filters once the October postings
are within the selected cutoff, and does not affect any other company or any
other receivable.

The shared company-scoped predicate in
`server/lib/payrollOverpaymentReporting.ts` is used by the Accounts/Analytics
account-list projection and both Factory and ERP Net Position calculation
paths, including historical snapshot and Excel export.

**Accounting integrity:** This is a *management dashboard exclusion*, not a
write-off, reversal, deletion, or reclassification. The balanced October
vouchers #17120 / #17121 and their $435.81 debit to the receivable continue
to exist. The GL, journal-voucher history, audit logs, trial balance and
formal financial statements continue to include this asset. Cash, worker
advances, salary-expense corrections, supplier/customer balances, and payable
balances are unchanged. A formal write-off requires a separately authorized,
documented accounting entry.

Consequently, the management Net Position display for company 12 may be
**$435.81 lower than the booked financial net assets** on dates when both
vouchers are in scope. This difference is intentionally documented here and
must not be silently plugged into cash, salary expense or an offset account.

Validation: exact-name/company-12 isolation; management-report deduction
only; underlying booked receivable remains unchanged.
