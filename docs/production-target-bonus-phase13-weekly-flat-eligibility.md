# Phase 13 — Weekly flat-bonus eligibility from finalized worker credits

Branch: `feature/production-target-bonuses-unified` (continued from Phases 1–12).

## Implemented (read-only)

- Admin/Owner-only Production Bonuses panel: **Weekly flat bonus eligibility — preview only**, date-in-week calendar picker, summary and per-worker breakdown.
- Session-company-scoped `GET /api/factory/production-target-bonuses/weekly-preview?weekOf=YYYY-MM-DD` route, requiring Production Targets tab access and returning `Cache-Control: private, no-store`.
- The server determines the week as **Monday–Sunday (Asia/Beirut calendar dates)**, loads the exact historical saved method version (not the capped settings-history list), and blocks bonus eligibility until **the following Monday**.
- The source is **Phase 9's immutable captured physical-bale/category evidence** and finalized daily Production Targets snapshots, not the mutable stock catalog nor the worker's current category.
- Each physical bale is credited to exactly one worker via Phase 9 worker/day/category evidence. Historical link membership for that date is respected; later unlinking or linking does not change earlier frozen attribution.
- A worker receives **one weekly total**, not one fee per category, production day or extra bale. Switching among Bags/Toys/Shoes (even within a day) adds credited bales to the same weekly worker total.
- The **weekly target is the sum of one finalized individual target per worked day**. An absent day with zero production contributes no target. Missing/zero/invalid target on a worked day blocks that worker; absent worker with production blocks that worker.
- **Strictly over target** is eligible: e.g. 56/56 = no bonus, 57/56 and 90/56 = the same configured fixed fee. Rate is exact USD cents, with no per-bale multiplication.
- **Fail closed** for incomplete/unfinished weeks, unfinalized production dates, missing/corrupt captures, inconsistent credits, repeated bale IDs across different production days, malformed daily targets, duplicate source days, missing configured flat method, and any prior legacy/category worker-day review or approved factory payroll bonus claim. The calculation returns zero proposed USD and explicit reasons for blocked workers.
- A source week with no saved production dates is blocked; days without any Production Targets activity are treated as non-working days, not automatically incomplete.
- `proposalOnly: true`, `canApprove: false`, `canPost: false` are always returned. There are no new database writes, approvals, payment claims, payroll allocations, vouchers, Deposit Expense postings or Daybook entries.

## Business assumptions requiring end-to-end certification

- An absent day contributes zero target; a present day with a missing target blocks calculation instead of treating the target as zero.
- When no Production Targets record exists for a date, it is treated as non-working. A separate attendance/calendar integration would be required to prove a missing expected workday.
- Historical dates created before immutable Phase 9 capture will show a blocked weekly bonus rather than reconstructing a guess from current category, link or stock information.
- Any existing legacy/category review (including a rejection) for a worker during the week blocks the new weekly preview until the exact cross-method payment/reconciliation policy is defined.
- One weekly flat amount applies regardless of how many categories a worker processed. Category rate settings are not used by the weekly-flat amount.

## Validation

Focused pure regression tests added at `shared/productionTargetBonusWeeklyCalculation.test.ts` for linked-to-unlinked days, category changes, 55/56/57/90 thresholds, Monday boundaries, absent workers, missing/invalid frozen data, method unset and existing review/payroll claims.

Before shipping, execute TypeScript checks, backend and frontend tests, route manifest, DB startup/tenant tests, and actual PostgreSQL evidence data reconciliation. The GitHub connector alone does not execute these suites. The unified branch remains **unmerged and undeployed** pending Phases 14–16 and financial certification.
