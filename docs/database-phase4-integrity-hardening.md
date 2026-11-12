# Phase 4 — Database constraints and integrity

## Scope delivered on this branch

- Read-only catalog and data-integrity audit: `npm run audit:database-integrity`.
- Aggregate checks for critical foreign keys / check constraints, validation status, and enabled voucher and tenant-scope triggers.
- Data checks for orphan voucher entries, voucher/company mismatch, ledger-account company mismatch, negative or double-sided postings, and unbalanced active nonoptional vouchers.
- Tests for result classification and read-only execution boundary.

The system already has extensive application/database protections in `server/services/accounting/ledgerIntegrityGuard.ts`, `voucherBalanceGuard.ts`, `migrations/0013_tenant_control_integrity_guards.sql`, and `scripts/tenant-control-integrity-audit.mjs`. This phase does **not** deploy duplicate or conflicting triggers. Missing or NOT VALID constraints are surfaced, not blindly replaced.

## Expanded structural coverage and real database test

This phase now adds the separate `npm run audit:database-integrity:catalog` read-only catalog audit. It inventories critical accounting tables, foreign keys, and enabled voucher/stock-adjustment/account-tree triggers; detects missing tenant-control foreign keys and disabled POS/location/company guard triggers on installed tables; and reports enabled/forced RLS policy status. The structural audit checks actual PostgreSQL catalog rows and returns a nonzero exit code when critical guards are absent.

The disposable PostgreSQL migration lifecycle runs the **actual repository SQL** from `migrations/0013_tenant_control_integrity_guards.sql` against a scratch fixture. It verifies:
- cross-company assigned locations and POS cash accounts are rejected;
- a NOT VALID company foreign key rejects new rows referencing nonexistent companies;
- valid in-company assignments are allowed;
- moving a referenced location or ledger account to another company is blocked;
- account ownership is unchanged after each rejected operation.

It does not create or validate a new production constraint, update a posted voucher, or repair any historical row. All tests must pass in GitHub on the exact branch commit.

## Distinction between warnings and blockers

Missing/disabled integrity guards, orphan voucher entries, and new ledger/company attribution defects are blockers. `NOT VALID` legacy constraints are warnings: PostgreSQL already enforces them for new writes, but historical values need reviewed validation. The **gross** voucher imbalance query is informational because the canonical `voucherBalanceGuard.ts` has exemptions for historic vouchers, certain stock-adjustment entries, and currency rounding. Do not count all such rows as a confirmed posting defect without replaying those rules.

The row-level numeric audit requests `SET LOCAL row_security = off` in a read-only transaction. This does **not** bypass RLS for an ordinary role; PostgreSQL rejects a query that would otherwise hide rows. Run only with an appropriately authorized maintenance/audit role and do not interpret partial counts as complete.

## Safe verification procedure

1. On a restored isolated database, run `npm run audit:database-integrity`, `npm run audit:database-integrity:catalog`, and `node scripts/tenant-control-integrity-audit.mjs --json`.
2. Compare their output with `server/services/accounting/integrity` existing diagnostics and the current PostgreSQL catalog; confirm no tenant or financial evidence is skipped by RLS.
3. Identify every `NOT VALID` foreign key and CHECK constraint by table, child/parent key, and exact violations. Existing historical exceptions may be legitimate archival cases; do not delete them just to force validation.
4. After human review, write a *separate*, named forward migration for each approved constraint fix or `VALIDATE CONSTRAINT` operation. Validate with realistic data volume and a short lock timeout.
5. Test old and new write paths, multi-company access, vouchers, FX, rental accruals, dispatch, and POS before a release.
6. Capture prior/post counts and balances. A Phase 4 integrity migration must not change cash, stock, payroll, rent, voucher entries, or posted customer balances unless a separately approved financial correction is included.

## Important audit caveats

- Existing legacy `NOT VALID` constraints are reported as validation debt. They still protect new rows; a warning is not proof of new-write exposure.
- The gross voucher imbalance metric is a review-only warning based on base debit/credit totals with a 0.01 tolerance. The canonical engine contains historical, stock-adjustment, rounding, and posting exemptions. Reconcile with `voucherBalanceGuard.ts` before classifying a row as defective.
- Tenant-maintenance reads require an appropriately scoped privileged database connection. The audit uses `BEGIN READ ONLY`; it does not grant privileges to an ordinary user or bypass row-level security automatically.
- The audits report only aggregate counts and catalog guard status. They do not prove each trigger's function body, constraint column definition, unique index, historical source data or every possible module-level invariant.
- The audit currently checks a priority subset of critical tables; all remaining Factory, Properties, POS, and payroll relationships must be inventoried before claiming comprehensive Phase 4 certification.

## Completion gate

Phase 4 must not be called production-complete until the inventory covers all critical tables, the restored staging audit passes or every accepted legacy exception is recorded, the approved constraints are staged/validated, and regression tests demonstrate cross-company isolation and accounting consistency.

No live production data were modified.

**Operational status:** Source code, the catalog audit, and test fixture are committed. A production-sized restored database audit and historical review remain prerequisites for declaring Phase 4 operationally certified. No production data has been changed.
