# Deployment

## Local Development

```bash
# Install dependencies
npm install

# Start development server (Express + Vite hot reload)
npm run dev
```

The dev server runs on port `5000` (configurable). Vite serves the frontend at the same port via Express middleware (`server/vite.ts`). No separate frontend dev server is needed.

---

## Build

```bash
# Verify build tools are available, then build
npm run build
```

This runs two steps (see `package.json` `build` script):
1. `vite build` — compiles and bundles the React frontend into `dist/public/`
2. `esbuild server/index.ts --platform=node --packages=external --bundle --format=esm --outdir=dist` — bundles the Express server into `dist/index.js`

The `prebuild` script asserts `vite` and `esbuild` are resolvable before the build starts.

---

## Production Start

```bash
node dist/index.js
```

The server reads env vars at startup. Missing required vars (especially `DATABASE_URL` or the PG* set) cause an immediate crash with a clear error message.

---

## Environment Variables

**`.env.example` is the source of truth.** It documents every variable the
server reads — currently 97 — with its default and effect, grouped by area.
`npm run verify:env-docs` fails CI if the two ever drift, so the file cannot
go stale the way it previously did.

Only two variables must be set:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. Takes priority over the individual `PG*` vars, which are the fallback for platforms that inject discrete values. |
| `SESSION_SECRET` | Signs session cookies. The process **exits** when this is missing and `NODE_ENV=production`. |

Everything else has a working default. The handful worth knowing when
deploying:

| Variable | Default | Why it matters |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables Secure cookies and production-mode static serving. |
| `CSRF_ENFORCE` | enforcing | `"0"` downgrades CSRF failures to warnings. Escape hatch only. |
| `CAPACITOR_ENABLED` | off | Set when this server backs the mobile app — switches the session cookie to `SameSite=None`. |
| `ENABLE_SCHEDULERS` | `true` | Set `false` in CI and test environments. |
| `PG_POOL_MAX` | `10` | Main connection pool ceiling. Session store has its own, `PG_SESSION_POOL_MAX` (default `3`). |
| `PGSSLMODE` | unset | `"disable"` turns off TLS to the database. |
| `BUILD_VERSION` | derived | Shown in the UI header; falls back to `RENDER_GIT_COMMIT`, then `"dev"`. |

**AI features** are optional and independent — the chatbot and AI import stay
disabled unless `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `XAI_API_KEY` is set.

**Emergency master-password login** needs all three of `MASTER_PASSWORD`,
`MASTER_PASSWORD_ENABLED=true`, and a future `MASTER_PASSWORD_EXPIRES_AT`.
Setting the password alone does nothing. It cannot impersonate Admin or
Developer accounts, and every use is logged as a security event. See the
Security section of `.env.example` before enabling it.

**WhatsApp** needs no environment variables. Its instance ID and API token are
stored per-company in the `whatsapp_settings` table and managed from the app's
settings UI (`server/services/whatsappService.ts`).

---

## Render Deployment Notes

The app is designed to run on [Render](https://render.com). Key points:

- Use `DATABASE_URL` env var (Render provides it automatically for PostgreSQL add-ons).
- Set `SESSION_SECRET` to a strong random string in Render's environment settings.
- Set `NODE_ENV=production`.
- Pool size: the default of `PG_POOL_MAX=10` means two zero-downtime instances use up to 22 connections total (10×2 + session store connections). Render's free PostgreSQL tier allows 97 connections — well within limit. Raise `PG_POOL_MAX` if more concurrency is needed and the DB plan allows it.
- SSL is auto-enabled for non-Replit, non-`PGSSLMODE=disable` connections. Render's internal PostgreSQL may need `PGSSLMODE=disable` if SSL certificates are not required (Needs verification).
- `BUILD_VERSION` is auto-populated from `RENDER_GIT_COMMIT` if not set explicitly.

**Zero-downtime deploy**: Render's rolling deploy starts a new instance before draining the old one. The PostgreSQL session store handles sessions across instances. Ensure `SESSION_SECRET` is stable across deploys.

---

## GitHub Actions CI

Workflow file: `.github/workflows/ci.yml`

Triggers on `push` and `pull_request` to `main`.

Steps:
1. Harden the runner and download the exact triggering repository archive.
2. `actions/setup-node@v7` with Node 24.21.0 and npm cache.
3. `npm ci --no-audit --bin-links=true` from `package-lock.json`.
4. Run environment, type-escape, documentation, write-route, write-evidence,
   toolchain, and script-inventory contracts.
5. Run TypeScript, the production build, ESLint plus its warning ratchet, and
   the changed-file Prettier gate.
6. Provision the disposable PostgreSQL schema with `drizzle-kit push --force`,
   boot `dist/index.js`, and wait for `/api/health/db` so startup migrations
   complete.
7. Run backend and frontend coverage suites, the API smoke sweep, and the
   coverage ratchet.

CI provisions a PostgreSQL 16 service container and sets `DATABASE_URL`,
`SESSION_SECRET`, `CSRF_ENFORCE=0`, and `ENABLE_SCHEDULERS=false`. The test
suites need a migrated database — running them against a schema that has only
had `drizzle-kit push` applied, without the startup migrations in step 6,
produces spurious failures.

A separate `.github/workflows/security.yml` runs the dependency audit gate
(`npm run verify:dependency-audit`) and TruffleHog secret scanning on every
push and PR, plus a weekly scheduled sweep across all dependencies.

**Note**: `npm run check` has a 4 GiB heap budget in the canonical CI environment
and is a blocking gate. A local resource limit does not waive the exact-main
certification requirement.

---

## Database Migrations

Persistent schema migrations are **not** managed via `drizzle-kit push`. Instead:

- Runtime migrations are grouped in `server/startup-schema/` and registered in
  `server/startup-schema/index.ts`.
- Each migration is idempotent (uses `IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, etc.).
- Migrations run automatically on server startup before the app begins serving requests.

To add a new column or table:
1. Update `shared/schema/` with the new Drizzle definition.
2. Add an idempotent migration module under `server/startup-schema/` and register
   it in `server/startup-schema/index.ts`.
3. Run `npm run verify:migrations`.
4. Do **not** run `drizzle-kit push` against a persistent database.
