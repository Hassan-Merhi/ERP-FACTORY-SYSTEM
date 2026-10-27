# Phase 5 — Historical FX dates, cache correctness and audited rate safeguards

**Status:** Phase 5 source implementation committed 2026-10-27 on
`feature/fx-monetary-valuation`. No CI/tests/typecheck or production SQL
execution has been performed. No merge into `main`, no Render deployment,
no production database write or voucher adjustment. The Phase 4 feature
branch integration has NOT been certified against live company balances.

## Behavior delivered

### 1. Historical effective rate preview (read only)

`GET /api/accounts/multi-currency/rates-as-of?asOf=YYYY-MM-DD`

- Authenticated, non-POS request; `companyId` from the authenticated session
  only. The database read uses a repeatable-read, read-only transaction with
  `assertTransactionCompanyScope`; no caller-chosen tenant.
- Validates calendar dates (not merely a date-shaped string), and rejects a date
  later than the company's **local business date**.
- Uses `datedMonetaryRateTx`: only a company's saved rate effective on or
  before the selected date can be returned. Includes configured display
  currency even if its rate is missing, plus saved company currency pairs.
  `XOF` canonicalizes to `CFA`.
- Returns exact effective date, source direction, stored row ID, rate both
  directions, `MISSING` statuses and unresolved currency list. Conflicting
  same-day opposite-direction rates return an explicit 409 error; no guessed
  rate or fallback to a future price.
- **This is a RATE preview only.** Output explicitly has
  `historicalBookUsdLocked: true` and `historicalBalancesRevalued: false`.
  The source system does not guarantee an immutable timeline for every account
  opening, deletion and legacy voucher, therefore translating *today's*
  balance with an older rate and presenting it as a historical balance sheet
  would be false. This endpoint never does that.

### 2. No stale current Net Position from another server process

`server/routes/stats/statsNetProfitRoutes.ts` bypasses the process-local TTL
cache for current / unfiltered Net Position and sets no-store headers. Exact
`toDate` requests retain cached **historical booked USD**, whose original
posting rates must not be changed by a management rate edit. The response
header is optional to retain compatibility with Group Net Position's captured
response proxy. Phase 3 already bypasses the live group snapshot's TTL and
broadcasts the company-scoped FX realtime topic, which now works with the
fresh current Net Position computation on every worker.

### 3. Rate-save idempotency and audit

`server/services/accounting/exchangeRateWrites.ts` keeps the existing atomic
save/audit transaction, and adds:

- Same existing numerical rate => returns the unchanged row without a new
  UPDATE or duplicate audit record. Still checks for conflicting inverse
  same-day rates so a no-op cannot pretend the pair is healthy.
- Detects two or more stored rows with identical
  `companyId + effectiveDate + fromCurrency + toCurrency`. Returns
  `FX_RATE_DUPLICATE_ROWS` (409) instead of updating an oldest row while the
  reader uses a different, later row. **No automatic deletion or arbitrary
  winner selection.**
- After an actual USD-to-foreign insert/update but before the transaction
  commits, invokes the authoritative dated rate resolver against that date.
  If a same-day inverted quote disagrees or the exchange rate is invalid,
  rolls back the save and audit together.
- Audit includes old/new rate, company/date/pair identity and explicit
  `CURRENT_MANAGEMENT_USD_ONLY` scope. Original voucher FX remains locked.
  The route returns typed 409 conflicts rather than an ambiguous 500.
- All cache refresh occurs only on success after commit. A no-op or
  future-effective successful request can still trigger harmless refresh
  messages through the current shared success pipeline; it does not create
  a monetary accounting adjustment.

### 4. Current-versus-historical separation

The already implemented Phase 4 overlays apply only to:
- ERP Net Position without `toDate`;
- ERP Accounts without period start/end date;
- Factory Net Position when `!asOfContext.isHistorical` and the pinned
  Factory company equals the authorized current ERP selection;
- current ERP/Factory customer balance list reads where company scope and
  original currency/book USD reconciliation are verified.

All explicitly dated historical balance sheets and past Factory reconstruction
retain their stored historical book USD. Stock, raw material, production,
supplier and nonmonetary assets never inherit a monetary FX rate. An unresolved
or differently attributed account remains at book USD with a provisional
diagnostic instead of a substituted USD amount.

### 5. Read-only operational diagnostics

`phase-5-read-only-rate-diagnostics.sql` is a manual inspection script to
identify duplicate rate rows, conflicting reciprocal pairs (including
`XOF`/`CFA` aliases), and nonpositive stored values. It performs no
mutations and was not run during Phase 5.

## Regression tests added

- `tests/fx-rate-phase5-history-cache-audit.test.ts`: dated-rate cutoff,
  future rejection, session company isolation, no historical balance
  projection, current uncached Net Position, no-op save and no-journal
  audit boundary (source contract tests).
- Phase 2–4 tests and existing money/voucher and daily popup tests remain
  release prerequisites; tests are written but **not executed** here.

## Known release gates / Phase 6

1. Execute unit, integration and TypeScript tests on the branch and fix
   failures before any deployment. Existing `exchange-rate-daily-popup`,
   `money-exact-batch-18`, `wave9-ledger-safety-routes` must still pass.
2. Run tenant-scoped Phase 1 native opening/voucher provenance checks and
   Phase 5 rate duplicate diagnostics on a permissioned read-only database
   session. Resolve duplicates by reviewed, audited migration — never
   silently delete or overwrite historical evidence.
3. Reconcile every transformed line and total for a USD/CFA company, USD/ZMW
   company, USD-only company, and multiple mixed-currency / negative-signed
   loan/customer examples. Confirm no customer-linked ledger is counted twice.
4. Verify every feature-branch Phase 4 screen and Factory's operational memo /
   posted accounting split, and confirm no old-period GL/voucher changes.
5. Verify distributed current Net Position no stale quote on multiple Render
   processes, after duplicate saves, future-dated saves and historic rate edits.
6. Obtain an authorized mapping of which generic `Asset` accounts are
   **monetary**. None are auto-approved from names.
7. Historically reconstructed monetary balances require independent
   source-level known-at evidence before they can be translated; Phase 5's
   rate preview intentionally does NOT certify older balance reconstruction.

**Accounting policy remains:** native CFA/ZMW/EUR remains identical; only
eligible current USD management presentation changes. No new FX-REVAL
journal, no changed original voucher, no recalculated inventory cost.
