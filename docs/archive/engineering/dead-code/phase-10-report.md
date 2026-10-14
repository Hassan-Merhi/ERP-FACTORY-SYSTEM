# Phase 10 — Database and migration code

**Status: COMPLETE (no deletions warranted).** Branch `refactor/erp-dead-code-cleanup`.
No migration was executed and no database was contacted.

## What was checked

| Area | Finding | Action |
|---|---|---|
| `migrations/` (48 files, drizzle journal with 31 entries plus registry-applied SQL) | Historical records; `git diff 3a210f3..HEAD -- migrations` is empty. | Preserved untouched. Never delete, rewrite or reorder. |
| `server/startup-schema/` (33 ordered startup migrations + `index.ts`) | Every module is registered in `index.ts`; none is orphaned; unchanged by the program. | Preserved. |
| `shared/schema/**` table definitions | 62 exported `pgTable` objects (mostly `shared/schema/runtime/*`) are not referenced by application code. They describe tables that exist in production and are read by drizzle-kit (`drizzle.config.ts`), `config/runtime-only-tables.json` and maintenance tooling. Removing a definition would let `drizzle-kit push` propose dropping a live table. | Preserved. |
| `shared/schema/**` types and zod schemas | 296 unreferenced `Insert…`/`$inferSelect` type aliases and 3 unused `insert…Schema` zod objects. These are the conventional public contract of each table, carry no runtime cost and are part of the shared schema surface. | Preserved (documented). |
| DB helpers (`server/db.ts`, `server/lib/queryResult.ts`, query wrappers, storage modules) | Covered by the Phase 5–6 per-file export and reachability analysis. Unused storage functions were removed in Phase 5; the shadowed `server/storage/index.ts` barrel in Phase 6. | Done in earlier phases. |
| Compatibility code for prior data states | SP migration cut-over handlers already retired in Phase 3/5 (their routes were unreachable). Remaining migration/cut-over modules (`sp-migration/*`, `spMigrationPhase*`) serve live, registered routes for historical data. | Preserved. |

## Uncertain items kept on purpose

- `server/routes/sp/spMigrationFinalVerification.ts` — unmounted since Phase 3; exports helpers its
  own test uses. Retire together with that test once SP migration verification is closed.
- SQL files present in `migrations/` but not in `meta/_journal.json` (e.g.
  `0017_canonical_stock_movement_journal.sql`) are applied through the startup/registry path
  (`scripts/verify-migration-registry.mjs`); they are historical and stay.
