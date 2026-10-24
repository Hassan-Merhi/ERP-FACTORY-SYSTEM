# Zambia ZMW integration — Phase 1 baseline and implementation contract

**Status:** Phase 1 completed (branch creation and read-only code/data-shape audit only). Phases 2–11 not implemented. No CI, tests, lint, typecheck or builds executed in Phase 1.

**Repository:** Hassan-Merhi/ERP-FACTORY-SYSTEM  
**Single branch:** feature/zambia-zmw-multicurrency  
**Starting main commit:** aefe73e547f67ed223ab06b85875f040541baba6 (2026-10-23)  
**Target company:** Zambia, company_id=19  
**Parent company:** HADI L'SHI, company_id=1  
**Reference company:** MALI, company_id=9  
**Goal:** USD accounting base with ZMW (Kwacha, K, two fractional digits) as Zambia's local display/transaction currency; preserve Mali's USD/CFA flows.

## 1. Scope and immutable safety requirements

- Keep ALL phase work and Claude's eventual fixes on this single branch. Each phase should commit on this branch. Do not merge into main, deploy to Render, or apply production migrations or data changes until Claude independently reviews the complete implementation, resolves all CI/build/test failures, checks accounting reconciliation, and authorizes release.
- User explicitly forbids running CI, tests, lint, typechecks, and builds during ChatGPT implementation phases. Commit phase work with a CI-skip marker where supported; repository automation beyond our control might still trigger.
- Do not change existing historical vouchers, sales, credit notes, customer/supplier balances, ledger postings, cash/bank openings, factory containers, stock movement costs, or exchange-rate history.
- Keep company_id scoping on reads/writes; never cross-apply a Mali rate or user currency preference to Zambia, another company, or its parent.
- No guessed missing FX rate; non-USD entries without a valid rate must be blocked or explicitly marked unresolved using existing domain contracts.
- Do not convert historical sales, purchases, assets, receivables, payables, inventory, or profits using a later/current rate. Only designated current-snapshot cash/bank translation may use current rates; historical snapshots use their date.
- Never assume a ZMW amount is USD or add ZMW and USD native amounts together without an explicit, dated conversion.
- Posting services must use decimal-safe arithmetic and preserve original transaction currency/amount, locked transaction exchange rate, historical base USD amount, and transaction date.
- Distinguish exchange-rate direction:
  - ERP / exchange_rates: USD -> ZMW = ZMW per 1 USD (TRANSACTION_PER_BASE); USD amount = ZMW amount / rate.
  - Factory / factory_fx_rates and fxRateToUsd: USD per 1 ZMW (BASE_PER_TRANSACTION); USD amount = ZMW amount * rateToUsd.
  - The two values are reciprocal only when they refer to the same date and source rate. Never pass either value to a service expecting the other convention.
- Make rates company-scoped and effective-date-aware. Respect existing confirmation/audit permissions.
- Store currency code ZMW (ISO 4217), prefix K in appropriate Zambia UI, and default to 2 decimal places for money. Do not change CFA's zero-decimal display conventions. Currency display/formatting must not silently change posting amounts.
- Zambia should be configured using the existing companies and exchange_rates structures, not via a new tenant, independent database, or cloned Mali workflow.

## 2. Read-only production configuration baseline (observed 2026-10-23)

The Render production PostgreSQL metadata was inspected using read-only queries. The following were visible:

| Company | ID | company_type | base_currency | display_currency | currency | parent_company_id |
| --- | ---: | --- | --- | --- | --- | ---: |
| MALI | 9 | erp | USD | CFA | USD | 1 |
| Zambia | 19 | erp | USD | null | USD | 1 |

- The exchange_rates table contains company-scoped pairs with effective_date. Observed rate records were USD -> CFA for company 9; no ZMW exchange_rates rows were returned. **Do not add ZMW production rates during implementation.**
- The companies schema already has base_currency and display_currency. company_settings is separate. The exchange_rates table has company_id, from_currency, to_currency, rate, effective_date.
- A direct production query for voucher counts was blocked by tenant isolation: "app.current_company_id is required for tenant data access". Hence exact Zambia/Mali transaction counts, existing openings, and reconciliation totals were **not** established. Do not claim a clean balance baseline; obtain company-scoped, permissioned before/after reconciliations in Claude's final validation.
- This configuration read was NOT a production data migration or edit. **Phase 1 performed no production writes.**

## 3. Existing architecture: confirmed entry points and gaps

### Company configuration and rate storage
| Path | Existing behavior / Phase 2–3 change |
| --- | --- |
| shared/schema/common.ts | companies baseCurrency/displayCurrency and exchangeRates keyed by company/date/pair already exist. Retain existing schema and scoped reads/writes. |
| client/src/pages/settings/CompaniesTab.tsx | Display Currency selector offers none/CFA/EUR/GBP, not ZMW. Base currency selector is separate. Add ZMW to display currency (do NOT replace base USD). |
| server/routes/exchangeRateRoutes.ts | Company-aware check-today, latest and save endpoints exist. Ensure query-company authorization and date semantics for ZMW. |
| server/storage/accounting/exchange-rates.ts | Finds current and date-specific company pair rates. Reuse, do not invent global ZMW rate. |
| server/services/accounting/exchangeRateWrites.ts | Audited company rate write pathway and Factory-rate pathway exist. Preserve effective dates, company scope and audit behavior. |
| client/src/components/DailyRateModal.tsx | Already reads company baseCurrency/displayCurrency and shows/saves pair-specific daily rate. Validate correct Zambia prompt and historical fallback. |
| client/src/components/ExchangeRateSettings.tsx | Company currency-pair UI and rate history. Reuse with ZMW currency label. |

### Shared UI and ERP POS
| Path | Existing behavior / Phase 2–5 change |
| --- | --- |
| client/src/contexts/CurrencyContext.tsx | Currency type is only USD/CFA, stored preference only recognizes USD/CFA, toggling and formatting assume CFA; critical to generalize and scope preference per company. |
| client/src/components/CurrencyToggle.tsx | Hardcoded USD <-> CFA and CFA-specific tooltip; use selected company's configured display currency. |
| client/src/components/CurrencySelector.tsx | Explicit USD/CFA buttons; generalize to USD/company display currency. |
| client/src/lib/formatNumber.ts | CurrencyCode only USD/CFA and CFA-only labeling; add general ZMW-safe representation. |
| client/src/lib/moneyDisplay.ts | Currency prefix registry lacks ZMW; add K with two-decimal defaults, maintain existing CFA behavior. |
| client/src/pages/pos/POS.tsx | Takes selectedCurrency and dailyExchangeRate from context; check downstream row calculations and payload. |
| client/src/pages/pos/hooks/usePosRowCalculations.ts | Converts typed/display prices only when activeCurrency === CFA; generalized ZMW conversion required. |
| client/src/pages/pos/posimport/usePosImportModel.ts | Sale-currency type and import conversion only USD/CFA, conditional selector only when displayCurrency=CFA. Must support ZMW and avoid silently importing ZMW as USD. |
| client/src/pages/pos/posimport/PosImportForm.tsx | USD/CFA-only selector, rates and warnings. Add company-local currency path. |
| client/src/pages/pos/posimport/PosImportPrintTemplate.tsx | Mali-name-specific daily rate banner with CFA label. Use resolved company rate/currency and locked voucher rate for historical print. |
| client/src/pages/pos/pos-components/InvoiceTemplate.tsx | Mali-name-specific CFA daily-rate banner. Generalize without changing historical prints. |
| server/helpers/generateInvoicePdf.ts | PDF generation identifies Mali by company name and renders hardcoded CFA rate. Needs company-scoped rate/currency metadata. |
| server/services/pos/createSaleService.ts | Sale passes currency/exchangeRate to voucher creation; audit all posted debit/credit and amount conversion paths in Phase 5. |

### ERP accounting, openings and reporting
| Path | Existing behavior / Phase 2, 6, 7, 10 change |
| --- | --- |
| server/services/accounting/currencyAmounts.ts | Known-currency validation omits ZMW; uses transaction-per-base for foreign ERP entries; should be generalized safely, retaining historical base debit/credit invariants. |
| shared/schema/erp/vouchers.ts | Voucher storage has currency and exchange_rate plus voucher-entry dual-currency fields; insert voucher schema still restricts to USD/CFA, requiring ZMW support. |
| client/src/pages/voucher-edit/VoucherEditSchemas.ts | Voucher edit schema also limits currency to USD/CFA. |
| server/routes/voucherEntryCurrencyEditRoutes.ts | Calls historical currency normalizer for voucher-entry edit, currently passes USD base; review company-aware restrictions. |
| server/services/accounting/openingBalanceCurrency.ts | Conversion explicitly allows CFA/USD only; do not reinterpret Zambia existing opening data or silently use current rate. |
| server/services/accounting/latestCfaPerUsd.ts | Retrieves only USD/CFA/XOF. Introduce generic company-pair current/historical reader while retaining CFA compatibility. |
| server/services/accounting/cashBankRevaluationService.ts | Native cash/bank grouping exists, but current translation explicitly handles only USD/CFA; ZMW needs rate lookup and handling. |
| server/services/accounting/netPositionCurrency.ts | Tracks native-currency buckets and historical base; retain current-vs-historical valuation rules. |
| server/routes/stats/statsMultiCurrencyRoutes.ts | Applies current cash/bank translation in Net Position; preserve historical totals and provisional/unresolved flags. |
| server/routes/accountCurrencyRoutes.ts | Account currency summaries and opening normalization; ensure support for ZMW and validation of existing company scoping. |
| client/src/pages/StockInSalesReportDetail.tsx | Uses convertToDisplay; check that historical amounts are not modified by today's ZMW rate. |
| client/src/pages/StockInSalesReportComparison.tsx | Uses convertToDisplay; apply same report date/historical rules. |

### Factory/ERP currency boundary and parent company
| Path | Existing behavior / Phase 8–9 change |
| --- | --- |
| shared/schema/factory/daybook-fx.ts | factory_fx_rates stores company/currency and USD-per-unit rate; factory daybook stores original currency and amount USD. |
| client/src/pages/settings/FxRatesCard.tsx | Factory FX UI accepts currency codes and rateToUsd; may accept ZMW already, but posting integration needs auditing. |
| server/routes/factory/factoryFxRatesRoutes.ts | Supports 3-character non-USD rate codes with company scope, including dated lookup and save. |
| server/services/factory/factoryFxRateOnDate.ts | Finds effective-date-aware USD-per-unit rates; no future rate may be used for historical transactions. |
| server/services/factory/factoryFxRateReadOnly.ts | Can fetch external USD-per-unit market rate; suggested fetched rate is NOT a recorded/approved rate. |
| server/services/factory/currencyConversion.ts | Central raw-material USD conversion/confirmed-rate policy; never silently treat a default fxRateToUsd=1 as confirmed non-USD. |
| server/routes/factory/_helpers.ts | Factory USD conversion, container offload and posting paths. Check rate convention before every ERP<->Factory crossing. |
| server/startup-schema/026-po-import-parent-company.ts | Explicitly handles known HMD KINSHASA/MALI parent linking; Zambia already has parent_company_id=1 in production, so don't duplicate links or invent intercompany entries. |
| server/services/retail/retailLedgerPosting.ts | Uses company base currency in retail ledger. Scope review to any actual Zambia retail usage. |

### Existing coverage to hand to Claude (DO NOT run during implementation)
- tests/ui/currency-context-behavior.test.tsx
- tests/multi-currency-integration.test.ts
- tests/exchange-rate-daily-popup.test.ts
- tests/ui/stockInSalesReportViewSwitch.test.tsx
- tests/account-currency-route-behavior.test.ts
- tests/wave17c-rates.test.ts
- Additional new Zambia-specific tests required for transaction locking, POS/import, report semantics, cash/bank translation, company switching, intercompany and rate-direction regression.

## 4. Phase-by-phase implementation queue

1. **Phase 1 (this commit):** create single branch; audit code and read-only production configuration; document architecture, known gaps and data-preservation contract. No runtime changes.
2. **Phase 2:** support ZMW in shared currency domain and formatters, add canonical conversion/rate-direction boundaries. Keep current Mali behavior.
3. **Phase 3:** company settings, Zambia display currency and per-company effective-dated daily rates. Do not change live Zambia settings until approved release.
4. **Phase 4:** currency context, toggle, selector, company-safe preferences and shared ERP display.
5. **Phase 5:** ZMW POS sale, cash/credit/refund/return/edit, POS import, receipts and historical invoice PDF.
6. **Phase 6:** journals, vouchers, customer/supplier receipts/payments and historical/opening amounts in ZMW.
7. **Phase 7:** Kwacha cash/bank accounts, currency transfers and current revaluation, without historical balance rewrites.
8. **Phase 8:** inventory, purchasing, stock movement and parent intercompany postings.
9. **Phase 9:** Factory suppliers/containers/proformas/daybook/charges and safe currency-rate interoperability with Zambia.
10. **Phase 10:** Net Position, sales/profit history, statements, reports and exports with correct currency/date semantics.
11. **Phase 11:** implementation-level integration review and final commit, no CI/test/lint/typecheck/build executions.
12. **Draft PR only:** create a draft pull request against main containing all work. No merge or deploy. Claude then runs checks, implements repairs on this same branch/PR and checks authorized tenant-scoped reconciliation. After successful review and explicit clearance, merge and deploy can be considered separately.

## 5. Claude verification gate (release blockers)

Claude must verify, in an authorized tenant-scoped environment with safe test data:
- No change in historical USD balances or Mali exchange-rate / display flows.
- ZMW input and stored historical USD amount remain fixed after rate change, including POS edits, refunds, imports, invoices and statements.
- Every posting balances debit=credit in USD base and preserves native original amount/rate/date. Missing rate cannot become zero or 1.
- Same-day effective rate and transaction-date lookup are company-scoped, no future dated rate.
- Zambia cash/bank native ZMW and USD balances are separate; current translations are explicit and historically bounded.
- Customer/supplier payments, partial credits and FX settlement differences reconcile.
- Inventory, landed cost, COGS and parent intercompany entries do not double convert or inflate balances.
- Factory opposite exchange-rate convention remains correct.
- Permissioned baseline/reconciliation snapshots captured for Zambia and Mali (not possible from Phase 1 read-only tenantless voucher query).
- CI, tests, lint, typecheck, build, migration safety and integration regressions all pass before any main merge or Render deployment.

## 6. Phase 1 completion ledger

- [x] New branch created from the current main commit.
- [x] Confirmed branch initially identical to main before this documentation commit.
- [x] Read-only production company configuration and exchange-rate schema reviewed.
- [x] Source audit of Mali-specific foreign-currency behavior and Factory rate conventions.
- [x] Known schema/UI/ERP/Factory gaps and later-phase work assigned.
- [x] Non-destructive implementation and Claude validation contract documented.
- [ ] Production Zambia historical transaction/balance baseline — blocked by tenant authorization; intentionally deferred to permissioned reconciliation, not guessed.
- [ ] Runtime code changes — intentionally deferred to Phase 2 and later.
- [ ] CI/tests/builds/typecheck/lint — explicitly reserved for Claude.

**No production accounting, company settings, rate rows, balances, or other database content was changed by Phase 1.**
