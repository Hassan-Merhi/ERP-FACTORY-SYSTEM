# Phase 3 — Startup-schema conversion (in progress)

## Scope and strict order

The legacy `server/startup-schema/index.ts` exports **43 ordered SQL statement modules** (44 files including its registry). The array order, not lexical filenames, is authoritative; specifically `005-tenant-and-performance-indexes` precedes `005-orphan-fk-repairs`. The original startup statements include one-time updates, archiving/deletions of orphan rows, and schema changes. These must not be replayed unreviewed against existing production data.

## Implemented in this phase

- `scripts/extract-startup-schema-migrations.ts`: a deterministic **offline**, checksum-reporting extractor. It loads each actual TypeScript module through the project's `tsx` dev dependency, preserves the exact assembled order, writes 43 individually numbered `NNN_original-module.sql` **review candidates**, and records exact statement counts, content hashes, the original assembled-array hash and conservative lists of statements requiring manual DML/destructive DDL review.
- `tests/startup-schema-extraction.test.ts`: integration-oriented test for the 43 extracted modules, original ordering, the sensitive orphan-FK repair, extraction parity with the existing live array, and refusal to write directly into the controlled migration directory.
- The extractor refuses unexpected registry structure, non-string arrays, empty statements, transaction control or concurrent indexes, and checks output against the assembled `startupMigrations` array byte-for-byte.

Run from a checked-out repository with dependencies installed:

```bash
npx tsx scripts/extract-startup-schema-migrations.ts --out /tmp/erp-startup-review-sql
npx vitest run tests/startup-schema-extraction.test.ts
```

The output is **not automatically loaded by the controlled migration runner**, and the script never connects to a database.

## Critical blockers before Phase 3 can be marked complete

1. Actually execute the extractor and verify/commit all **43 reviewed versioned SQL migrations**, with safe classification of schema changes versus data repairs. The test is committed but has **not run** in this chat execution environment.
2. Since the source is a historical **repair-oriented** array, many commands can conflict with fresh snapshot-based baseline SQL; define explicit precedence and migration history so that no existing database receives duplicate or unwanted repair DML.
3. Existing HMD and Factory databases have materially different schema versions (23 HMD-only vs 30 Factory-only tables). Check each reviewed SQL migration against both baselines using disposable PostgreSQL 18 test databases. Historical backup and orphan-archive objects require explicit preservation policy.
4. Test the runner's exact checksums, dependency order, transactional rollback, existing-environment adoption, and catalog fingerprint parity. This is blocked by Phase 2's incomplete live PostgreSQL rehearsal.
5. Only then replace `runStartupMigrations(startupMigrations)` with a verify-only boot path and remove redundant legacy writers/imports. **The server startup array and the 43 source modules remain untouched until tested.** Additional boot schema writers and `*Bridge.mjs` belong to later phases.

**Safety:** No production writes or deployment, no controlled migration registration, no startup behavior changes and no deletions. This phase is **not done** simply because the extraction tool and tests were authored. Keep PR draft.
