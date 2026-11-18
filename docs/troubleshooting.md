# Troubleshooting

## Vite Not Found / Build Dependency Missing

**Symptom**: `prebuild` script fails with `Cannot find module 'vite'` or similar.

**Cause**: `node_modules` was deleted or never installed, or a fresh clone has not run `npm install`.

**Fix**:
```bash
npm install
npm run build
```

If the issue persists after install, clear the Vite dev cache:
```bash
rm -rf node_modules/.vite
npm run dev
```

---

## npm Install / Build Issues

**Symptom**: `npm install` fails with permission errors, peer dependency conflicts, or missing packages.

**Notes**:
- On Replit: use the built-in package management tool — do not run `npm install` directly in the agent bash tool (it is blocked in the agent sandbox).
- Peer dependency warning from `eslint-plugin-react-hooks`: this project pins to `5.2.0`. Version `7.x` requires `zod-validation-error/v4` which is not exported by `zod-validation-error@3.x`. Do not upgrade past `5.2.0` without also upgrading `zod-validation-error`.
- If `npm run build` times out in the Replit sandbox, this is a known resource constraint. The build passes correctly on GitHub Actions and Render. Verify via CI instead.

---

## React `useState` / `useContext` Crash ("null dispatcher")

**Symptom**: White screen with console error: `Cannot read properties of null (reading 'useState')` or similar React hook errors.

**Common causes and fixes**:

**A — Stale Vite chunk cache (most common)**

The service worker may be serving old cached JS chunks that reference a different React instance than the current bundle.

Fix:
```bash
rm -rf node_modules/.vite
```
Then in the browser: open DevTools → Application → Service Workers → click "Unregister". Hard-reload with `Ctrl+Shift+R`.

To prevent recurrence: bump `CACHE_VERSION` in the service worker file (`client/public/sw.js` or equivalent) to force cache eviction on all clients.

**B — Hook called inside a conditional block**

A component calls `useEffect`, `useState`, or another hook inside an `if()` statement. React requires hooks to be called unconditionally at the top level.

Fix: move the hook call to the top of the component, outside any conditional.

**C — Radix UI Tabs missing required wrapper**

Using `<Tabs>` + `<TabsContent>` without `<TabsList>` / `<TabsTrigger>` causes a null context dispatcher crash.

Fix: always include `<TabsList>` even when using custom visual buttons for tab switching.

**D — Wouter v3 `component=` prop with a plain function**

In wouter v3, using a plain function (not a React component) as a `component=` prop causes an invalid hook call.

Fix: ensure `component=` receives a proper React component (use `createElement`, or define the component outside the router).

---

## Inventory Shows Zero Items / Empty Location

**Symptom**: Location inventory page shows no items even though stock exists.

**Diagnosis steps**:
1. Confirm the correct company is selected (top bar company selector). All inventory queries are scoped to `currentCompanyId`.
2. Check the `locationId` filter. If a location from a different company is selected, the route returns 403 and the UI falls back to empty.
3. Query the `inventory` table directly — verify rows exist with `quantity > 0` for the expected `(companyId, locationId, stockItemId)`.
4. Check whether `adjustInventory()` was called correctly for the most recent stock movement (not bypassed with raw SQL).

---

## Database Pool Pressure

**Symptom**: Requests queue and time out. Server logs show:
```
[DB Pool] trigger=acquire-under-pressure total=10 idle=0 waiting=N
```

**Cause**: Too many concurrent requests are holding DB connections, exhausting the pool.

**Fixes**:
- Increase `PG_POOL_MAX` env var if the DB plan allows more connections. Default is `10`. With two Render instances: `10 × 2 + session store ≈ 22 connections`.
- Look for long-running transactions that hold a connection across slow operations (e.g. PDF generation, external API calls). Move external calls outside the DB transaction.
- Connection timeout is `8000ms`. Under pool exhaustion, requests wait up to 8 seconds then fail with a connection timeout error.

---

## Render Build Failure

**Symptom**: Render deployment fails during the build or startup step.

**Common causes**:

**A — Missing `SESSION_SECRET`**
Server logs: `CRITICAL: SESSION_SECRET environment variable is not set!`
Fix: add `SESSION_SECRET` in Render's environment variable settings (a strong random string).

**B — `DATABASE_URL` not set**
Server crashes immediately: `No database configuration found. Please set DATABASE_URL or provision a PostgreSQL database.`
Fix: add `DATABASE_URL` or connect a Render PostgreSQL add-on (which sets it automatically).

**C — SSL mismatch with PostgreSQL**
Connection error at startup.
Fix: try setting `PGSSLMODE=disable` in Render's env vars if the PostgreSQL instance does not require SSL.

**D — Build timeout from `npm run check`**
`tsc --noEmit` can take 2–5 minutes on this codebase. If Render's build command includes `npm run check` and times out, either increase the timeout or run type-checking in CI only.

**E — Startup refuses: "Database schema does not match this release"**
The schema gate found pending migrations, missing/changed objects or no
migration history. Run `npm run db:migrate:status` and `npm run db:verify`
against the database, apply migrations with `npm run db:migrate` (or adopt a
legacy database with `npm run db:adopt`). See docs/database-migrations.md.
`drizzle-kit push` is not used.

---

## Git Divergent Branch Issue

**Symptom**: `git pull` fails with:
```
fatal: Need to specify how to reconcile divergent branches.
```

**Fix options**:
```bash
# Option 1: Merge (safe, preserves history)
git pull --no-rebase

# Option 2: Rebase local commits on top of remote
git pull --rebase
```

**Warning**: Do not use `git reset --hard origin/main` unless you are certain you want to discard all local commits. Use Replit's checkpoint rollback feature to revert safely.

---

## API Returns 404 Unexpectedly

**Symptom**: Frontend calls `/api/something` and gets 404 even though the route exists in code.

**Cause**: After a route-split refactor, a sub-directory route file may not be imported by its parent barrel (`server/routes.ts` or `server/routes/someModule/index.ts`). Orphaned route files are silently ignored — the Express app never registers them.

**Fix**: Check `server/routes.ts` to confirm the route module is imported and its `register*Routes(app)` is called. Also check any `index.ts` barrel in sub-directories.

---

## API Returns 500

**Symptom**: Server returns HTTP 500 with a generic error message.

**Diagnosis**:
1. Check server logs for the full stack trace.
2. `"relation does not exist"` → a DB migration is pending. Restart the server to trigger auto-migration.
3. `"column does not exist"` → same as above; a new column was added to the schema but the `ALTER TABLE` statement was not added to `server/index.ts` migrations.
4. Null reference on an orphaned FK row → a row references a deleted parent. The FK is `NOT VALID` so the DB did not catch it.

---

## CSRF 403 on API Calls

**Symptom**: State-changing requests return `403 CSRF token missing or invalid`.

**Cause**: The `X-CSRF-Token` header is missing or stale.

**Fix**: Confirm the frontend fetches `GET /api/csrf-token` on app load and includes the returned token as `X-CSRF-Token` on all POST/PUT/PATCH/DELETE requests. If a regression is suspected, temporarily set `CSRF_ENFORCE=0` to switch to warn-only mode and confirm this is the cause before debugging the token flow.
