# Permissions V2 — staging migration and data certification

**Status:** tooling ready and rehearsed locally. **Staging certification has NOT been performed.** No staging database, backup location, service role or written approval was available to this change, so the `migration-staging`, `data-integrity` and `rollback-drill` gates in `config/permissions-v2-release-readiness.json` stay blocked.

Never run any of this against production.

## What is certified

| Step | What the tool proves | Evidence file |
|---|---|---|
| Safety | Written approval flag, typed database name, not production, scratch database empty | `result.log`, `context.txt` |
| Backup | `pg_dump` of staging restores into a scratch database and matches staging table by table | `staging-backup.dump`, `.sha256`, `restore.diff` |
| Baseline | Per company: row count and md5 of vouchers, voucher entries, ledger accounts, suppliers, customers, stock, inventory and valuation movements, bales, containers, payroll, bonuses, attendance, rentals, closed periods and every permission table | `baseline.tsv` |
| Migration | Applies `20261024_001` and `20261107_001` | `migration-*.log` |
| Structure | Five `access_*` tables, FORCE row-level security, company-scope policies, override and append-only audit triggers, `policy_mode` audit check | `result.log` |
| Isolation | As the application's service role: no rows without a company scope, only its own company with one (probe rows rolled back) | `result.log` |
| Integrity | After-migration snapshot identical to the baseline | `after.tsv`, `after.diff` |
| Rollback | On the disposable copy: activate and roll back a company policy, audit preserved and undeletable, business data unchanged; then restore the copy from the backup again and match the baseline | `rollback-drill.log`, `drill.diff`, `restored-again.diff` |

Staging keeps the additive migrations applied afterwards. That is the approved target state. No company is activated.

## Procedure (operator)

1. Record written approval for the staging run, naming the operator, the staging database and the time window.
2. Create an **empty** scratch database on the staging server, or on any server with the same PostgreSQL major version.
3. Check out the release commit and install dependencies.
4. Run the isolated migration validation and keep the output:

```bash
npm run verify:permissions-shadow-migration
```

5. Run the certification:

```bash
STAGING_DATABASE_URL='postgresql://…/erp_staging' \
SCRATCH_DATABASE_URL='postgresql://…/erp_staging_scratch' \
PRODUCTION_DATABASE_URL='postgresql://…/erp_production' \
STAGING_APP_ROLE='erp_app' \
PERMISSIONS_STAGING_APPROVED=yes \
CONFIRM_DATABASE_NAME=erp_staging \
CERT_OUT_DIR=./permissions-staging-evidence \
bash scripts/permissions/staging-certification.sh
```

`PRODUCTION_DATABASE_URL` is optional. When set, it is only read to refuse a staging URL that points at the same cluster and database. The tool stops at the first failure and says which evidence file explains it.

6. Deploy the release commit to staging with all three `PERMISSIONS_V2_*` switches unset, then run the application checks:

```bash
DATABASE_URL='postgresql://…/erp_staging_test_copy' npx vitest run tests/access-control-v2-*
```

Use a disposable copy for this step, because the HTTP suites create and remove test companies.

7. Policy rollback drill through the application, as an administrator of a test company on staging:
   - Settings → Users & Permissions → stage one role rule and save it.
   - With `PERMISSIONS_V2_COMPANY_ACTIVATION=enabled` on staging only, activate the test company (`PUT /api/permissions-v2/activation`).
   - With `PERMISSIONS_V2_ENFORCEMENT=enabled`, confirm the rule refuses the matching write.
   - Roll back (`mode: "rolled_back"`) and confirm the write works again with no deploy.
   - Confirm both mode changes appear in the permission change audit.
   - Unset both switches.
8. Attach the evidence directory and the operator's notes to the release record. Then update the `migration-staging`, `data-integrity` and `rollback-drill` gates with the evidence paths, the release commit and the result.

## Relation to `staging-shadow-migration.mjs`

`scripts/permissions/staging-shadow-migration.mjs` (from #3032) is a lighter runner meant for the staging service's Render shell. It refuses production, snapshots ten business tables, rehearses the shadow migration in a rolled-back transaction, applies it and verifies the result. It does not take or verify a backup, does not apply `20261107_001`, and does not check isolation as the service role. If you use it, still take and verify the backup first, then apply `migrations/20261107_001_permissions_v2_policy_mode_audit.sql`, and record that the backup, follow-up migration and service-role checks were done separately.

## If something fails

- **Migration error:** the migration runs in one transaction and leaves nothing behind (verified locally). Fix the cause and re-run; the migrations are idempotent.
- **Any snapshot difference:** stop. Do not continue the rollout. Restore staging from the verified backup if anything other than the five `access_*` tables changed, and open an incident review.
- **Never** drop `access_*` tables, delete audit rows, or post or reverse vouchers to make numbers match.

## Local rehearsal (not staging evidence)

The tool was rehearsed on 2026-11-07 against a throwaway copy of the local test database on PostgreSQL 16 with `CERT_MODE=rehearsal`, which marks every evidence file as a rehearsal. Every step passed, including service-role isolation with a non-superuser role, the rollback drill and both restore checks. The refusal paths for a missing approval and a wrong typed database name were also exercised. This proves the tool works; it does not certify staging.
