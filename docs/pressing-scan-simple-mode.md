# Pressing Scan — Simplified Ground Scan Mode

This specification supersedes the previously implemented complicated Phase 2 and Phase 7 UI.

## What workers see

Factory > Stock Entry > Pressing Machines works like Ground Scan: barcode input, Enter/Scan button, optional continuous phone camera, simple scan status, server-confirmed bale list, total bales and KG, date/user filters, and Excel export.

Only the existing user/page permission must be configured. A permitted employee opens the page, and the server automatically creates an internal station and assignment if needed. Every accepted scan records the authenticated user, not a configured shift operator. Workers can see their own results; supervisors can filter by employee.

## Removed from the active system

- Configured shifts, shift schedules, shift selection and shift productivity analysis.
- Machine downtime controls and machine-down scan blocking.
- Productivity reports, bales/hour, KG/hour and machine targets.
- Manual machine management, employee-machine assignments and machine history UI.
- Advanced report saved-view/column configuration UI.

The Phase 7 operation routes are no longer registered. The former manual machine management routes are replaced by restricted authenticated GET /me and POST /activate endpoints under /api/factory/pressing-machines. The shared internal station is needed only for existing schema foreign keys. New pressing confirmations have shift_id=NULL and use company timezone settings for production_date.

## Preserved

Permanent server history, barcode uniqueness across users, immutable audit corrections, supervisor-only voids and rescans, safe offline retries, original request IDs, exact timestamps including seconds, and Excel export of filtered rows.

The existing PostgreSQL pressing schema remains untouched. Do not drop shift/machine/downtime tables because earlier records or foreign keys may reference them. If the two pressing migrations were already executed in TablePlus, no additional SQL is required for this simplification.

A pressing scan NEVER changes Factory bale stock status, stock counts, raw-material costs, or accounting vouchers.

## Verification

Updated tests include simplified permission and user initialization contracts, offline confirmation, report filtering and a real-PostgreSQL integration suite covering automatic activation, concurrent duplicate scans, actor/company isolation, immutable corrections and unchanged stock.

Local TypeScript checks, Vitest tests, isolated PostgreSQL tests and real-phone camera verification remain required before merging/deploying.

Branch: feature/pressing-machine-tracking. Do not merge or deploy without explicit instruction.