# Company 12 — hide completed reconciliation rows in Analytics / Balances (2026-11-02)

## Scope: routine *row display* only
The completed October 14 supplier reconciliation batch is already omitted from ordinary Journal Vouchers, ERP/Factory Daybook, All Daybook, Transaction Journal and Account Transfer pickers. Analytics account drill-down and Balances account statements still displayed the records because those views obtain ledger statements from independent endpoints.

This change hides only the **same exact source cohort** from the routine Accounts/Analytics account-statement and monthly ledger-voucher *row renderers*. It must **not** change the posted amounts in profit, liabilities, creditors, suppliers, cash, assets, balance sheets, trial balances, ledger movement summaries, running balances, opening balances, or closing balances.

- A shared, pure, source-specific classifier recognizes company-12 `FACTORY-IMPORT-<container>-<generation>` with the historical-reconciliation goods description, and company-12 `FACTORY-COMM-<container>(-<generation>)` created on 2026-10-14.
- The paginated and legacy account-statement readers include source `createdAt` and company identity as metadata so later or other-company vouchers are never hidden accidentally. No SQL `WHERE` conditions, amounts, dates or balance engines change.
- The Accounts controller computes **all** posted debit/credit running balances before omitting the internal entries from the rendered rows; its closing balance uses the unfiltered balance, and its original statement metadata is unchanged. This also covers Analytics account links into Accounts, Factory Agents and the mobile/cards/print-visible projection.
- The monthly Ledger Vouchers screen computes all running balances first, then hides just the source batch rows. Original server period totals, opening and closing balances remain untouched.
- Genuine post-offload charges such as `FACTORY-POC-83-64-...` are **not** in the source cohort; do not conceal them under this classification. The separate $1,692.96 identified POC duplicate is still pending independently evidenced creditor-neutral accounting treatment.

## Verified source evidence
At the inspected company-12 production snapshot, both databases retain **86 active vouchers and 172 original posted double-entry ledger rows**, debit **$389,442.28**, credit **$389,442.28**, of which **$389,442.28 is credited to factory-supplier party accounts**. No mutation is needed or authorized.

## Accounting constraints
The visible account and expense totals still **include all legitimately posted historical reconciliations**; hiding table rows must not falsify P&L, supplier/creditor balances, account totals or financial statements. The owner has confirmed supplier balances are correct. No source entries, voucher types, `optional` flags, account types, opening balance, expense postings, or stock cost are changed. Formal ledger statements, full audited exports, and voucher detail/audit evidence continue to contain the complete originals.

New unit tests verify exact goods + commission identities, other-company protection, and a running-balance illustration in which display filtering cannot erase the underlying movements.
