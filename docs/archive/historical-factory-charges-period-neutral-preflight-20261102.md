# Factory historical charges — period-neutral GL reclassification preflight (2026-11-02)

This adds a **manual, backend-only, nonposting preview** to the company-12 supplier reconciliation CLI. It cannot write a voucher, alter account classification or modify suppliers. No UI route, migration, startup job or auto-correction is introduced.

## Why an immediate type change is unsafe

The live `FACTORY_CHARGES_PAYABLE` account is typed `Direct Expense`, while the system registry requires `Liability`. All **225** active, nonoptional vouchers currently posted to that account are structurally balanced two-line journals with **no supplier/customer/bank party lines**, and have **$381,581.45 in clearing debits and $0.00 credits**.

If the account's type were changed directly to Liability without reclassifying any corresponding expense, the P&L would appear to improve by as much as **$381,581.45** simply because expense debits were moved out of the expense category. This would also create an anomalous large debit in a liability account. It would **not** prove overstatement or real profit. Therefore **do not retype that account directly**.

The equivalent GL-only conceptual cleanup would have to (a) credit the charges-clearing ledger for every historically supported debit, (b) debit a **source-evidenced, appropriate expense or inventory account**, and (c) only then restore the clearing ledger's intended type after proving the balance and historical financial impact. If the target remains a legitimate expense and the adjustment is recognized in the **same historical accounting period**, the effect on total P&L is **zero**, not a profit increase. Different timing or period closes can change monthly statements; a current-dated bulk journal is not period neutral.

**This report does not approve or create any journal or account-type update.** It supplies the mathematical counterfactual only.

## Source classification, active posted only

| Source | Posted vouchers | Existing Dr Factory Charges Payable | Automatic destination |
| --- | ---: | ---: | --- |
| FACTORY-POC (post-offload charges) | 146 | $200,131.30 | None; requires underlying charge type, landed cost and period examination |
| FACTORY-FREIGHT | 59 | $162,676.50 | Candidate `FACTORY_FREIGHT_EXPENSE` for review only |
| FACTORY-OC | 20 | $18,773.65 | Candidate `FACTORY_OC_EXPENSE` for review only |
| **Total** | **225** | **$381,581.45** | **No approved posting** |

The 225 original journals are balanced, each contains exactly 2 entries, and none has a direct supplier/customer/bank entry. This means a **GL-only** restructuring might be technically possible, but it does not confirm what the debits represent economically. In particular, post-offload charges may require inventory/WIP treatment rather than an expense, depending on recognition history.

## Period preservation

The clearing debits span **February–October 2026**. `effective_date` is null on these 225 vouchers, so the existing `voucher_date` is their source business period. The private report groups the actual effective date (fallback to voucher date) by calendar month and source type, counts balanced two-line vouchers, checks direct party links, and ties aggregate dr/cr to the posted-only account debit and credit totals. It refuses to suggest a correction if source structure or totals differ.

The preview returns:
- per-period current clearing Dr/Cr and conditional (unapproved) equal expense-debit / clearing-credit comparison;
- the **amount by which profit would appear to increase under a type-only change**, explicitly labeled *not a legitimate economic improvement*;
- the **zero-P&L-change conceptual scenario** only when every replacement expense is proven and recognized in the correct period;
- unresolved post-offload target mapping and historical-close blockers;
- `approvedJournal: null`, `approvedAccountTypeChange: null`, `readyToPost: false`.

The separate `FACTORY_RAW_MATERIAL_STOCK` account is also incorrectly saved as `Indirect Expense` instead of `Asset` with **$3,288.00** in four historic manual-purchase debits. It **must not** be retyped automatically: material may have been consumed, and moving the full amount to current assets would be unsupported without historical stock and cost-of-sales reconciliation.

## Execution

```bash
npx tsx scripts/audit-historical-factory-suppliers-20261102.ts
```

The report is emitted to stdout in an explicitly `REPEATABLE READ READ ONLY` database transaction; it accepts no arguments including `--apply`. The new preflight appears under `accountClassificationAudit.clearingPeriodNeutralityPreview`. All actual GL, supplier, customer, stock and bank data remain unmodified.

**Next signoff required for actual financial changes:** verify each charge's source type, original invoice, eligible cost category, affected historical period and close status; recover historical stock/sale cost lineage for any proposed inventory move; require balanced supplier-neutral expense/asset journal preview and trial balance + P&L + balance-sheet tie-outs. Under no circumstances should merely retyping `FACTORY_CHARGES_PAYABLE` be used as an expense correction.
