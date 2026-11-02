# Company 12 — historical supplier and named-creditor balance freeze (2026-11-02)

## Nonnegotiable accounting rule

**All supplier balances and named-creditor balances currently verified by the owner are authoritative and must remain unchanged.** This is a stricter requirement than the original October backfill's "combined supplier party balance unchanged" test. Do not reconcile by changing or offsetting any factory-supplier party account, ERP supplier party account, supplier opening balance or memo, bank, customer, payment, or creditor GL account such as `WALMDACLE`.

Account type alone is not sufficient to identify protected creditor accounts: the live `FACTORY_CHARGES_PAYABLE` is stored as `Direct Expense`, although the system registry defines `Liability`. Reclassifying the existing account type in place would alter apparent profit by up to $381,581.45 without economic verification. Do not do so.

## Completed code changes (no financial or stock writes)

1. **The already executed October 14 supplier backfill is permanently inspection-only.** `scripts/reconcile-factory-suppliers-20261014.ts --apply` now fails with `HISTORICAL_SUPPLIER_BALANCES_FROZEN` **before database reading or transactions**. The manual dry-run remains, and the expanded `scripts/audit-historical-factory-suppliers-20261102.ts` is read-only. This prevents a replay when a historical source voucher is retired or when the last future-dated voucher reaches its nominal document date.
2. **All candidate corrections remain vetoed.** The pure `inspectHistoricalCorrectionBalanceProtection` rejects supplier, factory-supplier, bank, cash, customer or other party legs. It rejects all Liability and other balance-sheet ledger types, and separately rejects known and name-coded creditor/payable ledger codes even when misclassified in the chart. It requires a balanced voucher but STILL blocks any proposed adjustment because there is no validated expense-offset source and accounting period. It never posts.
3. **The container #83 / charge #64 duplicate is not reversed.** Both active original vouchers and the deleted previous correction remain exactly as recorded. The $1,692.96 candidate would need Dr `WALMDACLE` / Cr `FACTORY_CHARGES_PAYABLE`; the debit to WALMDACLE **would change the named creditor's balance by $1,692.96**, and therefore violates this rule. No invented debit to stock, suspense, or equity is substituted.
4. **The existing private audit labels the freeze explicitly**: `supplierAndNamedCreditorBalancesFrozen=true`, `maximumAllowedSupplierOrCreditorDeltaUsd='0.00'`, and charge-64 reversal `BLOCKED_WALMDACLE_LEDGER_WOULD_CHANGE`. No route, UI, startup job, financial post, migration, account type edit, or stock cost recalculation was added.

## Specific financial facts and unresolved accounting impact

As verified in production company 12 before this branch:
- Historical goods expense: 38 active vouchers, $356,942.28.
- Historical commissions expense: 48 active vouchers, $32,500.00. Combined: $389,442.28. None is authorized for reversal.
- `FACTORY_CHARGES_PAYABLE` (misclassified as Direct Expense) has 225 active posted vouchers totaling $381,581.45 in debits.
- The only duplicate active POC source family found was charge #64, container #83: original voucher #9309 $1,692.96 and backfill voucher #9341 $1,692.00. The latter matches source charge and daybook $1,692.00. A previously approved-looking correction voucher #15976 for $1,692.96 was subsequently deleted October 19 without a recorded reason, and the October 26 $10,000 WALMDACLE payment is part of the creditor position.
- `WALMDACLE` posted GL debits total $228,261.00; credits $227,277.66; net debit $983.34 before its separately saved Dr opening $1,691.20. Restoring the correction would increase its net debit to $2,676.30 before opening (and $4,367.50 with simple opening arithmetic). This **changes the named creditor** and is prohibited. The October historical-freight correction script has already been frozen to prevent replays.

**There is no currently proven noncreditor offset to remove these expenses without altering another ledger balance.** A balanced debit to another expense would only reclassify the expense and not decrease total P&L costs. A debit to unproved inventory or suspense would fabricate a new balance-sheet claim. Therefore this work intentionally posts **zero** corrections. The audit is evidence-gathering, not an accounting workaround.

## Review and validation

Regression tests include backfill --apply rejection, supplier-party credit/debit lines, protected named creditor ledgers, balance-sheet assets, unbalanced journal proposals, missing account identity, and the full charge-64 preview veto. Source constraints and accounting totals can be rechecked with company-12 scoped SELECT statements; no production mutations or account edits are needed.

The next acceptable corrective journal must have a bona fide underlying transaction, a verified **non-supplier, non-creditor counterpart**, historical period and P&L/BS treatment, fully balanced lines, and **zero delta to every protected supplier and creditor account**. If no such evidence exists, the expenses must remain as recorded rather than change accurate supplier balances.
