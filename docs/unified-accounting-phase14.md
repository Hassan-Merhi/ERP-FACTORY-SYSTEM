# Unified Accounting — Phase 14: Unified Net Position & Accounting Dashboard

**Branch:** `feature/unified-accounting-erp-factory-rentals` (continued from Phases 1–13)  
**Modules:** ERP, Factory and Properties / Rentals  
**Status:** Source-level implementation committed. **Not compiled, CI-tested, merged, rebased, deployed or certified. No production vouchers, books, cost basis, stock records, fiscal closures, FX or intercompany records were modified.** Claude is responsible for independent source/financial validation.

## Goal: unify without inventing or double-counting assets

**Booked net position** is exactly posted Assets less posted Liabilities of one authorized company, derived from Phase 11's existing professional financial statement engine and its canonical trial balance and effective-date master opening rules. **Equity including unclosed retained earnings** is shown beside it; the difference is displayed. A difference is **not** hidden with an adjustment, financial plug, cost revaluation or Net Position offset.

**Management net position**, including stock valued at prospective selling price, expected Factory profit, pending bales and non-ledger receivables, is a separate operational management indicator. It must **not** be folded into statutory/posted net assets or historical profit merely because it appears on an operating dashboard.

The existing Factory Net Position has its own user's persistent Cost / Selling preference, "Stock in Hand" selling valuation and Balance on Table at Cost. **That page remains intact.** Phase 14 links to it rather than reimplementing or modifying its workflow and deliberately does not modify `factoryNetPositionValuationMode`.

### Why a direct Factory management figure was not embedded

The legacy `GET /api/factory/net-position` resolver can pin a `factoryCompanyId` or choose a first active factory even when the selected account company differs. Its response does not carry a company ID to prove the returned value's ownership. Incorporating that figure into the company-scoped accounting dashboard would risk **cross-company data blending**. Until the management endpoint has a verifiable company ID tied to the active session and explicit authorization, link to it separately and label it management-only. Do not assume its unverified company equals the selected accounting company.

## New backend

`server/services/accounting/unifiedAccountingDashboard.ts`

- Calls `professionalFinancialStatementsTx(tx,{companyId,fromDate,asOfDate,compare:false})` — **reuses** the Phase 11 booked financial position, income statement and cash-flow source reconciliations, rather than creating a parallel Net Position formula or new voucher query.
- Uses `assertTransactionCompanyScope` under one selected-company transaction.
- As-of dates and reporting period use the company's business date and must be valid calendar days not in the future.
- Calculates **net assets = posted assets − posted liabilities** and compares them with **recorded equity including unclosed earnings**. The dashboard now shows both the **raw reported assets − liabilities − equity gap** and the **remaining canonical ledger residual after separately displaying unclassified account net balances**. These are not interchangeable: unknown accounts cannot be silently treated as verified equity, even when their debits and credits net to zero. The existing residual field remains available for Phase 14 compatibility.
- Shows posted assets/liabilities by cash/bank, linked customer/party, recognized stock, fixed assets and other categories. This is a **presentation split** of accounts already in the booked balance, not additional book entries. A negative party/customer payable remains on the liability side according to the canonical ledger engine; a supplier advance appears on the asset side.
- Shows only **recognized** P&L: revenue, other/FX income, cost of goods sold, operating expenses, gross profit and period net result. Factory unfinalized orders/freight and expected Properties rent are not posted by this dashboard.
- Shows recognized cash/bank movements and the existing provisional cash-flow classification discrepancy, unclassified accounts and trial-balance imbalance, if any.
- Links to the Phase 9 separate consolidation workpaper; standalone net assets are **not** a "group net position" because intercompany balances/profits must be eliminated in real consolidation.

### Operational stock comparison — opt-in and never auto-added

The route defaults to `includeOperational=false`. When explicitly loaded:

- Reads the same `companyStockValuation` and `companyStockValuationAsOf` functions used by existing ERP stock valuation, based on stored `inventory.total_value`. Signed ERP cost subledger is kept separate from displayable positive-stock valuation and the short/negative stock anomalies are reported.
- Reads the original Factory `factoryStockValuation` for current raw material at landed cost, WIP/mix/bales awaiting pressing and held finished bales. Open order reserved bales and sold-not-invoiced bales remain Factory inventory at recorded cost until their invoice finalization.
- **Factory current cost is not replayable historically.** For any earlier `asOfDate`, current Factory cost is shown as current-only, and every historical GL-to-Factory stock comparison is marked **not comparable**; the dashboard never invents old stock or retroactive rates. A combined ERP-plus-Factory cost memorandum is now **withheld** for such a past date; mixing dated ERP replay with today's Factory stock cannot produce a valid past management net-position total.
- Recognized inventory balances are computed **from the same posted balance-sheet lines**. ERP and Factory operational values are *separate management memoranda* and are **never added** to the already booked Assets or Net Assets.
- The existing `gl_inventory_cutovers` record and `PERPETUAL_INVENTORY_POSTING_READY` are shown read-only. **The global gate remains `false`; Phase 14 does not change it.**
- GL-to-cost comparisons are listed by inventory control account: `INVENTORY`, `FACTORY_RAW_MATERIAL_STOCK`, `FACTORY_WIP`, `FACTORY_FINISHED_GOODS`, plus `GOODS_IN_TRANSIT` and `FACTORY_GOODS_IN_TRANSIT` as explicitly **unavailable/non-comparable** when a valid operational matching basis is absent.
- A displayed difference is computed **only if** the company cutover is active at that date, both bases have matching dates, and required cost sources are available without recorded anomalies. Periodic inventory, missing Factory costs, stale historical costing or unproven Goods in Transit do **not** become false "reconciliation errors." ERP historical replay that includes **unitemized post-date movement values** (missing source stock-item attribution) is also marked **not comparable**, rather than claiming an exact GL-to-stock match.
- The displayed operational aggregate is not a formally certified inventory asset, an adjustment voucher, a second value of inventory or an accepted current-market/selling valuation. It is returned **only** as a same-current-date cost memorandum when both ERP and Factory are loaded with no unvalued Factory sources or anomalous ERP rows. Otherwise the candidate is `null` with `managementCostCandidateBasis` indicating `NOT_LOADED`, `WITHHELD_MIXED_DATES` or `WITHHELD_INCOMPLETE_COST`. The separate original source values are still visible with warnings; no estimate or plug is substituted.
- The existing Factory cost/selling management toggle remains on the Factory Net Position page. Neither the new API nor its CSV export claims a selling amount it cannot prove for the requested company/date. `managementSellingValueUsd:null` is **intentional**.
- The report explicitly exposes `operationalAmountsAddedToBookedNetAssets:false` and `certified:false`.

### FX and historical source disclosures

- The endpoint also returns the existing `getHistoricalCurrencyReadiness(companyId,asOfDate)` information, with `certified:false`. Unresolved non-USD historical base entries trigger a dashboard accounting blocker; when the reader is in pure-legacy compatibility mode it adds an explicit **warning** that a ready response is not certification of historical USD conversion.
- The existing FX readiness reader may allow a pure-legacy company as compatibility-ready even though original USD rates have not been individually verified. A passing check is **not** an external audit or complete historical FX certification.
- All historical revenue, expense, purchase cost, profit and voucher values stay in the previously posted **historical USD base**, never multiplied by today's EUR/AUD/CDF/CFA/GBP rate.
- Open master balances and operational cost history are retrospective and not guaranteed to reproduce immutable, point-in-time knowledge. Disclose this limitation; do not generate a plug to conceal it.

## API

`server/routes/unifiedAccountingDashboardRoutes.ts`:

`GET /api/accounting/unified-dashboard?fromDate=YYYY-MM-DD&asOfDate=YYYY-MM-DD&valuationBasis=cost|selling&includeOperational=true|false`

- Authenticated Admin, Owner or Developer; company ID comes exclusively from the active session.
- Transaction-local RLS company scope is established by the accounting dashboard service and reused by the underlying statement and operational readers.
- Factory's existing **Accounts / View Accounts** permission gate applies to this endpoint.
- Calendar-date and period order checked at route boundary; the company business day is the maximum date.
- No POST/PUT/DELETE methods and **no financial writes**. Read-only source work happens only when requested. HTTP response is `Cache-Control: private, no-store`.
- `valuationBasis=selling` is accepted as a management display request context but **does not revalue** booked balances or invent management selling totals. The response says that verified selling valuation belongs to the original Factory management report.

## UI and navigation

`client/src/pages/UnifiedAccountingDashboard.tsx` has five sections (Phase 12 uses the existing Cost Centers module rather than introducing a duplicate):

1. **Booked Net Position:** Assets, liabilities, net assets, equity, unclassified accounts, exact unexplained difference, composition of booked balances.
2. **Income & Costs:** Booked sales revenue, actual posted COGS, gross profit, other income, expenses and net result, plus source account drill-down.
3. **Cost Centers & Budgets (Phase 12):** Read-only existing ERP/Factory analytical expense-versus-budget reports, with unallocated spend, monthly views and capitalized cost separated; Properties/Rentals has no borrowed cross-shell budget.
4. **Stock & Management Bridge:** Opt-in ERP and Factory recorded cost, live/historical basis disclosure, missing Factory cost controls, and **withheld mixed-date or incomplete aggregate values**. The Factory management selling mode is reached by a separate navigation link.
5. **Controls & Source Detail:** Explicit raw balance-sheet gap and remaining ledger residual, historical FX readiness limitations, provisional cash movement discrepancy, source account samples, and navigation to fiscal close, historical accounting, Phase 11 financial statements and Phase 9 consolidation.

Features include selected-company-scoped React Query cache, start/end date selectors, source warnings, mobile-responsive financial cards/tables, refresh and Excel-compatible CSV export. No client preference is changed, no stock type valuation is written.

| Module | Route |
| --- | --- |
| ERP | `/accounting/dashboard` |
| Factory | `/factory/accounting/dashboard` |
| Properties | `/properties/accounting/dashboard` |

The new page is also linked from the shared Accounts UI and the ERP/Properties Accounting sidebars; Factory uses its existing View Accounts access registry.

## Controls and deliberate non-goals

- **No change** to the ERP main dashboard's existing management Net Position KPI source/meaning. The new dashboard is a separate posted-accounting analysis rather than silently replacing the KPI with a different metric.
- No historical sales, posted debit/credit, accounting voucher, GL entry, bank, cash, customer/supplier, payroll, property payment, container offload or Factory WIP change.
- No inventory perpetual cutover or opening journal activation.
- No posting freight on pending/unfinalized Factory containers or customer statements, no COGS on bales not finalized/sold by original voucher writer.
- No group consolidation shortcut: balance sheet amounts remain **one company**, and intercompany eliminations remain a separately certificated Phase 9 process.
- No formal IAS/GAAP certification: account metadata, opening sides, historical FX, stock cost quality and cash-flow category coverage are sourced from existing provisional Phase 11 controls.
- Accounting and management numbers are explicitly labeled so a future UI cannot present the stock at selling value as a historical financial asset.

## Claude technical and accounting certification — not run

1. Compile TypeScript and React, validate imports, transaction typing, return types and source dashboard view. Confirm all page routes, shared lazy imports and sidebar icons exist.
2. Verify admin/owner/developer and Factory View Accounts restrictions; switch session companies and ensure none of the dashboard's GL, stock, rates or source references leak between companies.
3. Compare booked Assets, Liabilities, Net Assets, Equity and period result against Phase 11 `/api/accounting/statements/professional` for identical company/date; prove equality to the cent, without legacy management net-position substitutions.
4. Test orphaned/missing account targets, supplier/customer advances on unusual debit/credit side, unclassified account balances and opening-side assumptions. Verify raw assets-minus-liabilities-minus-equity **and** the separately remaining ledger residual, including net-zero but nonempty unknown lines. Do not plug balance-sheet differences.
5. Check cash-bank values and realized cash movements against canonical balance sheet/cash flow reader, preserving classification caveats.
6. Test fiscal closing month and reopening: closing journal stays in balance sheet/equity, is excluded from current period P&L, and as-of report uses effective date.
7. ERP stock: stored `total_value`, negative/short stock, mirror bales, current vs replayed historical cost; count only in-scope locations once.
8. Factory stock: RAW, WIP, pending pressing, produced held bales, reserved and sold-but-uninvoiced bales, zero-cost sources. No COGS before finalized invoice.
9. Perpetual cutover active/inactive/as-of-before-cutover and default global gate disabled. Reconciliation only for supported account, date and cost basis; never add stock to booked net assets.
10. Goods in Transit: unavailable operational matching basis must remain **not comparable**. Never translate unknown freight/source dates into booked values.
11. Past date Factory stock: compare GL as-of with **current cost-only** memo, suppress GL-vs-cost difference and **withhold the combined ERP-plus-Factory memorandum**. For current dates, require complete ERP/Factory costs before returning a combined amount; test anomalous ERP and unvalued Factory rows.
12. Historical non-USD currency completeness and pure-legacy compatibility, with explicit warning/blocker behavior and UI disclosure. Confirm no current rate is applied to booked profit or inventory. Historical ERP unitemized movement values must prevent exact GL-to-ERP cost comparability.
13. Check company switch (including an in-flight previous-company response), date range, leap dates, future dates, default business date, opt-in expensive stock fetch, offline/failed API behavior, print/CSV formula injection safeguards and mobile layout. Verify the response UI and CSV label operational date bases, `managementCostCandidateBasis`, raw accounting difference and residual correctly.
14. Ensure the management Factory source's pinned company independence is not treated as proof of matching company ID. Verify link to existing Factory Net Position retains cost/selling preference.
15. Verify route registration once, Factory Access Registry and navigation links for ERP/Factory/Properties.
16. Confirm **zero accounting mutations** from new GET, dashboard refresh, changing tabs, opt-in stock valuation or CSV export.
17. Run CI, tests and financial certification only during the independent Claude verification stage. Do not merge/rebase/deploy before its review.

**Phase 14 original implementation and subsequent reporting-integrity hardening are committed on the existing feature branch.** They remain **not compiled, CI-tested, security-verified, financially certified, merged or deployed** by this phase. Claude owns independent source, financial, cross-company and posting-safety certification; no financial voucher, cash, inventory, historical FX, Factory production or rental record was modified.
