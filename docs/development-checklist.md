# Development Checklist

Run these checks before every push to `main` or before opening a pull request.

---

## Automated Checks

```bash
# 1. Repository contracts and static ratchets
npm run verify:env-docs
npm run audit:type-escapes
npm run audit:doc-index
npm run audit:write-routes
npm run audit:write-evidence
npm run audit:toolchain
npm run audit:scripts

# 2. TypeScript type-check
npm run check

# 3. Build (full frontend + backend bundle and runtime dependency verification)
npm run build

# 4. Lint plus the per-rule warning ratchet
npm run lint
npm run audit:lint-ratchet

# 5. Format only the files changed from the intended base
npm run format:check:changed -- --base origin/main

# 6. Backend and frontend regression suites
npm run test:backend:verify
npm run test:frontend
```

If the format check fails, format the named files and re-run the same changed-file
check. The canonical CI and CircleCI gates use this changed-file scope.

Lint errors are blocking. Warnings are also ratcheted by total and by rule; they
may decrease but may not exceed `config/lint-warning-ratchet.json`.

---

## Manual Functional Tests

After starting the dev server (`npm run dev`), manually verify:

### Inventory

- [ ] Location inventory page loads without error for at least one location
- [ ] Stock items list shows items with correct quantities
- [ ] Stock transfer between two locations updates both location balances
- [ ] Stock adjustment increases or decreases inventory correctly

### Vouchers & Accounting

- [ ] Create a Journal voucher with balanced debit/credit — saves successfully
- [ ] Attempt to save an unbalanced Journal voucher — expect HTTP 400 error
- [ ] Voucher appears in the Daybook on the correct date
- [ ] Customer or supplier ledger reflects the new voucher

### POS

- [ ] POS user can log in and see the POS sale screen
- [ ] Adding items to a sale and completing it reduces inventory
- [ ] Completed sale appears in POS Daybook
- [ ] POS user cannot access ERP-only pages (e.g. `/daybook` should redirect or show Access Denied)

### Settings & Users

- [ ] Admin can create a new user and assign a role
- [ ] Advanced Restrictions page loads without error
- [ ] Toggling a restriction saves without error

### Factory (if changes affect factory)

- [ ] Bale scanning page loads and search dropdown works
- [ ] Arrow key navigation works in the bale product search dropdown
- [ ] Customer orders list loads

### Containers (if changes affect containers)

- [ ] Containers / OTW page loads
- [ ] Container tracking statuses display correctly
- [ ] Offload dialog opens for an OTW container

---

## Error Boundary Check

- [ ] No `ErrorBoundary` fallback is visible on any page after your changes
- [ ] Browser console shows no uncaught React errors
- [ ] Browser console shows no failed `import()` chunk errors

---

## API Health Check

- [ ] No `/api/*` routes return 404 that previously returned 200
- [ ] No `/api/*` routes return 500 after your changes
- [ ] Server logs show no new stack traces after startup

---

## Schema / Migration Check (if you changed `shared/schema/`)

- [ ] Added an idempotent migration in `server/startup-schema/` and registered it in `server/startup-schema/index.ts`
- [ ] Ran `npm run verify:migrations`
- [ ] Server starts and logs `✓ Database tables and columns verified/migrated` without errors
- [ ] Did **not** run `drizzle-kit push` against a persistent database

---

## Route Check (if you added or moved route files)

- [ ] New route file is imported in `server/routes.ts` (or its sub-barrel `index.ts`)
- [ ] `register*Routes(app)` is called for the new module
- [ ] Test the new endpoint with a direct API call to confirm it responds

---

## Permission Check (if you added a new page or action)

- [ ] If a new page was added, consider whether it needs a `page_*` permission key in `shared/permissionConfig.ts`
- [ ] If a new action was added, consider whether it needs an `act_*` permission key
- [ ] Routes that should be blocked for POS users have `requireNonPOS` middleware applied
- [ ] Routes that should be blocked for non-admins have `requireRole(...)` applied

---

## CI

`main` is certified by the canonical GitHub Actions suite, the five CircleCI
lanes (`static-build`, `postgres-regression`, `backend-core-regression`,
`frontend-regression`, and `security-readiness`), Release Verification, and the
exact-main certification status. A green PR is necessary but not sufficient:
after merging, verify the checks again on the exact merged `main` SHA.

## Dead Code

- [ ] Code you stopped using is deleted, not renamed with a `_` prefix
- [ ] No second registration of an existing method + path unless the earlier handler calls `next()`
- [ ] Retired pages lose their lazy export, `offlinePrep` entry and page-mount test cases
- [ ] New exports are imported somewhere; new dependencies are imported somewhere
- [ ] See [dead-code-prevention.md](dead-code-prevention.md); `npm run report:dead-code` lists leads
