# Zambia ZMW — Phase 2 implementation and Claude handoff

**Status:** Phase 2 implementation complete and committed on `feature/zambia-zmw-multicurrency`. No CI, tests, lint, typechecks, or builds executed; verification belongs to Claude after the remaining implementation phases.

## Scope delivered

### Shared accounting currency catalog

- Created `shared/currencyCatalog.ts` as a shared source for supported accounting currency codes, legacy XOF -> CFA alias normalization, and money display metadata.
- Registered `ZMW` as a supported ISO 4217 code, with label `K` and two fractional display digits.
- Preserved existing `CFA`/XOF alias behavior for Mali; XAF remains a *different* code and is not normalized into XOF/CFA.
- Unsupported currency codes are never silently represented as USD by the server domain normalizer.

### ERP financial domain

- `server/services/accounting/currencyAmounts.ts` uses the shared catalog and accepts ZMW for normalized posting amounts.
- ERP cross-currency posting normalization retains the original amount/currency, 10dp locked rate, and 6dp historical USD base values. Arithmetic uses `decimal.js`, not floating point calculations.
- Conversion now rejects `RateConvention.IDENTITY` when the transaction and base currencies differ, instead of silently treating foreign amounts as USD.
- No invalid/nonfinite monetary amounts are accepted by normalization/conversion helpers.
- Normalization uses the *stored rounded rate* for computation, avoiding mismatch between persisted historical rate and the amount conversion.
- Added `groupNormalizedTransactionAmountsByCurrency()` for safe native amount summaries. Legacy `sumNormalizedEntries()` is retained for compatibility, but its legacy aggregate transaction totals must NOT be used to reconcile mixed-currency native balances.

### Explicit ERP/Factory rate-direction boundary

- Added two named, validated inverse-rate helpers:
  - `erpTransactionPerUsdToFactoryUsdPerUnit(rate)` converts ZMW-per-USD to USD-per-ZMW (or the equivalent for any non-USD code).
  - `factoryUsdPerUnitToErpTransactionPerUsd(rate)` converts USD-per-ZMW to ZMW-per-USD.
- Both reject missing/invalid/zero rates and reciprocal results that cannot be represented at ten decimal places. Neither looks up or replaces rates.
- `erpRateToDaybookFxRateToUsd()` now calls the explicit ERP-to-Factory helper, refuses unsupported codes, and requires USD as the factory daybook base. The old silent rate=1 fallback on unknown codes is intentionally removed.
- Rate pairs are NOT fetched or persisted in Phase 2. Caller must supply a company-scoped rate effective on the document date. `factory_fx_rates` continues to use USD per foreign unit; ERP `exchange_rates` uses foreign units per USD.

### Shared UI formatting

- `client/src/lib/moneyDisplay.ts` reads the new shared currency catalog; ZMW display defaults to `K250.00`, maintaining CFA zero-decimal and existing other-code formatting.
- `client/src/lib/formatNumber.ts` supports ZMW and other catalog currencies while retaining the legacy USD and CFA formatting branches. `formatCurrencyWithLabel(250, "ZMW")` displays `K250.00`.
- These are *display-only* helpers; they do not alter stored numbers or historical conversion rates.

## Intentionally NOT part of Phase 2

Phase 3: configure Zambia company 19 with USD base/ZMW display, daily ZMW rate input/history and company-scoped rate permissions (configuration must not be written to production during implementation).
Phase 4: wire company-aware currency preference, selectors, toggles, ERP UI context.
Phase 5: POS pricing/edit/import, credit/cash sales, refunds and receipts.
Phase 6: voucher schema UI/write paths, opening balances and parties.
Phase 7: cash/bank ZMW revaluation.
Phase 8: stock and parent-company intercompany.
Phase 9: Factory transaction integrations.
Phase 10: reporting/export/Net Position.
Phase 11: final code-level integration review.

**Not activated:** Zambia's live company display_currency remains unchanged; no production company/rate/voucher/balance/stock/container rows were edited. No schema migrations or seed data were run.

## Claude verification checklist (do not run during implementation)

1. Exercise `normalizeCurrencyCode("zmw") === "ZMW"`, XOF -> CFA compatibility, and invalid-code failures.
2. Confirm `normalizeVoucherEntryAmounts({ transactionCurrency:"ZMW", baseCurrency:"USD", transactionDebitAmount:"250", transactionCreditAmount:"0", historicalRate:"25" })` locks 250 ZMW and 10 USD without losing base precision.
3. Verify both explicit direction helpers: 25 ZMW per USD -> 0.04 USD per ZMW and vice versa, plus invalid/missing/zero/unrepresentable rate failures.
4. Check that a foreign-currency conversion attempted with IDENTITY raises a controlled error.
5. Check independent ZMW/CFA/USD native totals and unchanged USD base totals.
6. Check ZMW display of `K250.00`, CFA's existing display behavior, and the unchanged USD display behavior.
7. Run compiler/lint/unit/integration suites **only after all implementation phases**, per the user's explicit request.
8. **Existing test update required:** `tests/currency-amounts-behavior.test.ts` contains an assertion that an unsupported daybook code `BAD` returns a dangerous identity rate of `"1"`. The implementation now deliberately rejects unknown currency codes. Claude should update the assertion to expect failure after reviewing the safety decision; do not restore fallback=1 merely to make CI green.
9. Check `@shared/currencyCatalog` resolution in both client and server TypeScript builds.
10. Verify migrations, accounting parity and tenant-scoped Zambia/Mali reconciliation before any release approval.

## Guardrails preserved

- All work stays on the same branch and will feed one draft PR.
- No merging into `main`, no Render deployment and no production data mutation before Claude completes independent checks and fixes.
- No CI/tests/lint/typecheck/builds executed by ChatGPT.
- Phase 2 was a code-only shared-engine update. Later phases must explicitly wire UI, voucher and POS paths before ZMW is usable end-to-end.
