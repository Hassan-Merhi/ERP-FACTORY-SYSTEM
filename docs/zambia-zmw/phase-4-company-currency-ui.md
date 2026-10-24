# Zambia ZMW — Phase 4: Company-aware currency UI and preferences

**Status:** Implementation committed on `feature/zambia-zmw-multicurrency`, but NOT tested, typechecked, linted, built, merged, deployed or production activated. Claude runs all verification after Phases 1–11.

## Implemented

### 1. Currency context and choice isolation

- Refactored `client/src/contexts/CurrencyContext.tsx` to resolve the selected company's base/display currencies rather than assuming an unconditional USD/CFA pair.
- The chosen currency can only be the company's base or configured display currency. A company switch immediately resolves the new company's allowed pair and cannot reuse an unsupported selection from the previous company.
- `client/src/lib/currencyPreference.ts` persists each choice by authenticated user ID **and** company ID in localStorage, avoiding global currency leakage when switching Mali/USD-CFA and Zambia/USD-ZMW.
- Existing global `preferredCurrency`/legacy `selectedCurrency` is read only for a CFA company without a scoped choice. CFA company changes still write through the legacy backend endpoint for compatibility. ZMW choices do NOT overwrite global backend `preferredCurrency`. Scoped choices are browser-local (not cross-device); a server-side per-user/per-company preference would require a separate approved schema/API enhancement.
- Foreign-currency choices resolve safely when company/auth metadata is loading. A selection made before authentication is available stays temporary until the user scope is resolved.
- Same-browser cross-tab updates to a scoped preference invalidate the in-memory selection so tabs use the saved currency, rather than stale values.
- Added `hasExchangeRate` to `CurrencyContextType` to distinguish companies with/without a valid configured pair rate. A missing ZMW conversion yields no invented ZMW result.

### 2. Money display and conversion

- `formatAmount` converts the existing USD amount using the configured USD/ZMW rate when selected ZMW, while preserving Mali's USD/CFA whole-franc presentation. With no valid rate, it falls back to an explicitly USD-labeled amount, not a fabricated Kwacha figure.
- `formatAmountRaw` formats already-denominated native currency without conversion: K250.00, CFA whole-franc, USD with dollar sign.
- `formatTransactionAmount` formats the transaction's **own** original currency rather than calling all non-CFA values USD.
- `formatHistoricalBaseAmount` always formats stored historical USD amounts in USD, regardless of the display selection.
- `formatCashAmount` performs company-pair-specific presentation for amounts documented as being in the company's base currency; legacy CFA-base/USD-display behavior retained.
- `formatCurrentCashTranslation` uses the pair only when the input native currency actually matches a known side of it; unrelated native currencies are shown unchanged with their original code. This display-only conversion must never be mistaken for posting or historical revaluation.
- `formatNewTransactionPreview` displays USD and ZMW side by side when the date-appropriate current rate exists. Without a rate, the preview states that the rate is unavailable.
- `convertToDisplay` and `convertToUSD` handle Zambia's configured foreign currency. Missing ZMW conversions return NaN instead of silently treating ZMW as USD. Legacy CFA display fallback remains for compatibility; Phase 5/6 must explicitly reject missing rates in transaction write paths.
- `client/src/lib/moneyDisplay.ts` and `client/src/lib/formatNumber.ts` use the catalog added in Phase 2 (K, two decimal places). No changes to persisted accounting amounts.

### 3. Selectors and relevant UI

- `client/src/components/CurrencyToggle.tsx`: dynamic base/display pair, properly labeled USD/ZMW or USD/CFA tooltip.
- `client/src/components/CurrencySelector.tsx`: renders only the active company's options, not static USD/CFA; selection remains restricted while company details load.
- `client/src/components/ExchangeRateInput.tsx`: dynamic company base/transaction-currency labels and input reset on currency pair change, avoiding a stale Mali CFA label in Zambia.
- `client/src/pages/vouchers/PaymentDraftAndRateBar.tsx` and `client/src/pages/vouchers/journalform/JournalFormView.tsx`: show rate-entry controls for the configured foreign display currency instead of only CFA. Phase 6 still owns full voucher posting conversions/validation.
- `client/src/pages/StockInSalesReportDetail.tsx` and `client/src/pages/StockInSalesReportComparison.tsx`: remove hardcoded CFA labels from converted visual report-rate fields. Preserve Mali's existing CFA report precision, and show ZMW with K and two decimals.
- `client/src/pages/Agents.tsx`: exported statement rate description now labels the actual selected company pair instead of assuming every rate is per USD and in selected currency.

### Limitations and next-phase boundaries

- Phase 4 updates shared UI choices, formatting, and rate-input presentation. This does NOT make Zambia POS, Excel imports, sales invoices, voucher postings, returns, customer/supplier settlement, Factory postings, or historical reporting fully ZMW capable yet.
- Phase 5 must generalize POS-specific hardcoded CFA calculations and prevent an unresolved ZMW rate from being treated as USD or zero. Known Phase 5 code: `client/src/pages/pos/hooks/usePosRowCalculations.ts`, `client/src/pages/pos/utils/posCalculations.ts`, imports, invoice templates, checkout and server posting.
- Phase 6 must generalize voucher/journal/edit transaction behavior currently checking `selectedCurrency === "CFA"`, and ensure journal entry posting schema/rates are ZMW-safe.
- Phase 10 must separately confirm that reporting uses original historical USD values, not a later rate. Phase 4 changed presentation only; it does not revalue historic records or implement date-specific report accounting.
- Phase 4 uses the current company-pair exchange-rate API from Phase 3, which only resolves up to the business date.
- User-specific browser-local storage is persistent across reloads but not synchronized between devices. Backend legacy preference is deliberately kept separate from Zambia choices to avoid leaking currency between companies.
- The new `Currency` type includes currencies from the shared registry. Claude should check downstream TypeScript contracts and update any component still typed as only `"USD" | "CFA"` in subsequent phases.

### Claude final verification list (DO NOT execute yet)

1. Select Mali: USD/CFA toggle, CFA preference, native balances, rounded CFA display and old reports must behave as before.
2. Select Zambia after activation in a safe environment: USD/ZMW toggle, K250.00 formatting, 1 USD = 25 ZMW example, bidirectional input previews, missing-rate warning.
3. Switch repeatedly between Mali and Zambia without passing CFA currency, rate, localStorage preference, query cache, or invoice/account labels to Zambia.
4. Sign in as another user in the same browser; confirm previous user's saved choices do not leak across authenticated user IDs.
5. Verify remembered selection after reload and another tab update, and verify legacy global preference does not override an explicit scoped choice.
6. Check `formatTransactionAmount` for CFA/XOF, USD, ZMW, EUR/CDF; unrelated currencies must keep their own labels.
7. Check `formatCurrentCashTranslation` for USD/ZMW and USD/CFA; do not translate a third currency via the wrong rate.
8. Check historical USD display is invariant across rate changes, and that missing foreign rate never becomes a 1:1 posting.
9. Check all components using `Currency` or CFA-specific comparisons for type compatibility and posting correctness when Phases 5–6 are implemented.
10. Run automated tests, lint, compiler/build checks and reconciliation **only after** all implementation phases are complete and before any main merge or Render deployment.

### Branch and accounting guardrails

- Commits remain on the single `feature/zambia-zmw-multicurrency` branch.
- No CI/tests/lint/typecheck/builds run during ChatGPT implementation.
- No merges, deployment, production SQL, rate creation, voucher updates or balance changes.
- Claude is the required verification/reconciliation gate prior to a later explicit merge/deployment decision.
