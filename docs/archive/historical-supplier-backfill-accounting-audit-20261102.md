# Historical supplier backfill — company 12 accounting investigation (2026-11-02)

## Scope and evidence

This is a **read-only accounting investigation** of the October 14, 2026 supplier backfill. No production vouchers, balances, supplier master data, stock quantities, dates, or FX rates were changed during the investigation.

- Source: `scripts/reconcile-factory-suppliers-20261014.ts`, previously also invoked by `server/startup/postStartupJobs.ts` when `ERP_RECONCILE_SUPPLIERS_20261014=company-12-approved-87`.
- The production Render database, scoped to company 12, has **38 live historical goods-import vouchers**, all created 2026-10-14 between 06:50:22 and 06:51:15 UTC, that debit `FACTORY_IMPORT_COST` a combined **USD 356,942.28**.
- `FACTORY_IMPORT_COST` is a **Direct Expense** ledger account. These postings therefore flow into expense-based P&L calculations.
- The same run created **48 commission vouchers**, dated as posted, with **USD 32,500.00** in supplier-side commission credits; do not mix them into the USD 356,942.28 goods-import expense subtotal.
- At the time of the original October 14 backfill, three goods vouchers were future-dated relative to the posting timestamp. Two are still future-dated on November 2, 2026.
- No company-12 `gl_inventory_cutovers` row and no matching `GL-FACTORY-STOCK-%` vouchers were found on the inspected primary database. Therefore no GL capitalization offset was established by this audit.
- The original backfill records a supplier debit/credit against operational supplier memos and explicitly rejects any change greater than USD 0.01 in the **combined** supplier balance. This investigation has not independently proven historical supplier balances at the exact posting instant.

## Exact future-dated records

| Container | Supplier | Container ID | Voucher | Posted at UTC | Voucher date | Native import cost | Expense debit USD | Raw received kg / used kg |
| --- | --- | ---: | --- | --- | --- | ---: | ---: | --- |
| MSNU8402330 | TALAL ANAKYKLOS CYPRUS | 115 | FACTORY-IMPORT-115-1 | 2026-10-14 06:50:39 | 2026-11-11 | EUR 6,505.20 | 7,676.14 | 17,980 / 17,980 |
| MSBU7553572 | CYPRUS MODA | 102 | FACTORY-IMPORT-102-1 | 2026-10-14 06:50:31 | 2026-12-11 | EUR 6,601.00 | 7,789.18 | 18,540 / 18,540 |

The dates were copied from `factory_containers.arrival_date`, not sourced from physical receipt. Both containers were created on May 30. Both have received/consumed stock records in June/July, despite the November/December arrival dates. The exact date history/cause of the ETA values remains unproven; do not overwrite them without evidence.

## Why a blind GL reversal would be unsafe

1. **Delete/reverse entire vouchers:** would remove their supplier-side credit, potentially changing the combined supplier balances or causing the memo/GL supplier projection to diverge.
2. **Credit import expense, debit inventory:** falsely capitalizes fully consumed historical material (both example containers show 0 kg remaining).
3. **Credit import expense, debit opening equity/clearing:** reduces reported expenses but creates a new balance-sheet claim without evidence that these costs were already charged elsewhere.
4. **Hide the account from expense reports:** would misstate profit if these really are unrecognized costs.

### Required before correcting historical financial amounts

- Export the 38 goods vouchers and 48 commission vouchers, plus the ledger/account classification and source container inventory chronology.
- Determine, for each cost, whether any other approved GL voucher already recognized the **same** amount and when the materials were consumed or sold. Validate the original supplier invoice and source FX rate.
- Determine the authoritative prior-period COGS/inventory accounting treatment, including production/sales and opening balances, before choosing an offsetting account.
- Prepare a per-voucher proposed **GL-only** correction with equal debits and credits and zero supplier lines, and compare before/after combined supplier balances, account ledger balances, assets, profit, and audit references.
- Apply only those reviewed postings via the central voucher engine with immutable source references and reversal capability; do not delete posted historical vouchers or rewrite raw stock.

## Code protections in this branch

- The legacy supplier backfill can no longer apply automatically during application startup, even if its old environment flag is still set.
- Manual backfill **fails before any posting** if one of its 38 source goods voucher dates is after the Beirut business date. Read-only dry-run reports the offending containers.
- These protections affect future behavior **only**; no attempt is made to silently rewrite the 38 already-posted vouchers or adjust supplier balances.

## Safe audit SQL note

The Render read-only SQL endpoint uses a new connection per query. Company-scoped queries on RLS-protected accounting tables require an explicit company scope within the same SELECT, e.g. a materialized `set_config('app.current_company_id','12',true)` CTE consumed by a LATERAL query. Keep all reads restricted to the authorized company. Do not use ad-hoc production write statements.

## Release gate

Confirm the guards through static review and targeted tests before merging. Historical GL financial adjustments require an independently reviewed, exact, source-matched correction plan; guard deployment **does not** mark financial reconciliation complete.
