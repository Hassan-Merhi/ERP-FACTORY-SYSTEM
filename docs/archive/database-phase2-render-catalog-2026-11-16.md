# Phase 2 — Render read-only catalog comparison, 2026-11-16

**Scope:** Confirmed Render workspace `My Workspace` (`tea-d42ik0c9c44c73878jsg`). PostgreSQL 18. No production SQL writes, DDL, data rows, or credentials exported.

## Confirmed service mapping

| Service | Database | Render PostgreSQL ID | Version | Important note |
|---|---|---|---|---|
| `HMD SYSTEM` (same ERP repo, main branch) | `erp_db_qscj_64lv_e7rz_8744_2lm3` | `dpg-d75mfh0ule4c73ctksfg-a` | 18.3 | Older instance, **newer dispatch/returns/ticket tables** |
| `ERP-FACTORY-SYSTEM` (feature/intercompany-container-trading branch) | `erp_db_qscj_64lv_e7rz_8744_2lm3_dczj` | `dpg-dbhg2l08v5cc738d6iv0-a` | 18.6 | Separate environment and database, **intercompany tables and orphan archives** |

Service-to-database mapping is based on matching Render environment IDs from the service and database listings, not name guessing. The environments are different deployments of the same repository, **not** interchangeable evidence of a single universal schema.

## Read-only metadata results

| Catalog group | HMD SYSTEM count | HMD fingerprint | ERP-FACTORY count | ERP-FACTORY fingerprint |
|---|---:|---|---:|---|
| Tables | 459 | `913a268dd1fd8b3f8947baa790cb1087` | 466 | `789da1a9ccdba91121747aabdb3e7067` |
| Columns (pg_attribute) | 5,424 | `9229766da431eb21b97b4d29a3f23df1` | 5,467 | `c295d352fcfac0f1109e2e74d4241e2c` |
| Indexes | 1,289 | `30f064a84c85d362d41834ca113e4307` | 1,332 | `9a6212cf8866be1da75b1413ce999e58` |
| Constraints | 5,012 | `4739d6069cd0d2aec051b3de6f550d65` | 5,119 | `d42c360176c0823d9b0c4df3bce35741` |
| Triggers (non-internal) | 158 | `fd938216f31ba17cc70a7fa35b76b395` | 179 | `0cfe5d1aa4dd338137bec598bd1aec23` |
| Functions | 97 | `1e77606658ab472a0e894b77ef0e18d8` | 123 | `8ea5cbef11ed87242a80c49223cd0c5e` |
| RLS policies | 46 | `7db5c73ccb29d1a49ffd0ad5be90b2a3` | 38 | `49dbfd7102f82293899085676db130b1` |

Additional counts: HMD has 5,478 information_schema-visible columns and 45 RLS enabled + forced tables; ERP-FACTORY has 5,521 visible columns and 37 RLS enabled + forced tables. Both have `pg_stat_statements` and `plpgsql` extensions. Both contain a separate non-public `currency_fix_backup_20260722_all_erp_usd` schema that a full baseline capture must review. **Neither** contains `public.erp_controlled_migration_history` nor `public.__drizzle_migrations`.

The fingerprints are MD5 catalog difference identifiers, NOT cryptographic proof of snapshot provenance or a substitute for full SQL definitions. Run `scripts/sql/read-only-schema-catalog-fingerprint.sql` for repeatable results. These queries intentionally excluded rows and financial values.

## Divergence: exactly compared names

- HMD has **23 tables absent from ERP-FACTORY**, including `erp_supplier_return_allocation_rows`, `erp_supplier_return_batches`, `erp_supplier_return_lines`, dispatch trip financial tables, `factory_finalized_sale_returns`, and ticket management tables.
- ERP-FACTORY has **30 tables absent from HMD**, including eight `_orphan_archive_*` tables, `intercompany_trades`, `intercompany_trade_revisions`, `intercompany_trade_cancellations`, `intercompany_shared_charge_invoices`, and `one_time_migrations`.
- HMD vs ERP-FACTORY: **310 vs 353** distinct information_schema column signatures, **74 vs 117** distinct index names, **8 vs 0** distinct RLS policies, **28 vs 49** distinct trigger identities.
- Since the common schema may also differ in definitions, simply unioning table names is *not* a sound migration baseline.

## Phase 2 deliverables and outstanding verification

**Completed:** Actual remote read-only catalog inspection of both service-bound databases; comparative object metadata and reproducible per-group fingerprints; documented environment mapping; verified that the existing controlled history is not present in either inspected database.

**NOT completed:** a complete authoritative `pg_dump --schema-only`, its security/privilege review, complete numbered baseline SQL, dependency-ordered fresh install, real empty PostgreSQL installation, and tested upgrade of a restored existing database.

Why: The Render connection available here only offers **read-only SQL queries**; it cannot run `pg_dump`, stream or safely restore a complete database image, or execute isolated migrations. The local execution environment has no PostgreSQL server / `pg_dump` and cannot clone this private GitHub repository over the network. A catalog fingerprint is **not** a full executable schema snapshot. The repository explicitly warns the legacy boot schema is missing original core CREATE TABLE statements. Fabricating numbered SQL to satisfy file counts would create unproven financial and tenant risk.

**Required next action:** Export authoritative schema-only dumps *of both databases* using an authorized environment with `pg_dump`; use a separately restored, disposable staging database for the compatibility test. Do not use a live database as the test target. Compare full schema definitions, privileges, extensions, triggers, RLS and historical migration ledgers, decide how to preserve deployment-specific tables, and only then commit the immutable numbered baseline and migration/adoption tests. Do not activate global verify-only or remove startup writers until those tests pass.

No deploy or main merge is approved from this evidence.
