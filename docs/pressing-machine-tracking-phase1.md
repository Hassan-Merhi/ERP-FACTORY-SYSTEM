# Pressing Machines Tracking — Phase 1 Database Foundation

**Branch:** `feature/pressing-machine-tracking`  
**Scope:** Database architecture only. No operator UI, scanner, API, permissions, merge, or deployment in Phase 1.

## Purpose and invariants

Pressing-complete is an **independent physical verification event**, not Factory stock finalization.
In particular, a camera scan must never call `POST /api/factory/finalize`, consume a mix batch,
change `factory_bales.status` to `IN_STOCK`, post a stock movement, or write a voucher.
Existing `PENDING_PRESSING` and finalized bale states keep their original meaning.

Eight new tables are declared in `shared/schema/factory/pressing-machine-tracking.ts`:

1. `factory_pressing_machines` — company-scoped machine catalog.
2. `factory_pressing_assignments` — effective-dated operator assignments; one open assignment per company/user.
3. `factory_pressing_shifts` — supervisor-defined wall-clock shift schedule and IANA timezone.
4. `factory_pressing_sessions` — operator's device-independent work session; one open session per company/user.
5. `factory_pressing_confirmations` — canonical, server-accepted successful scan; bale metadata snapshots, device/server time, factory-local production date, request ID and optional audited void.
6. `factory_pressing_downtime` — reported stoppages; at most one open downtime interval per machine.
7. `factory_pressing_corrections` — append-only supervisor correction events, with mandatory reason.
8. `factory_pressing_saved_views` — per-user, per-company condensed/detailed filters and column selection.

## Server-side integrity

- Unique partial index `(company_id, bale_id) WHERE voided_at IS NULL` guarantees **one active pressing completion per bale for its lifetime**, irrespective of machine, day, or operator.
- Unique `(company_id, request_id)` supports idempotent offline retries. Phase 4/5 must look up the existing response on conflict, not treat a different request ID as an allowed duplicate.
- Active assignment and session uniqueness is scoped to company/user. Historical records are never rewritten on reassignments.
- Composite foreign keys prevent cross-company machine/assignment/shift/bale links, and identity FKs ensure a confirmation matches the machine, assignment and user of its session.
- Correction records reject UPDATE/DELETE through a database trigger. Confirmations cannot be deleted or edited except for a **one-time void** with an existing supervisor correction event in the same transaction.
- The eventual supervisor void transaction must **insert the correction event first, then set `voided_at`/`voided_by` on the confirmation**, committing or rolling back together. The later replacement scan gets a new request ID and correction trail.
- All instants are `TIMESTAMPTZ`; `production_date` is the factory-local date derived by the server, not client-controlled. An offline device timestamp is evidence, not proof of when a scan occurred.
- Source bale's article, name, weight, reference, worker and machine attribution are saved as snapshots, so historical daily reports do not drift when master records change.

## Migration delivery

- Versioned SQL: `migrations/20261027_001_factory_pressing_machine_tracking.sql`; registered in `migrations/meta/_journal.json`.
- Idempotent startup DDL: `server/startup-schema/037-factory-pressing-machine-tracking.ts`; appended in `server/startup-schema/index.ts`.
- Drizzle models: `shared/schema/factory/pressing-machine-tracking.ts`, exported by `shared/schema/factory/index.ts`.
- `factory_bales` gains only a composite unique on `(company_id,id)` so PostgreSQL can enforce the tenant-safe confirmation FK. The runtime DDL creates it as a unique **index** (`factory_bales_pressing_tenant_id_uk`); the Drizzle model declares the same name as a table **constraint** on the canonical `factory_bales` definition in `shared/schema/factoryBilingualTables.ts`. The composite `(company_id, id)` and identity uniques on the pressing tables are likewise table constraints in the Drizzle models: drizzle-kit creates foreign keys before standalone indexes, so `drizzle-kit push` on a fresh database (CI's schema step) failed until they were. `CREATE ... IF NOT EXISTS` keeps the runtime and versioned paths idempotent on either shape.

No migration has been run against production by these source changes. The schema will apply only in an environment where the feature branch is deployed or the versioned runner is explicitly invoked.

## Follow-on phases

Phase 2 implements supervisor machine assignments and worker access;
Phase 3 the continuous phone camera;
Phase 4 accepted completion writes, validation and duplicate responses;
Phase 5 offline retries;
Phase 6 historical reports, saved views and Excel;
Phase 7 shifts, downtime and analytics;
Phase 8 supervisor corrections, permissions and full verification.

## Executed verification (2026-10-27, isolated PostgreSQL 16.15)

- `drizzle-kit push --force` on an empty database: succeeded (it failed before the constraint fix above).
- `migrations/20261027_001` and `_002` applied twice with `psql -v ON_ERROR_STOP=1`: second pass is all `already exists, skipping` notices, no errors.
- Startup stages 037/038 applied on top of the versioned migration, then every one of the 1,480 startup statements on the same database, then a full `node dist/index.js` boot: `/api/health/db` reported `failureCount: 0` and `verify:startup-migrations` passed with ceiling 0.
- `tests/pressing-machine-tracking.database.test.ts` exercises the constraints with live data: one active confirmation per bale under racing operators, one active assignment per operator, cross-company FK rejection, UPDATE/DELETE of confirmations and corrections refused by the triggers, void without a prior correction refused.

## Verification before rollout

- Run `npm run verify:migrations` and `npx vitest run tests/pressing-machine-schema-contract.test.ts tests/startup-schema-integrity.test.ts`.
- Apply the versioned SQL to an isolated PostgreSQL 16 database twice (idempotency), including one with the startup stage already applied.
- Race two transactions attempting the same bale on different machines: exactly one ACTIVE row may commit.
- Verify company-isolation foreign keys, one active assignment per operator, request-key uniqueness, and rejected UPDATE/DELETE against correction events and confirmed bales.
- Confirm no inventory, cost, or voucher tables change after creating physical-completion data.
