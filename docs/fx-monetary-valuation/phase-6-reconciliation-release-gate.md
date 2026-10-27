# Phase 6 — FX reconciliation, fixes, and release gate

**Branch:** `feature/fx-monetary-valuation`  
**Date:** 2026-10-27  
**Status:** SOURCE CORRECTIONS AND REGRESSION FIXTURES COMMITTED. Superseded by `phase-7-verification-and-fixes.md`, which records the automated verification actually executed on this branch, the defects it found in Phases 1–6 and their fixes. **Still NOT PRODUCTION-CERTIFIED**: read-only tenant reconciliation has not been run.

## Completed implementation and source-level review

1. Audited the Phase 2 monetary read-model against the authoritative `ledgerBalanceEngine` customer-linked ledger, bank-only and customer-only voucher attribution rules; both select posted `optional=false`, non-deleted company vouchers and use original currency amounts. A selected business-date cutoff restricts the read model to posted transactions as of that date. No new journal posting code was introduced.
2. Added an **opening-to-book reconciliation gate** in `monetaryFxValuationService.ts`. A nonzero opening is translated only if the supplementary historical base opening agrees within three cents with the actual stored original USD opening. A zero book opening with nonzero base/native metadata is also unresolved. Mismatch sets `openingBookMismatch: true`, `unresolvedOpening: true`, `provisional: true` and blocks current USD replacement for that account.
3. Changed the company rate resolution so one currency's invalid or conflicting saved rate cannot abort all other eligible currencies' read-time valuations. Failed currencies are flagged with `rateErrorsByCurrency`; affected nonzero foreign native balance buckets produce `currentTranslatedUsd: null` and the original USD report remains unchanged. Unexpected DB/programming exceptions still propagate instead of being silently swallowed.
4. Exposed `rateErrorsByCurrency` in the live ERP and Factory Net Position metadata; original currencies, book bases, stock and supplier figures remain unchanged.
5. Added reproducible **behavioral** fixtures in `tests/monetary-fx-phase6-reconciliation.test.ts`:
   - 61,200 CFA cash at 605 versus 612 CFA/USD, with native amount unchanged;
   - customer-linked ledger counted once under `customer:id`;
   - signed loan receivable/payable and a sign flip between asset and liability;
   - inventory and supplier entries never converted;
   - mismatched book history, unresolved native entry, and missing account ownership skipped;
   - no repeated revaluation of an already-translated report object;
   - Factory customer with non-posted memo excluded, and customer-ledger account display uses customer ownership.
6. Added `tests/monetary-fx-phase6-integration-safety.test.ts` for company scoping, repeatable-read read-only transaction, original currency evidence, no voucher writes, live-vs-dated guards and error metadata (retired in Phase 7: the same guarantees are asserted behaviourally in `tests/monetary-fx-valuation.database.test.ts`).
7. Prepared `phase-6-read-only-reconciliation.sql` to inspect, within an **approved selected company scope**, native opening provenance, historical base discrepancies, foreign voucher fields, forward-effective postings and shared customer ledger links. It has **not** been executed; it fails closed without a selected tenant.
8. Performed a GitHub source-level presence/contract review on the branch: **13/13 inspected source invariants present** (this is NOT equivalent to running the tests).

## Release verification still outstanding

| Gate | Status | Next step |
| --- | --- | --- |
| TypeScript `npm run check` | NOT RUN | Execute in actual project checkout and fix errors |
| New focused Vitest suite | NOT RUN | `node node_modules/vitest/vitest.mjs run tests/monetary-fx-valuation-phase2.test.ts tests/fx-rate-phase3-refresh.test.ts tests/fx-phase3-save-refresh-contract.test.ts tests/fx-rate-phase5-history-cache-audit.test.ts tests/monetary-fx-phase6-reconciliation.test.ts` |
| Legacy multi-currency and no-FX-journal tests | NOT RUN | Run `tests/multi-currency-integration.test.ts`, `tests/money-exact-batch-18.test.ts`, `tests/wave9-ledger-safety-routes.test.ts`, and `tests/exchange-rate-daily-popup.test.ts` |
| Full integration, typecheck, build | NOT RUN | `npm run test:backend`, `npm run check`, `npm run build` in an isolated runner |
| Company Mali CFA live original vs current USD reconciliation | NOT RUN | Read-only DB, verify customer/cash/loan native buckets, rates and book values |
| Zambia ZMW, USD-only and any non-USD functional base | NOT RUN | Read-only per-company verification; non-USD functional base remains provisional by policy |
| Same-company customer/bank linked-ledger reconciliation | SOURCE CHECKED ONLY | Run provenance diagnostic; compare accounts to trial balance per master |
| Physically monetary Asset approval registry | PENDING OWNER CLASSIFICATION | Generic `Asset` is deliberately `needs_review`; no code guessed or auto-approved |
| Factory operational memo vs posted customer balance | SYNTHETIC TEST WRITTEN; NOT RUN | Verify finalized-only customer source amounts in read-only tenant |
| GitHub workflow status at the last checked Phase 6 commit | NO STATUS/RUN REPORTED | Run a CI workflow from a reviewed branch/PR before merge |
| Main integration readiness | BLOCKED | Branch was observed ahead of main by 51 commits and behind by 1. Do not automatically rebase/merge without conflict review |

**Operational limitation:** Render returned `no workspace selected`; the connector specifically requires selection of a user-confirmed workspace ID and must not choose one automatically. Consequently, no live Render/production tenant database was accessed or changed and no real account counts or rate anomalies are claimed.

## Critical accounting policy for release

- CFA/ZMW/other native customer, cash, monetary asset and loan amounts stay exactly the same; only current verified USD management presentation changes with today's effective company rate.
- Supplier balances and supplier overpayments, stock, physical/fixed assets, WIP, raw-material costing, revenue/expenses and historical vouchers stay untouched.
- Loans preserve sign (Dr asset vs Cr liability); never append an FX delta to an existing account line instead of replacing that same canonical owner row.
- Generic Asset accounts require explicit verified monetary metadata; no guessed type-based inclusion.
- Historical management rate **preview** does not restate recorded historical USD balances. A selected historic date must have its own proven transaction/opening timeline, not today's balance multiplied by a past quote.
- Do not create an unbalanced automatic FX-REVAL journal. A booked gain/loss entry, if ever desired, requires a separate design, balanced controls and an owner decision.

## Decision

**Phase 6 implementation work has started and source fixes/tests are committed; production certification is withheld** until typechecking, tests, reviewed live read-only data reconciliation, and any needed follow-up repairs actually pass. No CI run, PR merge, Render deployment or accounting mutation performed in this work.
