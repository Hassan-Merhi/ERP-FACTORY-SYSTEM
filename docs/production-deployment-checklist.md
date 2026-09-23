# Production Deployment Checklist

This is the current release checklist. Historical audit snapshots belong in
`docs/archive/`; do not copy old test counts, dependency versions, or resolved
incidents into this reference.

## Certified platform

| Component | Required baseline |
|---|---|
| Node.js | 24.19.0 (`.node-version`, `.nvmrc`, CI, CircleCI, and Render) |
| PostgreSQL | 16 |
| Build | `npm ci --registry=https://registry.npmjs.org/ && npm run build` |
| Start | `npm start` |
| Readiness health check | `/api/health/ready` |
| Deployment source | Exact green commit on protected `main` |

`render.yaml` is the source of truth for the Render service, database,
commands, health check, Node version, and `autoDeployTrigger: checksPass`.

## Required environment

- `DATABASE_URL`
- `SESSION_SECRET`
- `NODE_ENV=production`

Review `.env.example` for every optional setting. Keep migration approval
controls, historical-replay apply controls, signing material, and provider
secrets out of source control. `npm run verify:env-docs` must pass.

## Before merging

`main` must satisfy `.github/RELEASE_GOVERNANCE.md`: PR-only changes, blocked
force pushes/deletion, a current PR head, and required checks enforced by
GitHub. The permanent Release Governance workflow must also be green on the
exact PR head.

Run the permanent local gates that apply to the change:

```bash
npm run verify:env-docs
npm run verify:lockfile
npm run verify:production-dependencies
npm run audit:type-escapes
npm run audit:doc-index
npm run audit:write-routes
npm run audit:write-evidence
npm run audit:toolchain
npm run audit:scripts
npm run check
npm run build
npm run lint
npm run audit:lint-ratchet
npm run format:check:changed -- --base origin/main
```

Database, coverage, smoke, backup/restore, mobile, i18n, accessibility, and
security lanes require their documented CI environments. Do not mark a local
resource limitation as a pass.

## Required remote checks

The PR head must be green, and the exact merged `main` SHA must be checked
again.

- GitHub Actions: Release Governance, CI, Security, CodeQL, Semgrep, Dependency
  Review when applicable, I18n Audit, RTL and Accessibility, Mobile
  Responsiveness, GitHub Actions Quality, Browser E2E and Performance & Database
  Safety when triggered, Release Verification, and resilience checks when
  triggered.
- CircleCI: `static-build`, `postgres-regression`,
  `backend-core-regression`, `frontend-regression`, and
  `security-readiness`.
- Post-merge commit status: `Main Certification`.

Do not merge with a pending, cancelled, skipped-required, or failed gate. Do not
rely on checks from an older SHA. Main Certification is the post-merge
application authority and must succeed on the actual resulting `main` SHA before
that commit is treated as application-certified. Specialist release, security,
and resilience checks retain their own authority for the guarantees they test.

## Database safety

- Persistent databases advance through reviewed versioned SQL and idempotent
  startup migrations.
- Run `npm run verify:migrations` for migration changes.
- Never run `drizzle-kit push` against production or another persistent
  database; CI uses it only to create a disposable test schema.
- Never test restore by overwriting production. Follow
  `docs/operations/database-backup-rollback-recovery.md`.
- Historical-replay or migration apply controls require their dedicated
  runbooks and explicit approval; they are not part of normal startup.

## Deploy and smoke test

1. Confirm the exact `main` SHA is protected-governance compliant and has a
   successful `Main Certification` status.
2. Confirm Render is deploying that certified `main` SHA.
3. Confirm the build exits successfully and `npm start` remains healthy.
4. Confirm `GET /api/health/ready` returns ready and
   `GET /api/health/db` reports the database ready.
5. Review startup logs for migration, pool, scheduler, and bundle errors.
6. Log in with a non-production test account and verify company selection.
7. Smoke-test one read-only flow in Accounts, Inventory, POS, Factory,
   Containers, and Supplier Partner as applicable to the release.
8. For a release that changes writes, exercise the affected flow with approved
   test data and verify its voucher, ledger, inventory, and audit evidence.
9. Confirm no unexpected 5xx spike, repeated migration loop, or scheduler error
   appears after rollout.
10. Run the explicit Wave 5 production measurement with a non-production
    Admin/Developer test account:

    ```bash
    ERP_PERF_CERT_BASE_URL=https://your-production-host \
    ERP_PERF_CERT_USERNAME=<test-admin-or-developer> \
    ERP_PERF_CERT_PASSWORD=<password> \
    npm run certify:performance-wave5
    ```

    Review `artifacts/performance-wave5/report.json`; do not certify the
    rollout while the command reports qualifying route-budget breaches.

If any step fails, stop the rollout and follow the rollback/recovery runbook.
