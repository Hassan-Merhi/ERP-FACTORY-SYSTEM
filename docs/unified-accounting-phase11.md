# Unified Accounting — Phase 11: Professional Financial Statements

**Branch:** `feature/unified-accounting-erp-factory-rentals` (same branch as Phases 1–10).  
**Status:** Source implementation and routes committed. **No CI, tests, compilation, merge, rebase, deployment, posting, production voucher changes, migration execution, cutover activation or financial repair were performed.** Claude owns independent verification/certification.

## Scope and accounting standard of evidence

Phase 11 provides one standalone-company **provisional, readable financial statement package** in ERP, Factory and Properties. It **reuses** the one balance engine, fiscal-close exclusion, original historical USD amounts and linked party attribution. It does not make a second financial ledger or conflate operational Net Position with booked accounts.

The package contains:

1. **Statement of profit or loss:** original posted revenue, cost of sales (COGS), gross profit, indirect/other income including realized FX gain/loss accounts where correctly classified, operating expenses, and provisional period net result.
2. **Statement of financial position:** assets, liabilities, equity, remaining unclosed P&L earnings, unclassified accounts, total equity including those earnings, and *the actual unexplained trial balance difference*.
3. **Statement of changes in equity:** brought-forward equity including any prior unclosed P&L, current period net result, other posted equity movements requiring original-source attribution, ending equity, and arithmetic reconciliation. It does NOT guess that a residual is capital contribution or dividend.
4. **Cash-flow classification workpaper:** posted cash/bank movement at historic USD basis, visibly separated into preliminarily operating, investing, financing and **unclassified** cash changes, plus opening/closing cash and a reconciliation to the canonical cash-account movement. This is NOT a certified IAS 7/GAAP cash flow statement.

### Accounting source and date basis

The shared `loadBalanceRows(tx,{companyId,from,asOf})`, `buildTrialBalance`, `financialStatementCategory` and `isIndirectIncome` remain authoritative. No custom query invents an opening balance. The balance engine uses:

- master record opening with the appropriate Dr/Cr side **once**;
- effective date `COALESCE(vouchers.effective_date,vouchers.voucher_date)`;
- only **live, nonoptional** vouchers belonging to the current company;
- historic USD `base_debit_amount/base_credit_amount` with the established legacy fallback to recorded debit/credit;
- canonical line attribution ledger > bank > fixed asset > supplier > employee > factory supplier > customer, preventing master/linked ledger duplication;
- nonledger parties under their debit-positive/credit-positive ownership and actual signed closing side.

**Balance sheet** includes fiscal closing journals: they transfer P&L to retained earnings and must remain in the closing trial balance. **Income statement** uses the canonical `excludeFiscalClose:true` rule to show real period revenue/COGS/expense even after a fiscal closing entry. Consequently, the year does not appear to have zero sales merely because the year-end voucher posted.

All report numbers are denominated in the company's **functional USD book currency**. A company with another functional base currency is refused until a reviewed translation policy exists. Posted transactions retain their original historical FX; no use of today's rates to restate past income, COGS, inventory or expenses.

### Income statement specifics

- `COGS` / `RETAIL-COGS` or explicitly classified COGS accounts are separately reported as **cost of sales**. Generic `Direct Expense` does not automatically become inventory/COGS.
- `Indirect Income` and recognized historical `OTHER_INCOME` / `FX-REALIZED` codes are displayed **after gross profit**; they do not inflate trading revenue/gross margin.
- Operating expense uses the remaining accounts actually classified as Expense by the canonical shared classifier. No deductions are estimated for stock movements or potential future liabilities not posted in the ledger.
- Period profit = revenue − cost of sales + other income − operating expenses, by decimal arithmetic. It is not a company-wide Factory gross/selling-value Net Position number.

### Balance sheet specifics

- Assets and liabilities are determined from the **actual closing debit/credit sign** of each classified bank/asset/liability/party row; a supplier advance is an asset, and a customer prepayment is a liability.
- Ledger equity is credit-positive. Income and expense closing balances (including retained amounts not yet closed in a fiscal year) are grouped once as **unclosed earnings** and included in total equity only once.
- Rows with unknown ownership/type are visibly **unclassified**, not moved to arbitrary retained earnings or Miscellaneous. The difference remains explicit.
- If the original trial balance is unbalanced, the statement remains unbalanced; no balancing correction is posted. The original unexplained amount and opening-side assumptions are disclosed.
- The report now exposes **two separate differences**: reported assets − liabilities − equity **before** unclassified accounts, and the remaining canonical ledger difference **after** displaying the signed net of unclassified accounts. An unclassified account prevents the balance sheet's `balanced` flag from passing even when those unknown balances offset to zero. Phase 14 retains the second (ledger residual) value as its existing `unexplainedDifferenceUsd` compatibility field; the Phase 11 screen and CSV show both differences.

### Statement of changes in equity

- Opening total equity is the opening master + brought-forward movements of equity *and P&L* accounts at the requested period start.
- Current period net result comes directly from Phase 11 period P&L, with fiscal-close transfers excluded.
- Residual other *booked* movements is reconciled arithmetically to ending total equity, **not labeled as a verified owner contribution/dividend**, because source voucher provenance is required.
- Ending total equity agrees with the balance-sheet equity including unclosed earnings. Prior comparative periods use the same rules.
- The report exposes its reconciliation difference; does not change the retained-earnings voucher lifecycle.

### Cash-flow workpaper: source verification and conservatism

The report uses the actual posted bank/cash account journal entries in the selected period. It classifies a voucher to operating/investing/financing **only when it has exactly one noncash counterparty line**, a nonzero signed cash delta, and that counterparty belongs to an unambiguous recognized class. Other vouchers — including mixed journals, multi-purpose payments, bank-to-bank transfers, asset accounts with unclear purpose and shared-group transactions — remain **unclassified**. A classified voucher must have **exactly one cash line and exactly one noncash line**, to prevent two-bank-line journals from receiving a false simple-counterparty label.

- Operating: simple posted income/expense/customer/supplier/payroll/inventory and similar operating counterparties.
- Investing: single posted fixed-asset counterparty.
- Financing: single posted loan/equity counterparty.
- Unclassified: multiple or ambiguous counterparties, any netted transfer, unmatched provenance. The unclassified balance is part of actual cash movement; **it is never silently discarded**.
- A separate cash-account movement is read from the **canonical bank/cash BalanceRow**'s period Dr−Cr, including explicit `bank_accounts.linked_ledger_id` relationships even when a linked ledger's displayed type is an ordinary asset. Its difference from voucher-level cash movement is reported and blocks certification if over USD 0.01. Neither cash account naming nor inferred labels can substitute for a verified bank link.
- SQL aggregates across all source vouchers; only the displayed drilldown is limited to the latest 250, with clear truncation indication.
- Currency/cash-equivalent policies, internal cash transfers, FX effects, dividends, investing capitalization, fixed-asset disposals, tax and interest categories must be independently certified before labeling the statement GAAP/IAS 7 compliant.

### Prior-period comparison

- If comparison enabled, the report calculates an **immediately preceding period of equal number of calendar days** to the selected inclusive date range.
- Each period is derived from the canonical booked ledger, with its own period beginning, ending, fiscal-close and equity carry-forward treatment.
- The comparison account breakdown uses the **union** of current and
  previous-period accounts. Accounts that existed only in the comparison
  period are not hidden from the table/CSV just because their current
  movement or balance is zero.
- CSV export quotes every field and prefixes formula-like **text labels**
  to prevent spreadsheet formula execution; ordinary negative numeric USD
  values remain numbers.
- Comparison column is labelled *comparison*, not automatically a matching prior fiscal year.
- Past-day results use current surviving voucher/master history (a **retrospective** view), not a complete immutable system-time snapshot. Phase 10's historical caveats continue to apply.

## Implementation

New services/routes/UI:

- `server/services/accounting/professionalFinancialStatements.ts`: standalone financial statement engine and conservative cash-flow classification.
- `server/routes/professionalFinancialStatementRoutes.ts`:
  `GET /api/accounting/statements/professional?fromDate=YYYY-MM-DD&asOfDate=YYYY-MM-DD&compare=true|false`.
  Protected by Admin/Owner/Developer, the company selected in the authenticated session and a **transaction-level company scope check**. Dates are calendar-validated, fromDate must not exceed asOfDate, and future dates beyond the company's business day are rejected.
- Read-only historical FX readiness is attached to the response **separately for the current and comparison accounting cutoffs** (`historicalFx` and `comparisonHistoricalFx`, the latter `null` when comparison is disabled). Its existing pure-legacy compatibility mode is **not** proof that historical USD base amounts are fully verified; each period's warning/blocker and notes say so explicitly.
- `client/src/pages/ProfessionalFinancialStatements.tsx`: responsive 4-section financial report, comparative account lines, controls/disclosures, optional prior period, CSV export of complete returned account lines, and printable report view. Export is browser-side only; no financial record modifications.
- Registered `registerProfessionalFinancialStatementRoutes` in `server/routes/applicationRoutes.ts`, with Factory Accounts/View gate in `server/middleware/sharedFactoryAccessBoundary.ts`.
- Linked from the shared Accounts page, ERP and Properties accounting navigation, plus Factory's authorized Accounts route registry.

**New routes:**

| Module | UI path |
| --- | --- |
| ERP | `/accounting/statements` |
| Factory | `/factory/accounting/statements` |
| Properties | `/properties/accounting/statements` |

**No schema changes are required by Phase 11.** The package reads the already-existing posted voucher and master opening rows.

## Financial integrity and limitations

These statements are **PROVISIONAL_NOT_CERTIFIED**. They cannot become formally audited or statutory statements from display improvements alone. In particular:

- The balance sheet may include master openings not backed by double-entry vouchers. Its actual difference remains visible; Phase 13 controls period closing and beginning balance verification.
- Operational stock valuation, purchase containers, Factory daily production and rental charges must not be added on top of recorded GL cost or receivables. The Phase 6/7/8 services show those operational values separately and Phase 11 does not double-book them.
- Customer and supplier foreign-currency rate completeness, provisional stock cost, historical FX legacy backfill and opening account classifications require verification. No speculative conversion of old transactions.
- Formal **group consolidated** financial statements require eliminating intercompany trading, loans, unrealized intra-group stock profit and investment/equity by source documents. Phase 9's group workpaper is intentionally separate.
- Management net position's Inventory-at-Cost/Selling toggle does not change the financial statements: the ledger balance sheet remains **cost/booked-basis**.
- There is no claim that "cash movements by journal counterparty" is fully classified cash flow, nor that other equity movements are all owner capital transactions.
- Zero cash-flow reconciliation difference is necessary but **not sufficient** for GAAP/IAS 7 cash-flow certification.

## Claude independent certification (NOT run)

1. Compile TypeScript/React, confirm all imports, route registrations and tab rendering.
2. Verify permissions: Admin/Owner/Developer and authenticated selected company only; Factory shared Accounts/View access, Properties role parity, and React Query company-specific cache keys.
3. Confirm current and comparison reports against the existing trial balance and financial reports for the **same** company/effective date, including current earnings and opening balances.
4. Check historic debit/credit signs for asset, bank, linked bank, customer credit advances, supplier prepayments, liability debit balances, equity contra accounts and credit notes.
5. Test fiscal-close periods for P&L and balance sheet: closing journals excluded from current P&L but included in retained earnings and original trial balance.
6. Confirm sales revenue excludes Indirect Income and realized FX when calculating gross profit, COGS is not all Direct Expense, and accounting profit equals the stated categories.
7. Confirm equity bridge reconciles when capital contributions, drawings, retained-earnings transfer and income-statement closing journals coexist; label residual correctly.
8. Cash-flow reconciliation: single receipt/payment; multiple counterparties; **one noncash line plus two cash/bank lines must be unclassified**; bank linked to ledger; fixed-asset purchase; loan principal; source entries with missing book currency; invalid FX and unusual reversal postings.
9. Ensure aggregate cash-flow totals cover all vouchers when sample is capped at 250; no double-counted bank and cash master openings.
10. Verify source `base_debit/base_credit` for migrated non-USD postings; current and immediately preceding periods must use **their own historical FX readiness cutoff**, with comparison warnings/blockers visible, and pure-legacy compatibility must never be presented as verified conversion.
11. Confirm month-end/year-end, leap year, partial periods, comparative period boundaries and company business-date cutoff.
12. Compare ERP and Factory production/cost controls, finalized-only invoice/charge posting, rental tenant/landlord, and company-separated intercompany loans to avoid duplicate asset/revenue recognition.
13. Print layout and Excel-friendly CSV export, including Unicode and negative values.
14. Confirm that **NO GET** path, print or export posts/edits any production financial voucher, cash/bank balance, inventory quantity, FX rate, fiscal close or source record.
15. For unclassified financial-position accounts (one debit, one credit, net zero, and both nonzero), verify the two displayed differences, report/CSV values and `balanced=false`; Phase 14 must continue to read the existing ledger-residual field without changing its contract.
16. Full CI/test/build and eventual source and accounting certification are left explicitly to Claude; do not merge/deploy before signoff.

**Phase 11 implementation and the subsequent conservative cash-flow, balance-sheet disclosure and comparative FX hardening have been committed on the existing feature branch.** They have **not** been compiled, tested, independently financially certified, merged or deployed. Claude remains the required certification owner; no financial voucher, inventory, cash/bank or historical source record was changed by these source-only commits.
