# Phase 4 — Database constraints and integrity

## Scope delivered on this branch

- Read-only catalog and data-integrity audit: `npm run audit:database-integrity`.
- Aggregate checks for critical foreign keys / check constraints, validation status, and enabled voucher and tenant-scope triggers.
- Data checks for orphan voucher entries, voucher/company mismatch, ledger-account company mismatch, negative or double-sided postings, and unbalanced active nonoptional vouchers.
- Tests for result classification and read-only execution boundary.

The system already has extensive application/database protections in `server/services/accounting/ledgerIntegrityGuard.ts`, `voucherBalanceGuard.ts`, `migrations/0013_tenant_control_integrity_guards.sql`, and `scripts/tenant-control-integrity-audit.mjs`. This phase does **not** deploy duplicate or conflicting triggers. Missing or NOT VALID constraints are surfaced, not blindly replaced.

## Safe verification procedure

1. On a restored isolated database, run `npm run audit:database-integrity` and `node scripts/tenant-control-integrity-audit.mjs --json`.
2. Compare their output with `server/services/accounting/integrity` existing diagnostics and the current PostgreSQL catalog; confirm no tenant or financial evidence is skipped by RLS.
3. Identify every `NOT VALID` foreign key and CHECK constraint by table, child/parent key, and exact violations. Existing historical exceptions may be legitimate archival cases; do not delete them just to force validation.
4. After human review, write a *separate*, named forward migration for each approved constraint fix or `VALIDATE CONSTRAINT` operation. Validate with realistic data volume and a short lock timeout.
5. Test old and new write paths, multi-company access, vouchers, FX, rental accruals, dispatch, and POS before a release.
6. Capture prior/post counts and balances. A Phase 4 integrity migration must not change cash, stock, payroll, rent, voucher entries, or posted customer balances unless a separately approved financial correction is included.

## Important audit caveats

- Existing legacy `NOT VALID` constraints are reported as validation debt. They still protect new rows; a warning is not proof of new-write exposure.
- The voucher imbalance metric uses base debit/credit totals with a 0.01 tolerance. The existing accounting engine has additional intentional historical and stock-adjustment exemptions. Review any flagged voucher using `voucherBalanceGuard.ts` before classifying it as an accounting defect.
- Tenant-maintenance reads require an appropriately scoped privileged database connection. The audit uses `BEGIN READ ONLY`; it does not grant privileges to an ordinary user or bypass row-level security automatically.
- This audit reports only aggregate counts and the existence of guards. It does not prove every constraint or trigger has the correct function definition.
- The audit currently checks a priority subset of critical tables; all remaining Factory, Properties, POS, and payroll relationships must be inventoried before claiming comprehensive Phase 4 certification.

## Completion gate

Phase 4 must not be called production-complete until the inventory covers all critical tables, the restored staging audit passes or every accepted legacy exception is recorded, the approved constraints are staged/validated, and regression tests demonstrate cross-company isolation and accounting consistency.

No live production data were modified.
