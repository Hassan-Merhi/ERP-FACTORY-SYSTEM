# Security + Company Isolation — Wave 3 Closeout

Wave 3 is the final security and tenant-isolation closeout for the current ERP/Factory architecture.

## Company-isolation boundary

The server-owned active company is authoritative. Caller-supplied company IDs are targets to validate, not authorization. The global tenant boundary rejects forged primary-company identity, checks intentional secondary-company references, and applies the same rule to privileged roles.

PostgreSQL provides a second boundary for the highest-risk tenant tables. Migration `0016_company_scope_rls_readiness.sql` enables and **FORCES ROW LEVEL SECURITY** on the protected company tables and scopes `voucher_entries` through their parent voucher. Missing or malformed tenant context fails closed.

Intentional intercompany work must carry an independently authorized company list. Process-owned startup/scheduler maintenance uses the explicit maintenance capability; request handlers do not receive an implicit all-company fallback.

## Privileged maintenance mutations

Legacy mutation routes whose path identifies repair, recalculation, rebuild, cleanup, backfill, reconciliation, resync, or fix work pass through the global privileged-maintenance boundary before their route handler.

- Admin must have the exact `administration.repair` named permission for the active company.
- Developer remains the explicit global support/break-glass role.
- Owner, Manager, POS, Normal User, and View Only do not inherit repair authority from older route-level role lists.
- The boundary adds the shared privileged mutation rate limit.
- Existing signed preview/apply tokens, dry runs, route-owned validation, company ownership checks, and audit behavior remain in force.
- The boundary does not add new request-body fields, so existing repair clients remain compatible.

## Backup and BYPASSRLS

The live backup verification workflow requires `BACKUP_DATABASE_URL` and fails if it is missing. Before `pg_dump`, it verifies that the connected role is a superuser or has `BYPASSRLS`.

The intended backup role is read-only plus `BYPASSRLS`: enough to read all tenant rows for a complete dump, but without application write privileges. The workflow never restores into production; it restores into an isolated PostgreSQL service and compares core-table row-count fingerprints.

Do not use `pg_dump --enable-row-security` and do not disable `FORCE ROW LEVEL SECURITY` to make backups work. Either approach weakens the guarantee or risks a silently partial backup.

## Dependency and secret closeout

The existing Security workflow remains authoritative:

- production dependencies fail on any unreviewed high/critical advisory;
- scheduled/manual deep scans include development dependencies;
- tracked secret-bearing files are rejected;
- verified secrets are blocked across reachable Git history with TruffleHog;
- unknown secret candidates are surfaced for review;
- focused security readiness runs the company-scope audit, tenant regressions, privileged-maintenance policy, and this Wave 3 closeout contract.

No parallel security CI suite is added. `npm run check:security` remains the single focused security entry point.

## Verification

Run:

```bash
npm run check:security
npm run verify:dependency-audit
```

The focused suite includes adversarial cross-company tests across ERP, Factory, POS, mobile, global-maintenance, transaction scope, database scope, and legacy privileged maintenance routes.
