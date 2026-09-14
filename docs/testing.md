# Testing Guide

## Test tiers

| Tier | Configuration | Environment | Purpose |
|---|---|---|---|
| Backend | `vitest.config.ts` | Node + PostgreSQL where required | APIs, accounting, inventory, security, static contracts, and integration flows |
| Frontend | `vitest.config.frontend.ts` | jsdom | React rendering, interactions, responsive behaviour, RTL, and accessibility contracts |
| Smoke sweep | `vitest.config.smoke-sweep.ts` | Built app + PostgreSQL | Registered API shapes and non-5xx behaviour |
| Release | GitHub Actions + CircleCI | Node 24.19.0 + PostgreSQL 16 | Coverage, ratchets, build, security, migration, resilience, and exact-SHA certification |

Do not record passing-test totals in this reference document. The suite changes
frequently; the authoritative count is the output attached to the exact commit
being certified.

## Local commands

```bash
# TypeScript, lint, formatting, and production build
npm run check
npm run lint
npm run audit:lint-ratchet
npm run format:check:changed -- --base origin/main
npm run build

# Backend and frontend regressions
npm run test:backend
npm run test:backend:verify
npm run test:frontend
npm test

# Coverage and ratchet evaluation
npm run test:backend:verify:coverage
npm run test:frontend:coverage
npm run audit:coverage-ratchet

# API smoke sweep after the disposable database and built app are ready
npm run test:smoke-sweep
```

`npm run check` already supplies the repository's required TypeScript heap
budget and `--noEmit`; do not substitute a weaker command.

## Database-backed tests

Use PostgreSQL 16 for parity with CI. Database-backed certification uses a
throwaway database:

1. set `DATABASE_URL`, `PGSSLMODE=disable`, `NODE_ENV=test`,
   `SESSION_SECRET`, `CSRF_ENFORCE=0`, and `ENABLE_SCHEDULERS=false`;
2. run `npm run verify:migrations`;
3. provision only the disposable schema with
   `node node_modules/drizzle-kit/bin.cjs push --force`;
4. run the built server once and wait for `/api/health/db` so idempotent
   startup migrations complete;
5. execute the backend and smoke suites.

Never use `drizzle-kit push` against a persistent or production database.

## Static repository contracts

The main CI lane runs these before or alongside the test suites:

```bash
npm run verify:env-docs
npm run audit:type-escapes
npm run audit:doc-index
npm run audit:write-routes
npm run audit:write-evidence
npm run audit:toolchain
npm run audit:scripts
npm run verify:lockfile
npm run verify:production-dependencies
npm run verify:observability
npm run verify:final-production-readiness
npm run verify:bandwidth
```

The baselines are one-way ratchets. Existing ceilings may fall, but a change
must not widen them merely to make CI pass.

## Skips and todos

An `it.skip`, conditional skip, or `it.todo` is acceptable only when the test
itself names the unresolved production or fixture dependency. New unexplained
skips are failures. When the underlying issue is fixed, remove the skip in the
same change and let the current test output establish the new total.

## Final certification

A change is complete only when all of the following apply to the same commit:

- GitHub Actions CI, security, CodeQL, Semgrep, i18n, RTL/accessibility, mobile,
  workflow-quality, and release-verification checks are green when triggered;
- CircleCI `static-build`, `postgres-regression`,
  `backend-core-regression`, `frontend-regression`, and
  `security-readiness` are green;
- the `Main Certification` status is green on the exact merged `main` SHA;
- coverage floors and all repository ratchets pass without widened allowances.

Normal `CI` is a pre-merge PR gate and does not rerun automatically after a
`main` push. `.github/workflows/main-certification.yml` is the authoritative
post-merge application certification for the exact resulting `main` SHA.

For Phase 6 and other final-cleanup work, certify only a branch head whose merge
base is the current `main`; if `main` advances, resync first and restart the
exact-head checks rather than relying on a green run from the superseded base.

PR checks certify the proposed head. After merge, inspect the new `main` SHA
again; a green superseded commit is not final certification.
