# Fresh-Database Bootstrap — Known Gap & Fix Options

## TL;DR

- **Existing and production deployments are unaffected.** Their databases already
  contain the core tables, so every startup migration runs (or no-ops) cleanly.
- A **brand-new, empty database** cannot fully bootstrap from the app alone today:
  the startup migration array in `server/startup-schema/` **adds columns to and
  indexes** core tables such as `companies` and `vouchers`, but it **does not
  create those core tables**. On a truly empty DB those statements fail with
  `relation "companies" does not exist`, surfacing as "N migration(s) failed at
  startup" in the boot log. The app still starts (failures are caught), but the
  schema is incomplete.

This was mischaracterised earlier as a "migration ordering" issue. It is not an
ordering problem — the core-table `CREATE TABLE` statements are **absent** from
the runtime migration set, not merely out of order.

## Root cause

Two facts combine:

1. **`drizzle-kit push` is intentionally disabled.** Per `docs/deployment.md`,
   runtime schema is driven solely by the idempotent SQL array in
   `server/startup-schema/` (extracted from `server/index.ts`); `drizzle-kit
   push` is documented as "blocked by schema drift" and must not be run.
2. **The runtime array is not self-sufficient for a cold start.** It contains
   ~176 `CREATE TABLE IF NOT EXISTS` statements for tables added *over time*, plus
   many `ALTER TABLE` / `DO $$ … $$` column-additions against pre-existing core
   tables. The oldest core tables (`companies`, `vouchers`, `voucher_entries`,
   `stock_items`, `locations`, `users`, …) were originally created by a
   `drizzle-kit push` performed once, long ago. Since then every environment has
   carried them forward, so nobody hits the gap — until a database is created
   from scratch.

## Verification notes

- `server/startup-schema/` has **0** `CREATE TABLE … companies` / `… vouchers`
  statements, but multiple `ALTER TABLE companies …` / `ALTER TABLE vouchers …`.
- Booting the built server against a truly empty Postgres reproduces the failures;
  booting against a database that already has the core schema does not. The
  behaviour is identical before and after the logging/`startupSchema` refactors —
  i.e. this gap is pre-existing and unrelated to recent structural changes.
- The Drizzle schema itself (`shared/schema.ts`) is complete and internally
  consistent: a `drizzle-kit push` into a scratch database produces the full
  ~227-table schema (core tables included) without error. So the *definition* of
  the schema is fine; only the *cold-start path* is missing a baseline step.

## Fix options (team decision — needs the real schema)

Both options are safe to the running app; the choice depends on how you want to
own schema going forward, and both should be validated against a real database.

### Option A — Re-enable a one-time baseline via Drizzle (recommended if the drift is resolvable)
1. Reconcile `shared/schema.ts` with the actual production schema so
   `drizzle-kit push` no longer drifts (compare against a production dump).
2. Make bootstrap a two-step process: **(1)** `drizzle-kit push` (or a generated
   baseline migration) creates the core schema, **(2)** the existing runtime
   migration array runs and adds/patches everything else (it already no-ops on a
   correct schema).
3. Keep the runtime array as the incremental-change mechanism, exactly as today.

### Option B — Commit an authoritative baseline SQL dump
1. `pg_dump --schema-only` an **existing production** database (the authoritative
   source of the real, drifted schema) into e.g. `migrations/0000_baseline.sql`.
2. Have the bootstrap apply that baseline first on an empty DB, then run the
   runtime migration array.
3. This captures production's real shape (including any intentional drift) rather
   than the Drizzle-idealised shape.

> A baseline generated from a `drizzle-kit push` scratch DB is **not** a safe
> substitute for a production dump here, precisely because push is documented as
> drifting from production. Use a production `pg_dump` for Option B.

## Impact / priority

Low urgency: no current environment is affected, and new environments have always
been stood up by cloning an existing database. Worth doing before the first
genuinely-from-scratch deployment (e.g. a clean disaster-recovery rebuild), so
that path is exercised and known-good rather than discovered under pressure.
