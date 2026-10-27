# Pressing Machines — Phase 7: Shifts, Downtime, Machine Analytics

**Branch:** `feature/pressing-machine-tracking`  
**Status:** source implemented. Not merged or deployed.

## Supervisor shift controls

Located in Factory → Stock Entry → Pressing Machines below scanning and permanent history.

- Supervisors (Manager, Admin, Owner, Developer, except POS View Only) can create and edit shift name, code, start and end **local time**, valid IANA timezone and active status. Disabling preserves all historical confirmations.
- A company's active shifts must use a common timezone and cannot overlap. Adjacent shifts may meet exactly at the boundary; nonzero-duration overnight shifts can span midnight. Writes use a company-specific transaction-scoped advisory lock to serialize concurrent schedule changes.
- Workers see their current server-resolved shift name/timezone; workers cannot edit the schedule or access the supervisor shift list.
- The pressing confirmation engine selects the configured active shift at the **server receipt time**. It stores the shift ID on the immutable pressing confirmation record and opens a session for the operator, machine and assignment.
- At shift boundary the prior session is closed and a new session is created. Previous confirmations retain their original session and shift ID.
- An uncovered time is recorded with `shift_id = NULL`, never guessed or attributed to the wrong shift. The existing `production_date` still means the actual factory-local **calendar date** at the server confirmation instant. For an overnight shift, filtering by calendar date can split the shift across two calendar days. The helper also computes previous-day shift-business-date when needed for future shift-day-specific reports.
- Daylight-saving offsets are determined by IANA `Intl.DateTimeFormat` for each actual instant, not a hard-coded offset. The missing/repeated local hour follows the underlying timezone rules; exact physical scans remain timestamped with unique UTC instants.

## Downtime

Supervisors can mark a machine as down and record one of:
`MAINTENANCE`, `MACHINE_FAULT`, `MATERIAL_SHORTAGE`, `POWER_OUTAGE`, `BREAK` or `OTHER`, with optional notes.

- Downtime events preserve precise server start time, optional session ID, reporting supervisor, reason, and subsequent server end time.
- A partial unique database index enforces **one currently open downtime per machine**. Duplicate start attempts return a conflict. Ending downtime is idempotent and does not overwrite previous evidence.
- Machine row locks serialize start/end operations with confirmation scans. A pressing scan during recorded machine downtime is explicitly rejected with `PRESSING_MACHINE_DOWN`, preventing falsely counted production.
- Open machine downtime records are shown first to ensure the supervisor can end them even with a long history.
- Downtime is not automatically inferred from gaps between successful scans.

## Productivity and analytics

`GET /api/factory/pressing-machines/analytics` requires supervisor access and accepts validated factory production dates, optional machine, shift and operator, up to 91 calendar days.

Returns:
- Accepted, non-voided pressing bale count and stored confirmed KG.
- Per calendar date, machine and shift: bale/KG counts, distinct operators and first/last server confirmation instants.
- **Observed scan-window rates:** bales per hour and KG per hour, derived from elapsed time between first and last accepted scan in the row group. For a single-scan group or zero elapsed time, rates are **null**, not an invented numeric value.
- Explicitly recorded downtime durations, clipped to the specified factory-local period using IANA timezone-aware SQL `AT TIME ZONE`, including DST changes.
- Machine planned target bales/hour for comparison; targets are user-entered planning values, never represented as measured machine output.

**Important interpretation:** Observed scan-window throughput is NOT measured mechanical pressing cycle time, true operating efficiency, or utilization. Because an employee may scan after actual pressing, the interval between scans also cannot prove how long a bale took to press. Downtime time is reported **only when a supervisor explicitly records it**. When operator or shift filters are applied, recorded downtime remains scoped to the selected calendar period and optional machine filter, not operator or shift. The UI displays this limitation.

The analytics API fails with an explicit error when more than 3,000 daily/shift group rows or recorded downtime rows match. It does not silently drop rows or inflate totals.

## Safety boundaries

- All APIs are behind the existing Factory page/tab access middleware and authoritative active-company context. Supervisor mutations enforce manager role server-side and do not accept company/user identity from the browser.
- Shift and downtime writes are within database transactions and create ERP audit entries.
- No inventory, raw-material mix costing, Factory stock status, finalization workflow, stock movement or vouchers are changed by Phase 7.
- Machine confirmation idempotency and company+bale lifetime duplicate protection remain unchanged.
- Existing Phase 1–6 tables and their migrations remain unchanged; **Phase 7 requires no new database migration**.

## Executed verification (2026-10-27, isolated PostgreSQL 16.15)

`tests/pressing-machine-tracking.database.test.ts`: Day 07:00–15:00 and Night 22:00–06:00 in `Africa/Lubumbashi` are accepted; an overlapping shift is `PRESSING_SHIFT_OVERLAP`, a different timezone is `PRESSING_SHIFT_TIMEZONE_CONFLICT`, an invalid IANA name is 400 and a worker is 403; the worker's `/shifts/current` matches the server-side resolver; a confirmation stamps the resolved shift and, when the open session belonged to another shift, closes it and opens a new one (one open session per operator); open downtime makes a scan `PRESSING_MACHINE_DOWN` with no row written, a second open downtime is 409, ending is idempotent, and scanning succeeds after it ends; analytics refuse ranges over 91 days and non-supervisors, and the summary equals the database's active count for the day. Production dates, the report's "today" and analytics now share one factory timezone resolver (`factoryTimezone`): the active shifts' timezone, else Factory settings, else UTC. A live DST transition was not observed; the resolver is unit-tested with `Intl` for a midnight boundary.

## Verification

Added:
- `server/services/factory/pressingShiftTime.test.ts` — overlaps, shift boundaries, overnight local dates, timezone and DST behavior.
- `tests/pressing-machine-phase7-contract.test.ts` — route registration, tenant/role scope, session rollover, downtime lock/guard, accepted-only analytics and accounting isolation.

Before merge or deployment, run (on a checked-out working tree):

```sh
npm run check
npx vitest run server/services/factory/pressingShiftTime.test.ts tests/pressing-machine-phase7-contract.test.ts
npx vitest run tests/pressing-machine-phase4-contract.test.ts tests/pressing-machine-phase6-contract.test.ts
npm run verify:migrations
```

Isolated PostgreSQL and phone/browser acceptance:
1. Define Day 07:00–15:00, Evening 15:00–22:00, Overnight 22:00–06:00 in one factory timezone. Reject any overlapping shift or mismatched timezone.
2. Confirm a bale at 21:59:59 and 22:00:01 server time on the same operator, validate session rollover and distinct shift IDs with no duplicate count.
3. Test a shift through midnight and a DST transition; make sure the confirmation's UTC and factory-local timestamps agree.
4. Record downtime, attempt a scan and verify no new confirmation; end downtime, then scan successfully.
5. Confirm single-scan group rate is blank, multi-scan rate derives from recorded server instants, and manually logged downtime is measured separately.
6. Verify supervisor permissions, cross-company denial, POS view-only denial and session-based employee assignment checks.
7. Confirm no Factory status, valuation, mix inventory or accounting voucher side effects.

No live or production tests have been asserted by source-only checks.
