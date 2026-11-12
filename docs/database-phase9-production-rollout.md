# Phase 9 — Production rollout and certification gate

## Implementation

Phase 9 adds a **read-only, fail-closed release evidence gate**, not automatic migration or deployment.

- `scripts/database-phase9-release-core.mjs`: pure validator of evidence freshness, exact SHA and required checks.
- `scripts/verify-database-phase9-release.mjs`: read-only CLI; exits nonzero when prerequisites are missing.
- `tests/database-phase9-release.node.test.mjs`: unit tests for missing/stale/wrong-commit evidence and release blockers.
- `.github/workflows/database-migration-tests.yml`: proves missing evidence blocks approval in CI.
- `npm run db:release:preflight -- --commit=<40-char-sha> --evidence=/private/release-evidence.json`: inspect private release evidence; does not deploy.

## Twelve required exact-commit checks

1. Controlled-migration integration tests.
2. Full database schema drift audit (current critical subset is insufficient).
3. Accounting integrity, journal balance and historical exception validation.
4. Tenant isolation, RLS and permission verification.
5. All legacy and new migration histories reconciled, with no replay risk.
6. Startup schema changes and historical repair writes removed from normal boot, replaced by verification.
7. Staging migration rehearsal with representative historical data.
8. Full isolated production-sized restore, RLS-compatible backup and consistency evidence.
9. ERP/Factory/Properties financial parity, cash, rents, balances and ledgers.
10. Factory inventory, bales, scanned dispatch history and stock parity.
11. Authentication, readiness and business smoke checks.
12. Application rollback and recovery rehearsal.

Every check needs passed=true, a recent HTTPS evidence URL, timestamp and the target commit SHA.
Backup must show SHA-256, size, fresh creation timestamp, isolated restore evidence URL and measured RPO/RTO within approved limits.
Database, accounting and release owners must provide documented approvals after evidence issuance.
Safety declarations require no automatic production migrations, no accounting data rewrites, a retained previous healthy deployment and disabled external staging schedulers.

## Release sequence

1. Complete unfinished Phase 3 startup-DDL extraction and Phase 4/5 broad verification.
2. Freeze exact release SHA and obtain a recent backup. Confirm RLS-safe completeness and perform a real isolated restore.
3. Apply approved migrations to **staging only**. Check schema, company boundaries, accounting totals, Factory inventory and historical correctness.
4. Measure backup/restore time, available recovery point, RPO and RTO. Record links to actual job results.
5. Obtain independent documented business, accounting and database approvals.
6. Run the Phase 9 read-only release preflight with a private evidence file. Treat any missing/failing item as a hard block.
7. With separate owner authorization and a staffed release window, run approved migrations manually, monitor readiness and preserve rollback option.
8. Validate post-deployment reports. Stop on unexpected balances, cross-tenant visibility, missing objects, or rollout errors.

## Evidence security and caveats

Store private evidence outside the repository; never commit credentials, production dumps or customer-level financial data.
The preflight validates the **supplied report**; it cannot verify that links are genuine, an owner approved, a backup exists, or that SQL has actually run. Human verification remains mandatory.
Passing the preflight is necessary, not a grant of production write authorization.

## Current blockers

- Legacy startup-DDL cutover is incomplete and still runs repair paths.
- Phase 4/5 checks cover priority objects, not the entire data model.
- Legacy migration histories have not been reconciled for the new controlled runner.
- A real production-sized restored staging test, backup evidence and measured recovery results have not been verified in this session.
- Render workspace has not been selected in this connection; no target service is authorized for deploy.

Phase 9 is **code-complete as an evidence gate**, but production rollout and full 100/100 certification are not achieved.
No SQL was applied to production, no financial records were changed, and nothing was merged or deployed.
