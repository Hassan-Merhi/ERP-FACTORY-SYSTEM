# Phase 7 — Final audit, repairs and automated verification

**Branch:** `feature/fx-monetary-valuation`  
**Date:** 2026-10-27  
**Status:** Automated verification EXECUTED on this branch (TypeScript, lint of the touched files, the FX
suites, the legacy multi-currency / ledger engine / net position suites, the full backend suite, build).
Live tenant reconciliation was NOT performed: no production database connection was authorized in this
session (no Render workspace selected), so every reconciliation figure below is synthetic (fixture data on a
fresh PostgreSQL 16 schema built by `drizzle-kit push` plus the application's startup migrations, exactly as
CI prepares its database).

## Bugs found in Phases 1–6 and fixed here

| # | Defect | Effect before the fix | Fix | Regression test |
| --- | --- | --- | --- | --- |
| 1 | `statsNetProfitRoutes.ts` dropped `partyKind` / `partyId` when copying the engine's party lines into the report rows. | The ERP Net Position overlay could never find a customer row (`customer:<id>`), so **customers were never revalued on the ERP Net Position or the Group Net Position**; only cash/bank and ledger loans were. | Party rows carry `partyKind` / `partyId` (`NetPositionAccount` gained the two optional fields). | `monetary-fx-valuation.database.test.ts` › ERP Net Position, Group Net Position |
| 2 | The valuation only exposed the historical **base-amount** USD (6 dp), while the Accounts list, the Customers list, Factory customers and the Factory Net Position present the engine's **posted-amount** closing (2 dp per line). | Accounts with many foreign lines could drift past the 0.03 match gate and be silently left at book USD (`monetaryFxProvisional`). | Rows now also carry `bookClosingUsd` (the engine's `closing` basis); every overlay accepts a match on either basis (`reportRowMatchesBook`). | DB suite (`bookClosingUsd` asserted, Accounts/Customers/Factory rows replaced) |
| 3 | The Accounts page displays customer-linked rows through `partyBalance` (the Parties projection), which the overlay left untouched. | **The Accounts screen kept showing book USD for customers** even though `balance` was translated. | The Accounts overlay projects `partyBalance` / `partyBalanceSide` / `partyLedgerBalance` when the projection equals the ledger and carries no unposted memo or held charges; otherwise the row stays at book and is marked provisional. | DB suite › Accounts list (`partyBalance: "100.00"`, memo-bearing C3 stays provisional) |
| 4 | Overlay consumers read `req.session.currentCompanyId` without a guard. | Internal callers without a session (e.g. the wave-10 consolidation test, scheduled reports) crashed the Accounts list with a TypeError → 500. | Optional chaining in `accounts/all.ts`, `factory/customers-core/crud.ts`, `employeeNetPositionRoutes.ts`. | `wave10-engine-consolidation.test.ts` (was failing) |
| 5 | A loan that flips from debit to credit kept its "<type> Deposits" category on the liability side. | Breakdown showed "Loans Deposits" under What We Owe. | `categoryForSide` strips/adds the classifier's " Deposits" suffix with the side. | DB suite › LOANF row category "Loans" |
| 6 | The overlay regenerated category breakdowns from account categories and always wrote "Net Assets"/"Net Liabilities". | Breakdown names ("Stock In Hand" → "Inventory") and the label vocabulary changed depending on whether any account happened to be revalued. | Breakdowns are adjusted in place by the replaced rows' deltas; the report's own label vocabulary is kept. | Characterization pin (`config/report-characterization.json`) regenerated and verified stable across runs; DB suite label assertions |
| 7 | The Net Position middleware dropped the former cash/bank compatibility fields (`currentCfaPerUsd`, `currentZmwPerUsd`, `currentCashBankTranslationDifference`, `unresolvedAccounts`) and three legacy source-contract tests pinned the removed code. | Dashboard type / Golden Coast projection consumers lost fields; `multi-currency-integration`, `supplier-partner-net-position-inclusion`, `supplier-partner-customer-authoritative-net-position` failed. | Fields restored from the same valuation (no second rate lookup); the three tests now pin the overlay module that owns the logic. | those suites |
| 8 | The Balance Sheet (`/api/reports/balance-sheet`) was never integrated (listed as an affected screen). | Current balance sheet stayed at booked USD. | `applyCurrentBalanceSheetFxOverlay`: eligible monetary lines replaced by owner key, balanced by a reporting-only equity line `FX_TRANSLATION_CURRENT_RATE` ("Unrealized FX translation (current rate, reporting only, not posted)"); `difference` is unchanged by construction; dated statements untouched; `fxVouchersPosted: false`. | DB suite › Balance Sheet |
| 9 | `shared/fxRateQueryInvalidation.ts` listed `/api/balance-sheet` but the real routes are `/api/reports/balance-sheet` and `/api/reports/ratios`. | Those screens were not refreshed after a rate save. | Paths added. | `fx-rate-phase3-refresh.test.ts` |
| 10 | `monetary-fx-phase6-reconciliation.test.ts` asserted `forUsTotal` on an untouched payload that never had the field. | The Phase 6 suite failed (1/42). | Assertion corrected to the untouched `forUs.total`; fixtures carry `bookClosingUsd`. | itself |
| 11 | The characterization pin hashed the new diagnostic arrays, which carry raw fixture ids. | `report-endpoint-characterization` was non-deterministic. | `appliedAccountKeys`, `skippedAccountKeys`, `unresolvedAccounts`, `currentTranslatedBankAccountIds` are volatile keys (like the existing `currentTranslatedLedgerAccountIds`); money fields stay hashed. | pin verified stable on two consecutive runs |

## What was verified (synthetic, real PostgreSQL schema)

`tests/monetary-fx-valuation.database.test.ts` (25 scenarios, all derived from fixture rows, never from the engine):

- Mali (USD base, CFA display): rates 605 (Oct 20), 612 (Oct 25) and a **future 650 that is never selected**.
  61,200 CFA customer → 101.157025 historical, **100.000000 current**, native unchanged; customer credit
  12,100 CFA stays Cr; cash with a 121,000 CFA opening **and** a USD line keeps separate buckets; a linked bank
  keeps its bank-only line while the line naming ledger+bank counts on the ledger once; loan payable,
  receivable and a loan whose sign flips (0.657025 book → −0.50 current) move side with the right category;
  inventory, supplier and an unapproved generic `Asset` are never translated; an opening without currency,
  a legacy line without transaction fields and a GHS line with no rate stay provisional without poisoning the
  CFA accounts (`rateErrorsByCurrency: { GHS: "FX_RATE_MISSING" }`).
- Rate change 612 → 620 → 612 through `saveCompanyExchangeRate`: only current USD moves; every voucher entry,
  opening row and voucher count is byte-identical before/after; one audit row per real revision; a repeated
  identical save is a no-op (same row id, no audit row); Zambia's change never touches Mali.
- Zambia (ZMW 25/USD): 2,500 ZMW → 100; a contradicting same-day inverse quote makes ZMW
  `FX_RATE_CONFLICT`, blocks a new save (rolled back, not audited) and clears once removed; the unique
  index refuses a duplicate company/date/pair row.
- USD-only company: no rates, every current value equals book, difference 0.
- Reverse quote company (EUR→USD 1.2): 100 EUR → 120 (multiplied), historical 110 kept.
- Screens: ERP Net Position (rows, sides, categories, totals = sum of rows, no double translation on repeated
  reads, dated `toDate` at booked USD, unposted memo kept out of totals), Accounts list (current, dated,
  `partyBalance`, memo-bearing customer provisional), ERP Customers stats (both signs), Factory customers
  (memo row untouched), Factory Net Position for a factory company (cash, customer, loan; `ledgerAssets`
  / `ledgerLiabilities`; dated report locked; pinned secondary company never borrows the ERP session's
  rate), Group Net Position (current and dated), Balance Sheet (lines, equity line, unchanged `difference`,
  dated statement untouched, `no-store`).

## Test results on this branch (local run, PostgreSQL 16, Node 22)

See the final report in the pull request / session summary for exact counts. Suites executed: the seven FX
suites, the new DB suite, `multi-currency-integration`, `money-exact-batch-18`, `wave9-ledger-safety-routes`,
`exchange-rate-daily-popup`, `realtime-invalidation-contract`, `wave10-net-position-banks`,
`wave10-engine-consolidation`, `accounting-integrity-trial-balance`, `balance-sheet-from-trial-balance`,
`group-net-position`, `net-position-helper`, `wave17d-fx-rate-required`,
`factory-customer-balance-reconciliation`, `factory-net-position-historical.database`,
`supplier-partner-*-net-position`, `report-endpoint-characterization`, `api-smoke-sweep`, and the full
`npm run test:backend` run; `npm run check`; `npm run build`.

## Not verified here (release blockers that need an authorized environment)

1. **Live tenant reconciliation** (Mali CFA, Zambia ZMW, any other configured currency): run
   `phase-1-read-only-diagnostics.sql`, `phase-5-read-only-rate-diagnostics.sql` and
   `phase-6-read-only-reconciliation.sql` on a read-only connection and compare
   `GET /api/accounts/multi-currency/monetary-valuation` against the trial balance per master. Accounts
   the engine reports as `provisional` (unresolved opening currency, legacy lines without transaction
   fields, missing/conflicting rates) stay at book USD on every screen until their evidence is repaired by
   an audited, reviewed correction — never automatically.
2. **Monetary-asset approval registry**: generic `Asset` / `Current Asset` accounts remain `needs_review`
   (no automatic translation) until the owner lists the codes that are monetary (deposits, receivables).
   The policy hook exists (`approvedMonetaryAssetCodes`); no production code is approved on this branch.
3. **Multi-process cache behaviour** on Render (several workers, several tabs) is covered by source
   contracts and the read-microcache coordinator tests, not by a multi-process run.
4. Non-USD functional base currencies remain unsupported by policy (`FX_BASE_UNSUPPORTED`); such a company
   is reported, not translated.
