# Phase 8 — Automated database migration testing

## Committed implementation

The controlled migration runner is now exercised against a **real disposable PostgreSQL 18 database** in `.github/workflows/database-migration-tests.yml` on relevant pull requests. Node-only contract tests also run in that workflow.

Run (inside the isolated, locally hosted test environment only):

```bash
NODE_ENV=test \
PGSSLMODE=disable \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/erp_phase8_harness \
PHASE8_TEST_CONFIRMATION=RUN_DISPOSABLE_PHASE8_MIGRATION_TESTS \
  npm run test:db:migrations:postgres
```

### Verified-by-design scenarios (to be certified by green workflow evidence)

1. Create a **uniquely named** `phase8_test_*` PostgreSQL database; no existing user database is reused.
2. Create only the minimal legacy table fixture required by the two controlled SQL migrations.
3. Insert two deliberate duplicate FX rate keys in the fixture. Expect migration 001 to commit and migration 002 to fail; verify missing newly-added column demonstrates SQL transaction rollback.
4. Remove the duplicate *only inside the disposable fixture*. Rerun and expect both controlled migrations installed; verify history and required schema/index objects.
5. Rerun: expect no additional history row and the no-op confirmation.
6. Inspect read-only `--status`; expect zero pending.
7. Corrupt a checksum *only in the disposable migration history*. Expect the runner to reject it, then restore the test fixture history.
8. Hold the migration advisory lock in one PostgreSQL client and expect a concurrent runner to exit unsuccessfully with an explicit lock conflict.
9. Close connections and delete the unique disposable database after the exercise.

The test runner refuses a non-loopback PostgreSQL host and requires `NODE_ENV=test` plus a literal test confirmation. It never points the migration runner at the harness database or production.

### GitHub workflow

- `.github/workflows/database-migration-tests.yml`: PostgreSQL 18 service, Node 24, `npm ci`, `npm run test:db:migrations`, and the real PostgreSQL migration lifecycle.
- No Render deploy, production credentials, production database access, or writes to GitHub repository data.
- Run on PRs that change controlled migrations, tests, or relevant tooling; can also be dispatched manually.

### Remaining required certification

- Confirm a green run of this workflow on the **exact Phase 8 commit**, with no skipped database tests.
- Verify the test suite on the target production PostgreSQL major version and a restored staging snapshot with realistic data, tenant RLS, accounting triggers, and legacy migration journal state.
- Confirm clean install, repairable partial upgrades, repeated startups, and concurrent application traffic on staging. The minimal fixture does **not** substitute for a full application bootstrap.
- Confirm backup and restore validity, every historical migration checksum, idempotency, and the full accounting integrity and tenant isolation suite.
- Audit any failure and correct it on the feature branch; never raise a CI failure baseline as a workaround.

No live production SQL has been executed and none is authorized by this test suite.

## Do not overclaim

This phase adds automated integration tests for the *controlled migration runner*. It does not certify every legacy startup DDL bridge, system-wide migrations, or 100/100 database quality. Those require earlier phases' unfinished cutover and production-like staging verification.
