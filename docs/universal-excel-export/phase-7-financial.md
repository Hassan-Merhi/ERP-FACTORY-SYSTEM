# Universal Excel — Phase 7 financial workbooks

**Branch:** `feature/universal-excel-export-system`
**PR:** [#3204](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/pull/3204) — draft, do not merge.
**Scope:** Financial Excel exports for ERP, Factory and Properties: voucher summaries, daybooks, customer/supplier/agent account statements, payroll, rental payments, Cost Centers, P&L, Net Position and FX.

## Full shared-engine migrations

- **Voucher payment and receipt exports:** `client/src/pages/vouchers/voucherActions.ts` — summary and detail; original account, voucher date and narration columns; numeric `Amount` / `Total Amount` fields instead of formatted strings. Zero valid entries remains an error; no vouchers are created by export.
- **Factory Daybook:** `client/src/pages/factory/daybook/factoryDaybookExports.ts` — one-sheet summary and grouped-per-type detailed workbook; original transaction/base currency amounts and six-decimal FX rates; numeric DR/CR columns without collapsing the sides. A linked journal fetch failure or missing entries now **fails closed** rather than presenting a summary line as a detailed journal. No records or postings are modified.
- **Cost Center exports:** `server/routes/costCenterReportingRoutes.ts` — same five views (`activity`, `summary`, `departments`, `accounts`, `months`), permission/company scope, filters and 5,000-row limit. Native USD/numeric columns are true Excel numbers when safe; large historical high-precision FX numbers remain exact text. Existing CSV/PDF paths unchanged.
- ERP Daybook, ERP Supplier Ledger and related Phase 5 operational financial views already use the shared report helper. Existing role-based UI export controls are unchanged.

## Nonstructural shared financial branding

`shared/universal-excel/financialWorkbookStyle.ts` applies opt-in Dakzo creator and print-header styling without changing worksheet rows, column order, report values, formulas, DR/CR sign conventions, currency conversion, number formats, Excel chart/print ranges, conditional debit/credit colors or frozen panes.

The bridge is now used in:

- **ERP Account Statement** (including the historically denominated `Currency Detail` audit tab; native and base amounts remain in distinct columns).
- **Factory Customer Statement**, including customer document branding, date/opening/B-F balance and ledger/not-yet-ledger splits.
- **Factory Supplier Broker Statement**, with separate currency tabs, commission/freight/FX in/out and consolidated summary.
- **Properties Rental Statement**, including monthly rent expected/paid/outstanding, receipt history, deposit activity and tenant name.
- **Factory EUR FX Agent Wallet Statement**, retaining EUR debit/credit, opening/closing and deleted-payment audit-only behavior.
- **Agent Statement** with its exact first-row columns, optional FX rate note and formatted opening balance.
- **Net Position**: per-company monthly reports, consolidated all-company report, group net-position report and on-screen Net Position export.
- **Profit & Loss/Net Profit** by month and period, including previous source account classifiers and subtotal formulas.
- **Factory Payroll** run export and payroll preview; no salary/net-payable formulas changed.
- **Supplier Profit Check** supplier export and margin-analysis export.
- **Factory supplier usage** (including empty reports, mixing and supplier balance calculations).

## Critical accounting and permission invariants

- **Only display-layer changes:** no SQL, voucher creation, ledger reclassification, cash balance writes, receipt/payment changes, cost changes, stock mutations or FX revaluation.
- Do not reverse or relabel DR/CR fields based only on cell color. Negative balances, historical EUR rate conventions and signed values remain authoritative.
- Never recompute opening B/F, rent prepaid balances, monthly stock valuations, accounting totals or intercompany receivables in the export layer.
- Report-specific permissions and tenant scoping remain at their existing endpoints. Never send hidden-price/cost fields to the client in order to suppress them visually.
- Fixed-layout invoices, dispatch trip PO import templates, Excel import round-trip forms, accounting posting evidence and dynamic P&L account classification remain untouched.
- Do not collapse currencies into a single amount without an existing conversion rule and source rate.

## Verification and release gates

Added tests:
- `tests/universal-excel-financial-style.test.ts`: DR/CR, negative balances, FX six-decimal data, formulas, filters, currency tabs, exact ExcelJS round trip.
- `tests/ui/universal-excel-financial-adapters.test.ts`: payment/receipt voucher export typing, Factory Daybook summary vs detailed journal, error handling, empty exports.

Existing regression suites for net position, net profit, account statement, rent, payroll and cost centers must remain green. Full review also requires checking real exported workbooks against original system records for both admin and restricted users; no live production data was modified.

**No merge, Render deploy, database migration or SQL was performed.** Full PR localization, branch-sync and integration checks remain release gates before a production rollout.
