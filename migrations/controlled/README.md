# Controlled database migrations (v2)

This directory intentionally starts **without SQL files**. Do NOT copy legacy `migrations/*.sql` here or automatically replay old migrations on production.

Each new reviewed migration must:
- Use the name `YYYYMMDD_NNN_description.sql`, in lexical deployment order.
- Be safe to run inside one PostgreSQL transaction; no explicit BEGIN/COMMIT, and no CREATE INDEX CONCURRENTLY.
- Supply a forward-only upgrade plus separate verification and recovery notes.
- Avoid rewriting already-posted accounting or stock records without independent approval.
- Be tested on a disposable restored snapshot before any production rollout.

CLI:
- `npm run db:migrations:plan`: local inventory, no database connection.
- `npm run db:migrations:status`: read-only comparison with database history.
- `MIGRATION_CONFIRMATION=APPLY_CONTROLLED_MIGRATIONS npm run db:migrations:apply`: explicit application with advisory lock, transaction-per-file, and immutable SHA-256 comparison.

History: `public.erp_controlled_migration_history`. This is **not** a replacement for legacy Drizzle or `schema_migration_history` until those old systems have been reconciled and formally retired. Never reset or seed either legacy history merely to force adoption.

This phase establishes the new mechanism only; it does **not** automatically enable it on Render, convert startup DDL, or migrate production data.
