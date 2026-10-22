# Factory Net Position — Phase 2: shared historical date engine

Branch: `feature/factory-net-position-historical`  
Status: IMPLEMENTED (source changes committed; CI/test execution intentionally deferred to Claude)

## Contract adopted

The report is a cumulative **historical-knowledge-as-of** snapshot: an activity that first occurred or was recorded on October 21 must not appear when looking at October 19, even if its business document refers to an earlier date.

- One selected `asOf` business date per response, inclusive through company-local 23:59:59.999.
- Company timezone comes from `company_settings.timezone` (validated IANA identifier); UTC is the consistent fallback when missing/invalid. A browser-supplied `X-Client-Date` is not the authority for a shared company financial report.
- Date request format is strict `YYYY-MM-DD`, with real-calendar validation; future dates are refused with a structured HTTP 400. Missing `asOf` means company business today.
- Historic events with a business/effective date and a reliable created/recorded timestamp must satisfy **both** cutoffs. Business-effective-date-only accounting statements can still have a distinct basis outside this report.
- Bitemporal helpers are provided for the upcoming party, production and stock changes. When a timestamp is unknown, do not invent one, silently re-date it, or treat a current mutable state as a proven historical event.
- A date filter must be applied to ALL asset/liability lines, subtotals, and details, not merely an outer wrapper.
- Historical data may be incomplete prior to event-capture backfill (Phase 8); the API and UI must distinguish a partial snapshot from an accurate one.

## Files and API behavior

**New shared contract:** `shared/factoryNetPositionAsOf.ts`
- `isValidNetPositionDate`: strictly validate real calendar days.
- `isValidNetPositionTimezone` and `netPositionBusinessDay`: calendar day for the company timezone.
- `resolveFactoryNetPositionDay`: missing date -> today; malformed/future -> `FactoryNetPositionDateError`.
- `FactoryNetPositionAsOf` contains `asOf`, `businessToday`, `timeZone`, `isHistorical`, and `historyBasis: "known-at-cutoff"`.

**New server date engine:** `server/services/factory/netPositionAsOf.ts`
- `resolveFactoryNetPositionAsOf(companyId, requestedAsOf)` resolves the same company date context for its entire request.
- `netPositionEffectiveThrough`, `netPositionRecordedThrough`, `netPositionKnownTransactionThrough` provide parameterized Drizzle SQL predicates.
- The recorded-timestamp predicate uses **exclusive start of the following company-local day** via PostgreSQL `AT TIME ZONE`, not `end-of-day = UTC 23:59:59`. It supports `timestamptz` and explicitly-labelled UTC-naive `timestamp` storage. DST is respected.

**Main GET route:** `server/routes/factory/employee-pos/employeeNetPositionRoutes.ts`
- One validated date context is resolved after company selection and passed to the current calculators as `asOf`.
- Successful responses additionally include `businessToday`, `timeZone`, `historyBasis`, `historyCompleteness` and `historyWarnings`.
- The legacy historical production-value correction is awaited **inside the main handler**, after the response body is assembled and before it is sent.
- Malformed/future as-of -> HTTP 400 with `INVALID_AS_OF_DATE` or `FUTURE_AS_OF_DATE`.
- A detected historical projection contract failure -> HTTP 503 `HISTORICAL_NET_POSITION_UNAVAILABLE`, never a 200 with silently substituted current figures.
- Existing current-day response fields and valuation math remain unchanged by this phase.

**Removed interception:** `server/routes/factory/employee-pos/index.ts` no longer registers a separate `res.json` interception route. The existing calculator lives in `netPositionHistoricalCorrection.ts`, now exported as the awaited transitional helper. Phases 4–5 should replace its approximate replay with genuine dated inventory movements and retire the helper.

**Frontend:** `FactoryNetPositionDetails.tsx` and `FactoryNetPosition.tsx`.
- Blank internal date means server-selected company business today (omits `asOf` from request).
- Date-picker display, previous/next and Today navigation use `businessToday`/`asOf` returned by the server, not UTC `new Date().toISOString()`.
- A historical snapshot is not infinitely cached, because repaired/backdated records can change its accuracy.
- Historical views visibly warn that amounts are partial while event-level categories remain unimplemented. The detailed custom subtotal passes the displayed as-of date into the payroll subquery; the payroll endpoint itself is a Phase 3 gap.

**Authored tests (NOT executed):** `tests/factory-net-position-as-of.test.ts` contains invalid/leap-day, future-date, timezone, midnight rollover and DST acceptance cases. Claude can execute with other tests later.

## What Phase 2 intentionally DOES NOT claim

The date engine and route/UI propagation are implemented, but it is **not** a fully reconstructed historical financial report yet. The Phase 1 audit identified live/current values in employee balances and advances, raw stock, order lifecycle, OTW status, rental status, old deletions and mutable prices. Those are explicitly assigned to Phases 3–6 (and backfill/reconciliation Phase 8). The server exposes `historyCompleteness: "partial"` for prior-day snapshots until the source-level audit and corrections are complete. It must not be switched to `"complete"` just because the date parameter changes totals.

No writes to vouchers, employees, containers, bale stock or production records are performed by this implementation. No SQL migration was required in Phase 2. No CI, tests, merge or deployment were run.

## Handoff to Phase 3

For customers/suppliers/employees:
1. Use `FactoryNetPositionAsOf` and the new recorded/business-date predicates, not direct `req.query.asOf` parsing.
2. Select immutable voucher/transaction and creation timestamps; reconstruct employee payroll detail rather than `employees.currentBalance`.
3. Keep the original-currency and effective FX rules; do not treat an imported container's present status as its historical status.
4. Preserve net-position de-duplication of customer-linked ledger accounts and pre-finalization charges.
5. Ensure row/section totals reconcile under both the standard view and hidden-account custom view.
6. Surface source-data quality issues where historic known-at-time cannot be proven.
