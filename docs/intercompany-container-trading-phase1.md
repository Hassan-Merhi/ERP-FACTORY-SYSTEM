# Intercompany Container Trading — Phase 1 foundation

Branch: feature/intercompany-container-trading  
Status: Phase 1 foundation only. **No trading feature, posting route, UI, scheduler or repair is enabled.**

## Scope and invariants

- Preserve the existing unique physical container number. Intercompany companies must reference one canonical container through intercompany_trades, not create duplicate physical stock.
- Each confirmed container trade belongs to one verified source/destination pair and has linked POs. At most one trade may be active for a container.
- Each source Excel file SHA-256 is unique per source company; each batch/container combination is unique. Confirmation of multiple containers will be atomic in Phase 2.
- All new relationship switches default to OFF. Historical repair additionally requires a verified baseline, named activator, activation timestamp, and configured positive per-item and daily limits.
- The dedicated Shared Charge Editor grant is scoped to an affected relationship and (by default) a specific invoice key. The grantor must be an Owner or Developer in that relationship's participating company. Grants cannot be deleted; revocations identify the revoking Owner or Developer.
- Audit events cannot be modified or deleted. Repair requests start held and may only be marked posted when approval and voucher metadata are present. These are data constraints, not an implemented repair engine.
- Existing vouchers, purchase orders, suppliers, cash, inventories and financial reports are untouched by the additive migration.

## Phase 1 deliverables

1. Drizzle declarations in shared/schema/intercompanyTrading.ts, exported from shared/schema/index.ts.
2. Registered migration migrations/20261105_001_intercompany_phase1_foundation.sql with new tables, foreign keys, indexes, default-disabled activation flags, validation triggers and immutable audits.
3. Focused PostgreSQL regression test tests/intercompany-phase1-foundation.test.ts. It runs the real SQL in an isolated temporary schema in a transaction and rolls back all fixtures.

## Restrictions during subsequent phases

- Do not re-use the old per-company importer for two-company transactions: its existing container-number checks and multi-step writes are not an atomic cross-company import operation.
- Do not enable intercompany trading until Phase 2 has verified posting mappings and the import transaction service can commit both PO sides together.
- Do not enable historical repairs until Phase 7 has implemented evidence checks, open-period posting, daily-cap reservations, approval audit and idempotent execution.
- Do not infer relationships or party accounts from names. All mappings must use verified IDs and company-scoped checks.
- Do not grant invoice access solely by possessing an invoice ID. Phase 6 must verify that the invoice belongs to the granted relationship and all affected containers.
- Do not interpret schema-level authorization as complete request security. Phase 6 must enforce roles on every API read and write and invalidate permissions promptly.
- Do not run the additive migration against production merely to test Phase 1. Use an isolated DB and an audited rollout later.

## Release gates

- Migration registry validation, TypeScript checks, backend regression, formatting, lint, and migration startup checks.
- An isolated PostgreSQL proof of default-off policies, wrong-company account rejection, canonical container uniqueness, grant authorization, immutable audit and held repairs.
- No branch merge or deployment until user authorizes it.
