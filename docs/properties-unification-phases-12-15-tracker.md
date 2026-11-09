# Properties Mode — Follow-up Unification Execution Tracker (Phases 12–15)

**Date:** 2026-11-09  
**Working branch:** `properties-unification-phase12` (from `main`)  
**Merge target:** `main` (not merged by Phase 12)  
**Safety:** No production mutations, accounting changes, schema changes, currency conversions, or CI triggered.

| Phase | Scope | Status |
| --- | --- | --- |
| 12 | Date boundaries and rental filter consistency | **Source implementation and focused tests committed; runtime execution pending** |
| 13 | Parent-route and navigation registry convergence | **Source implementation and regression additions committed; runtime execution pending** |
| 14 | Company-role and historical currency/financial parity | **Source implementation and parity tests committed; live finance/runtime verification pending** |
| 15 | Integrated TypeScript, regression, browser/API and finance certification | Not started |

## Phase 12 — changes

1. `client/src/properties/config/rentalReportingPresentation.ts`: added `rentalPeriodBounds` and `isRentalDayInRange`, preserving the recorded YYYY-MM-DD calendar date and company business date. Current-month, current-year and rolling 30-day periods are now **inclusive from period start through business today**; future-dated records are excluded. Existing `rentalPeriodStart` and `isRentalDayInPeriod` remain for compatibility with existing callers/tests.
2. `client/src/properties/hooks/useRentalPaymentsFilters.ts`: uses both date bounds, fails closed on an invalid dated business-calendar boundary, and receives company ID explicitly. Company transitions reset search, period, tenant and unit selections. Invalid tenant/unit values fall back to All immediately and are cleared so they cannot reactivate when removed options return.
3. `client/src/pages/properties/RentalPaymentsLog.tsx`: passes selected company ID to the filter hook. No change to ERP/Factory payment listing period behavior, backend payment posting, cash reconciliation, or receipt totals.
4. `tests/ui/properties-unification-phase12-filters.test.tsx`: added tests for inclusive boundaries, future dates, invalid calendar dates, leap year, year crossing, company switching and stale selection cleanup.

## Phase 12 acceptance

- [x] Current month, year, and 30-day period ranges have an inclusive end at company business today.
- [x] Recorded payment calendar days are compared without browser-local timezone shifts.
- [x] No future-dated record may pass a dated Properties filter.
- [x] A selected-company transition resets search, period, unit, and tenant filters.
- [x] Removed unit/tenant options cannot silently re-activate an old filter.
- [x] Existing module API roots, voucher history, ledger, and receipt math are untouched.
- [x] Focused hook and date-boundary regression test cases committed.
- [ ] Execute Vitest and TypeScript checks in runnable checkout.
- [ ] Browser QA with actual company switch, refetch and date filter selections.

## Execution and certification

The source changes were made through GitHub and read back for static inspection. No checkout, package installation, TypeScript compiler, Vitest runner, browser session, CI or production database testing was available in this connected execution. Do not report authored tests as passed tests.

Suggested focused commands in a runnable checkout:

```bash
npm run check
npx vitest run --config vitest.config.frontend.ts tests/ui/properties-unification-phase12-filters.test.tsx
npx vitest run tests/properties-unification-phase8-presentation.test.ts
```

**Phase 12 disposition:** Implementation complete at source level; runtime and integration verification must be completed before production release.

## Phase 13 — changes and verification

1. `client/src/properties/config/propertiesNavigation.ts`: canonical registry now owns the deterministic Properties parent-route contract, including matched dynamic account-ledger details and compatibility aliases. Corrected Account Groups parent to Accounts, Create Property parent to the Warehouses tab, and ledger vouchers parent to the precise monthly ledger.
2. `client/src/lib/parent-routes.ts`: all Properties parent lookups delegate to `getPropertiesParentRoute`. ERP and Factory parent logic is unchanged.
3. `tests/properties-parent-routes.test.ts`: expanded test matrix for registry metadata parity, root pages, deep links, legacy aliases, query/hash, trailing slashes, malformed and unknown URLs.
4. `docs/properties-navigation-registry.md`: documented single-source Back/Escape logic and intentionally preserved compatibility behavior.

### Phase 13 acceptance

- [x] One canonical Properties parent resolver is used by the shared Back/Escape helper.
- [x] Registry metadata matches the deterministic parent destinations for concrete routes.
- [x] Account Groups, Create Property and ledger voucher parents match the existing intended navigation.
- [x] Existing `/properties/rental/*` bookmarks preserve tab destinations.
- [x] Unknown and malformed paths receive no invented parent; root pages remain roots.
- [x] Factory and ERP parent routing is unchanged.
- [x] Tests and documentation are committed.
- [ ] Execute Vitest and TypeScript in a runnable checkout.
- [ ] Browser-test Escape, Back/Forward, dynamic ledger URLs, and compatibility redirects.

Verification: GitHub source read-back and static invariants only. No CI, browser QA, Vitest, TypeScript run, production data modification or merge performed.

Run in a runnable checkout:

```bash
npm run check
npx vitest run tests/properties-parent-routes.test.ts
npx vitest run --config vitest.config.frontend.ts tests/ui/parent-routes-behavior.test.ts
```

**Phase 13 disposition:** Source implementation complete; automated and runtime certification pending.

### Integration notice (final Phase 13 comparison)

At the final Phase 13 comparison, `properties-unification-phase12` was **13 commits ahead and 157 behind** `main`. This is a changing snapshot, not a merge readiness certification. Phase 14/15 must reconcile current main, inspect semantic conflicts and rerun all relevant regression tests. No merge, rebase, CI or deployment has been initiated.

## Phase 14 — company-role and rental financial presentation parity (2026-11-09)

### Implemented
1. `client/src/properties/config/propertiesNavigation.ts`: fail-closed frontend visibility for a missing/non-Properties selected company or missing selected-company role, avoiding stale session-wide admin/developer visibility. Backend access decisions remain independently authoritative.
2. `client/src/properties/config/rentalCurrencyBasis.ts`: explicit `USD`, `NON_USD`, `UNKNOWN` classification. No missing currency is silently assumed USD.
3. `client/src/properties/config/rentalReportingPresentation.ts` and `client/src/pages/properties/property-rental/paymentsReceiptMath.ts`: USD-labelled totals and TSV exports now rely on the same verified-currency policy. Historical values and account reconciliation calculations are unchanged; unknown/foreign-currency exports are withheld rather than invented.
4. `client/src/pages/properties/PropertyRentalPage.tsx`, `RentalPaymentsLog.tsx` and `PropertiesPaymentsPremium.tsx`: show an explicit unverified-currency state rather than a fallback USD symbol for missing payment currencies. Preserve recorded numeric values, module endpoints, and read-only source records.
5. `tests/properties-unification-phase8-presentation.test.ts`: corrected legacy assumptions that a missing currency proves USD.
6. `tests/properties-unification-phase14-parity.test.ts`: added selected-company role matrix; USD/non-USD/unknown classification; export guard; immutable historical company ID and cutoff; voucher-backed rent, guarantee overlap and ledger-account balance separation.
7. `docs/properties-navigation-registry.md`: updated frontend permission contract to match the implementation.

### Source acceptance
- [x] No selected Properties company or assigned role means no Properties frontend visibility.
- [x] Selected-company role overrides stale cross-company session role.
- [x] Admin and Developer navigation remain distinct from ordinary user permissions.
- [x] Both USD aggregate guards and USD export guards require explicit recorded USD currency.
- [x] Unverified currency rows remain visible without falsely labelling them USD.
- [x] No FX conversion, ledger posting, voucher, historical cutoff, cash-account or schema changes.
- [x] Targeted parity tests committed.
- [ ] Execute Vitest and TypeScript in a runnable checkout.
- [ ] Validate historic missing-currency records against a read-only authoritative database extract and approve a specific migration/policy if needed.
- [ ] Independently reconcile recorded rent receipts, account balances, tenant deposits, guarantees and cashbox against ledger vouchers.
- [ ] Browser and authenticated API permission matrix across two selected companies, Admin/Developer/Manager/user/tester, revoked assignments.
- [ ] Latest-main reconciliation and regression testing.

### Release boundary
Unknown-currency historical rows may now suppress USD-only aggregates and exports. This is an intentional conservative presentation safeguard, **not** a currency conversion or historical data correction. Before release, independently confirm historical row currency evidence and provide an approved remedy for any legitimate legacy USD records with blank currency fields. Frontend visibility does not replace server authorization. No live DB/accounting verification, browser tests, Vitest, TypeScript, CI, merge, or deployment was executed in this connected session.

Suggested commands:
```bash
npm run check
npx vitest run tests/properties-unification-phase14-parity.test.ts tests/properties-unification-phase8-presentation.test.ts tests/properties-unification-regression.test.ts tests/properties-payment-history-reconciliation.test.ts tests/properties-unification-phase7-permissions.test.ts
npx vitest run --config vitest.config.frontend.ts tests/ui/properties-unification-phase12-filters.test.tsx
```

**Phase 14 disposition:** Targeted source work and regression artifacts complete. Runtime and independently reconciled financial parity are not certified; Phase 15 must perform release-level verification before main merge.

### Phase 14 branch integration snapshot
The post-implementation GitHub comparison showed **25 commits ahead / 158 commits behind** `main`, with 15 changed branch files. These figures are not a guarantee of conflict-free integration; `main` can move independently. Phase 15 must incorporate latest main, run compilation and both Vitest configurations, and certify role/currency/ledger behavior before deployment. No CI or merge was initiated during Phase 14.
