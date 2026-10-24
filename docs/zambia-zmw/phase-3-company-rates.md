# Zambia ZMW integration — Phase 3 company settings and rate controls

**Status:** Phase 3 code implemented and committed on the existing `feature/zambia-zmw-multicurrency` branch, with no execution of CI, tests, lint, typechecking or builds. Claude must verify after all implementation phases. This phase does NOT update production company #19, write exchange rates, run migrations, merge main or deploy Render.

## Scope completed

1. `client/src/pages/settings/CompaniesTab.tsx`
   - Added **ZMW — Zambian Kwacha (K)** to the display-currency selector.
   - Kept company base-currency controls separate, with explicit USD-base instruction for ZMW.
   - Added company setup guidance: choose `Africa/Lusaka` and enter the business's own USD/ZMW rate after release, before transacting in ZMW.
   - Invalidate company details and rate caches after an authorized company edit. No automatic modification of Zambia's existing company configuration.

2. `server/routes/auth/companyAccessRoutes.ts`
   - Validate new or updated company settings before persistence: **ZMW display currency requires a USD accounting base**.
   - Applies to partial company PATCH values by inspecting effective existing currency metadata; no automatic revaluation, tenant creation or retroactive data change.
   - Existing company permission and parent-company handling remain in place.

3. `shared/companyRatePolicy.ts`, `shared/schema/common.ts`
   - Added a shared positive exchange-rate schema that matches the ERP `exchange_rates.rate` decimal(20,6) column: at most 14 integer digits and 6 fractional digits; rejects zero, negative, NaN, scientific notation and junk suffixes.
   - Added strict YYYY-MM-DD calendar-date validation (rejects impossible dates).
   - Applied the shared validators to the company exchange-rate input schema. Dates and rates are validated before database writes.

4. `server/routes/exchangeRateRoutes.ts`
   - Reads and writes are scoped to **the current session company**, even for Developer; a mismatched explicit companyId is rejected instead of falling back or accessing another company's rate.
   - Enforces the company's configured base/display currency pair for rate read requests and POST saves, including XOF -> legacy CFA alias normalization.
   - `GET /api/exchange-rates` supports optional pair filtering for its current company while preserving its existing unfiltered-company response for older callers.
   - `GET /api/exchange-rates/latest` selects only that company's configured pair, as of the company business date. Invalid/missing rates return null; never a fabricated rate of 1.
   - `GET /api/exchange-rates/check-today` returns company business date, rate availability, and latest valid earlier rate when present. Missing or invalid foreign rates are reported explicitly.
   - `POST /api/exchange-rates` remains protected by Admin/Owner/Developer access via `requireRole("Admin","Owner")`, uses the existing transactional audited `saveCompanyExchangeRate` service, and never creates FX-REVAL journal entries.
   - A `daily: true` save request must match the server's current company business date, preventing a stale modal open across midnight from misposting yesterday's rate as today's. Historical date entry is still available through the settings form.

5. `client/src/components/DailyRateModal.tsx`
   - Uses the same strict rate validation and existing company-aware base/display pair.
   - Refuses to submit without the company's server-provided business date, replacing a prior browser-date fallback.
   - Marks automatic daily saves with `daily: true`, so the server validates the date.
   - Validates the prior rate before it can be copied into today's rate. Dynamic labels and placeholders now work for Zambia instead of hardcoded CFA examples.
   - Keeps per-company/per-date browser dismissal cache; backend is the source of truth for saved rates.

6. `client/src/components/ExchangeRateSettings.tsx`
   - Currency pair/history/latest queries now key by company ID and pair and send an explicit active-company check; switching from Mali to Zambia does not reuse the same rate cache.
   - History is filtered by the active pair and displays all available dated rows for that pair (rather than just the previous 10).
   - Only Admin/Owner/Developer see the editing control. Server authorization still protects writes.
   - Date default comes from backend company business day, not a local browser fallback. Authorized users can still supply legitimate historical/future effective dates in the settings form; the latest-rate reader excludes future rates.
   - Shows a missing-today message; when there is no usable earlier rate, warns that local-currency transactions need a confirmed rate.
   - Corrected the prior success toast that inaccurately implied an immediate posting/revaluation of all cash balances. Rate saves do not alter historical vouchers.

7. `client/src/pages/settings/CompanyTimezoneCard.tsx`
   - Added **Africa/Lusaka (UTC+2)** as the Zambia company-timezone option.
   - Invalidates daily rate and latest-rate queries after a timezone change, since the company business date may change.
   - Selecting Africa/Lusaka is an authorized user action after release; no live Zambia settings were changed by this code commit.

## Design constraints / known follow-ups

- Zambia company #19 was read-only verified in Phase 1 as USD-base with no display currency and parent company #1. That configuration is intentionally NOT updated in production here. The user explicitly forbids production database changes until Claude verifies the complete implementation and release is approved.
- Activation after approval: switch to Zambia, set display currency **ZMW**, keep base **USD**, set company timezone **Africa/Lusaka**, then record the approved daily USD/ZMW rate. Do not invent or auto-fetch an initial production rate.
- Phase 4 must generalize `CurrencyContext` and toggle components, which still hardcode USD/CFA; Phase 5 must wire the POS (including sales imports and invoices); Phases 6–10 must complete voucher, cash/bank, stock/Factory and report integrations before production activation.
- The ERP rate is **ZMW per 1 USD**, not Factory's **USD per 1 ZMW**.
- Company rates are stored per company/date/pair. A saved newer rate must never retroactively reprice old vouchers; current cash/bank report-only translations remain governed by existing accounting rules.
- `GET /api/exchange-rates/latest` now validates the active company's configured currency pair. Claude should review any external or legacy clients that previously requested unrelated pairs, and update them to explicit supported workflows, rather than removing tenant safeguards.
- Existing fallback timezone behavior for unconfigured companies is UTC. Selecting `Africa/Lusaka` in Company Timezone is essential before Zambia's initial daily rate is entered.

## Claude verification gate — deferred by user request

Do not run until the complete feature branch has all implementation phases:
- Admin/Owner/Developer can save authorized USD/ZMW rates; POS/Manager/ERP Tester cannot.
- Non-matching companyId and currency pair are rejected; Mali's USD/CFA records never appear in Zambia rate history or vice versa.
- Company 19 accepts USD/ZMW but refuses EUR/ZMW. Partial changes respect the effective saved base/display currency values.
- Daily rate modal uses the correct server business date in Africa/Lusaka and rejects stale-day saves at rollover.
- Validate zero, negative, invalid, too-precise, out-of-range and malformed exchange-rate inputs; prevent silent 1:1 foreign conversions.
- Check recent/past/future effective-date selection and same-day audited updates, including concurrency.
- Verify company switching, cache isolation, business timezone invalidation, rate alerts and rate history.
- Verify all unchanged USD/CFA behavior and cash/bank historical rules.
- Run all CI, compiler, lint, unit, integration and end-to-end tests after the remaining phases and reconcile authorized historical balances.

## Status

- [x] Same working branch; commits for Phase 3 code and this handoff document.
- [x] User-requested code implemented without production writes.
- [x] No merge, deploy or migration.
- [x] No CI, lint, typecheck, build or tests executed.
- [ ] Phase 4–11 implementations: intentionally deferred.
- [ ] Independent testing/reconciliation: Claude's final gate.
