# Pressing Machines — Phase 2: Machine Management and Operator Assignments

**Branch:** `feature/pressing-machine-tracking`  
**Status:** source implementation committed; database / browser execution pending isolated environment.  
**No merge, deployment, or live data change.**

## Delivered

- New **Pressing Machines** tab directly after Daily Scan in Factory → Stock Entry, lazy loaded when opened.
- Machine catalog: create (immutable company-scoped machine code), rename, activate/deactivate. Deactivation closes open assignments and sessions in one transaction, with no hard delete.
- Eligible-operator picker draws from current company's active ERP users, requiring Factory and Pressing Machines access; excludes view-only/tester roles and POS view-only operators.
- One current machine per operator, with atomic reassignment: the old assignment and active session are closed before the new assignment row is inserted.
- Unassign employees and retain historical assignment IDs, actor IDs, and exact timestamps.
- Company-scoped operator-only `me` response (no other people's assignment details) and supervisor-only machine, employee, and history endpoints.
- Audit records created within each mutation transaction. Database Phase 1 unique partial indexes remain authoritative for concurrent assignments.
- Independent page/tab backend ownership via `hide_tab_stockentry_pressing_machines`.

## Current supervisor definition

Existing company roles **Manager**, **Owner**, **Admin**, and **Developer** are supervisor-capable for this feature. They must have the Pressing Machines page/tab visible; POS view-only users are denied. The server reads authoritative company roles using `getActiveCompanyPermissionContext`, not a client role or cached session role.

## API

| Method | Endpoint | Access |
| --- | --- | --- |
| GET | `/api/factory/pressing-machines/me` | Authenticated operator; own assignment only |
| GET | `/api/factory/pressing-machines` | Supervisor; machine, active assignments, eligible users |
| GET | `/api/factory/pressing-machines/history` | Supervisor; optional machineId/userId, capped to 200 |
| POST | `/api/factory/pressing-machines` | Supervisor; create |
| POST | `/api/factory/pressing-machines/:id/update` | Supervisor; rename or activate/deactivate |
| POST | `/api/factory/pressing-machines/assignments` | Supervisor; create/reassign idempotently |
| POST | `/api/factory/pressing-machines/assignments/:id/end` | Supervisor; unassign |

All POST routes use authenticated, CSRF-protected application request helpers on the frontend and strict Zod body validation on the server.

## Isolation and transaction rules

- Every mutation obtains company ID from the authoritative active-company permission context and restricts database reads/writes to that company.
- The user's active assignment is serialized by a PostgreSQL transaction-scoped advisory lock. An existing assignment to the same machine produces an unchanged result without adding history.
- Unique `(company_id, user_id) WHERE unassigned_at IS NULL` provides the final database backstop.
- Assignments are rejected for inactive machines and missing, inactive, view-only, or non-F​​actory-authorized users.
- Machine deactivation acquires a row lock so a concurrent assignment cannot succeed against a newly inactive machine.
- No Phase 2 endpoint creates pressing confirmations, changes bale statuses, consumes mix material, or posts inventory or accounting.

## Executed verification (2026-10-27, isolated PostgreSQL 16.15)

`tests/pressing-machine-tracking.database.test.ts` runs the real handlers: supervisor creates machines (duplicate code 409); Worker, POS view-only and another company's supervisor are refused; a second company sees only its own machines and operators; three racing reassignments of one operator leave exactly one active assignment with the earlier ones closed in history; deactivating a machine ends its assignments and sessions in one transaction and a later scan with the stale assignment is rejected; the other company cannot toggle it (404). The browser pass on a narrow viewport was not performed in this environment.

## Validation to run before merge

- `npx vitest run tests/pressing-machine-phase2-access.test.ts tests/pressing-machine-schema-contract.test.ts tests/startup-schema-integrity.test.ts`
- `npm run check` and `npm run verify:migrations` on a checked-out branch.
- Isolated PostgreSQL 16: create two machines and two users; race two assignments to different machines for the same operator; one active assignment must remain.
- Try managing machines with Worker/View Only/ERP Tester roles (403), and with Manager/Owner/Admin (as granted by tab permissions).
- Assign from a different company; must fail without exposing the other company record.
- Deactivate a machine with existing assignment/session, re-enable, and confirm previous historical rows remain readable.
- Confirm Company 1 record changes do not appear in Company 2; verify audit action and no stock/cost/voucher changes.
- Mobile: test create/assign/rename/unassign/history on a narrow viewport and test hidden-tab visibility.

## Next phase

Phase 3 builds continuous phone-camera scanning, focus/torch support as available, scan cooldown, and audio/haptic feedback. **Phase 2 intentionally does not submit pressing confirmations yet.**
