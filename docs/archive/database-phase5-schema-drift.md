# Phase 5 — Schema drift detection and reference certification

## Implemented

- `npm run db:drift`: read-only critical runtime schema and SHA-256 controlled migration-history audit.
- `npm run db:drift:strict`: opt-in verified-controlled-schema cutover gate. Confirms the seven controlled migrations are recorded, history checksums match, and the reviewed critical table/column/index/constraint/trigger definitions are installed.
- **Definition checks:** compare PostgreSQL column types, nullability, critical defaults, index uniqueness/key order and expression, constraint kinds/predicates, trigger behavior signatures, and scan-timestamp functions. A correct object name with the wrong underlying definition fails.
- **Tenant RLS:** require enabled and forced RLS on the nine company-scoped core tables, with the expected company-scope ALL policy, both USING and WITH CHECK predicates, and public role coverage. Incorrect/missing policies fail the strict gate.
- **Reference-based full-catalog comparison:** use `npm run db:drift:fingerprint` to obtain a metadata-only SHA-256 fingerprint from a *trusted reviewed reference database*, and compare against the target with `--full-reference=...`. The comparison fails on missing, changed, and unexpected catalog objects.
- Public-schema metadata coverage includes tables, relation kinds, view/materialized-view definitions, sequence configurations (not current values), columns, indexes, constraints, triggers, functions including overloaded signatures, and RLS policies.
- **No data-level changes:** All audit connections use `BEGIN READ ONLY`. No index, trigger, policy, function, schema or historical record is created, repaired or deleted by these commands.
- Unit tests include name-collision protection, index expression mismatch, wrong data type/default, wrong RLS policy, missing objects, changed functions, unexpected objects, and invalid reference files. The PostgreSQL disposable integration suite also checks that a real added view changes the fingerprint.

## Recommended staging procedure

1. Restore a recent production-sized backup into an isolated, nonproduction PostgreSQL environment with the same PostgreSQL major version, extensions and ownership as production; independently validate the source of that restore.
2. Complete Phase 3's remaining legacy startup-DDL cutover and resolve overlapping migration histories. Run the reviewed controlled migrations **only on isolated staging**, then apply the release's startup verify-only flags.
3. With no application background writers, capture an **approved reference baseline** (review and sign off the reference DB; do not trust one created from the suspect target):

   ```bash
   npm run db:drift:fingerprint > /secure/reviewed-reference-fingerprint.json
   ```

4. Against the target/staging copy, run:

   ```bash
   npm run db:drift
   npm run db:drift:strict
   node scripts/audit-database-schema-drift.mjs --require-controlled --full-reference=/secure/reviewed-reference-fingerprint.json
   ```

5. Review *every* changed/missing/unexpected object; confirm expected migrations and record signed, time-limited waivers for justified legacy objects. Never auto-drop unexpected indexes or auto-validate NOT VALID constraints.
6. Repeat the read-only fingerprint after two restarts, validate tenant isolation, inventory and financial totals, then run Phase 9's evidence gate. A passing format-only gate is not production authorization.

## Important limitations

The built-in definition contracts represent a **reviewed critical and controlled-schema subset**, not the full dynamically assembled ERP/Factory/Properties/POS/payroll schema. Full-catalog comparisons require a **separately approved baseline file**; the application cannot safely invent that authority. Function/source formatting, PostgreSQL versions, extensions, role names, and intentional environment differences may change catalog metadata. Reference comparisons should use matching PostgreSQL major versions and an owner-approved waiver process.

The fingerprint is metadata-only and does not compare business rows, prices, rent, GL, dispatch, payroll, inventory balances, or data inside tables. It does not yet include extensions, roles, privileges, schemas beyond public, partition bounds, operator classes, or all dependent database objects. Row-level security **behavior** still requires tenant integration testing, not only policy metadata.

Legacy Drizzle and ad hoc startup migration ledgers are not reconciled by this tool. The new controlled history is independently verified, but Phase 3 is unfinished. Automated reference acquisition from the production DB is intentionally **not** enabled.

## Completion classification

**Implemented in code:** object-presence and definition drift checks, tenant RLS contract checks, full-catalog fingerprint comparison, migration history integrity checks, and disposable PostgreSQL tests.

**Still required for Phase 5 production certification:** a trusted approved reference database and baseline, full legacy migration-history reconciliation, real production-sized isolated restore, staged controlled cutover, two restart equivalence checks, and independent accounting/tenant/Factory approval. Do not merge or deploy as 'fully certified' until these conditions are met.

No production SQL or financial data were changed by this phase.
