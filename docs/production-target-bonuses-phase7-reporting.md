# Production Target Bonuses — Phase 7: History, Statements, Excel

Status: **Phase 7 reporting source complete on an isolated branch, not activated**. Phase 8 must integrate with the independently implemented Phases 1–6, run end-to-end tests, reconcile live-compatible accounting, then authorize merge/deployment. No payment writes, migration, production data edits, or main-branch changes in Phase 7.

## What Phase 7 adds

- Immutable per-worker bonus history with original production date, *credited* bales (solo plus that worker's allocation of linked team output), original target, extra bales, configured historical rate, proposed/approved amount, review state and verifiable payment reference.
- Currency-separated summaries: **pending proposals** are not owed; **approved/unpaid** is outstanding; **posted/paid** requires a real voucher. Rejected/voided records remain in history but do not count as accepted pay.
- Admin-only read route: `GET /api/factory/production-target-bonuses/report?start=YYYY-MM-DD&end=YYYY-MM-DD[&workerId=...]`. Report supports date ranges of up to 366 production days; user-facing panel has worker/status filters.
- Worker statement summaries and formatted Excel with four worksheets: Bonus Overview, Worker Bonus Totals, Bonus History and Worker Statements. Exports include voucher/account provenance, rate and award snapshots. Formula-like worker names are escaped.
- Strict exact-cent aggregation, mixed-currency separation, duplicate-award validation and focused regression tests.

## Required Phase 8 integration contracts

1. Wire `registerFactoryProductionTargetBonusReportRoutes(app, loadHistory)` in the Factory router **only after** Phases 1–6 establish an authoritative bonus award + payment source. The `loadHistory` function must query the active `companyId` server-side, populate each row’s mandatory `companyId` for defense-in-depth, and filter by earned `productionDate`; honor optional `workerId`. **Do not use `worker_bonuses` (legacy manual bonuses) or `factory_production_bonus_allocations` (position/payroll bonuses)** as the new production-target award source.
2. Map source award IDs and person IDs to immutable snapshots matching `ProductionTargetBonusHistoryRow` in `shared/productionTargetBonusReporting.ts`. The source should return exactly one record per immutable worker award. A linked team's combined output must **not** be emitted once for each member: the award's `creditedBales` is the individual worker share. An award's money is its stored approved rate/amount, never calculated using current targets or membership.
3. Set `POSTED` only when the transactionally posted, non-retired Deposit Expense voucher exists and is associated with the award. Supply `paymentVoucherId`, `postedAt`, and `paymentAccountNameSnapshot`. A reversed/retired payment must revert to an unpaid or voided award as appropriate, not remain paid. Approval alone is **not** payment; the report intentionally refuses inconsistent records.
4. Preserve `currency` of the approved historical rate. Do not add unlike currency amounts. For a posting in another currency, the posting service owns conversion/FX; this report reads only the original awarded currency amount.
5. Mount `<ProductionBonusHistoryPanel />` in the administrator/owner Production Targets bonus section after the review/post controls, and only when the read route is registered. Keep worker/pressing roles away from financial details, and preserve existing permissions. The backend `checkFactoryAdmin` is the authoritative protection.
6. Invalidate the report query key `["/api/factory/production-target-bonuses/report"]` after approval/rejection, posting, reversal and supervisor corrections. Do not let a stale React query misrepresent paid/unpaid.
7. Check the full end-to-end chain with *at least*: 14 bales linked 2 workers -> 7 each; a worker crossing target by 1 bale; rate change without historical rewrites; pending vs approved vs posted; selected payment account and Deposit Expense voucher; duplicate-post retry without a second expense; reversal of posted voucher; cross-company report denied; dates before and after worker link/unlink; mixed currency; Excel opened in Excel/LibreOffice; mobile viewport.

## Reporting semantics

The date picker limits **award earning dates**. A bonus earned October 20 and paid November 2 appears in an October report as **paid** when exported November 3. This is a *current-payment-status report for awards earned within the date range*, **not** a cash-flow report by posting date. Accounting cash movement remains in Deposit Expense/vouchers.

The report's accepted amount is exactly `approvedUnpaid + paid` (two disjoint categories). Rejected/voided and still-pending proposals never affect owed/paid totals. Use amounts stored at approval; no historical recomputation. All currency figures are two-decimal strings.

## Validation and release gate

Standalone tests:
- `npx vitest run tests/production-target-bonus-reporting.test.ts client/src/pages/factory/productiontargets/productionBonusHistoryExcel.test.ts`
- `npx tsc --noEmit` (run with repository's configured TS command)
- ESLint and Prettier on touched files
- Read-side tenant isolation, payment integrity and reversal integration tests **after** the Phase 5/6 loader exists

No Phase 7 code should be merged/deployed by itself. Phase 8 is the intended integration/release gate.
