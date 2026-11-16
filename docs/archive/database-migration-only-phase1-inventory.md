# Migration-only schema truth — Phase 1 inventory and cutover blockers

Date: 2026-11-16  
Branch: `refactor/migrations-only-schema-truth`  
Status: **Phase 1 inventory completed against main at ad68fee72bb2bcac5354e8d96f341cf2a892e642; Phase 2–6 not implemented.**  
This is a **source inventory, not production database certification**. No production SQL was executed and no app bootstrap was changed.

## Confirmed scope

The Git tree contains **44** files in `server/startup-schema/`: **43** ordered statement modules plus `index.ts`. There are **15** `server/*Bridge.mjs` files. The tree also contains **75** top-level `migrations/*.sql` files; the separate controlled migration directory has its own runner. Deleting 59 files by filename alone would remove necessary non-schema runtime features.

### The 43 ordered startup-schema modules

The exact execution order is defined by `server/startup-schema/index.ts`, **not lexical order**: the two `005` modules have a deliberate ordering. Every module listed here participates in the concatenated boot-time DDL array:

| Execution group | Files (under `server/startup-schema/`) | Area |
|---|---|---|
| Core foundation | `001-core-tables-and-columns.ts`, `002-factory-container-columns.ts`, `003-rental-and-production-planner.ts`, `004-post-deploy-tables.ts` | Initial legacy additions, factory, rentals, production |
| Keys and indexes | `005-tenant-and-performance-indexes.ts`, `005-orphan-fk-repairs.ts`, `006-primary-and-foreign-keys.ts` | Indexes, orphan reference handling, FK/PK integrity |
| Operational additions | `007-schema-catchup-may-2026.ts`, `008-pos-exports-and-dispatch.ts`, `009-supplier-partner-and-ai.ts`, `010-security-notifications-and-precision.ts`, `011-stock-transfer-revision-integrity.ts` | POS, dispatch, supplier, audit, security |
| Factory production | `012-production-positions.ts`, `013-bale-production-attribution.ts`, `014-production-position-planner.ts`, `015-production-bonus-payroll.ts` | Position and bonus data |
| WhatsApp and inventory | `016-location-whatsapp-stock-reports.ts`, `017-location-whatsapp-stock-schedules.ts`, `018-location-whatsapp-delivery-history.ts`, `019-stock-merge-audit-user-id.ts`, `020-v3-load-user-id.ts`, `021-canonical-stock-movement-journal.ts`, `022-tenant-control-integrity-repairs.ts`, `023-financial-operation-requests.ts`, `024-stock-item-schema-catchup.ts` | Schedules, stock journal, request integrity |
| Late schema changes | `025-insurance-monthly-amounts.ts`, `026-po-import-parent-company.ts`, `027-factory-staff-tracking.ts`, `028-supplier-tracking-defaults.ts`, `029-user-presence-compliance-indexes.ts`, `030-scheduled-whatsapp-delivery-tracking.ts`, `031-inventory-valuation-overrides.ts`, `032-historical-replay-safety.ts`, `033-sp-container-invoice-charges.ts`, `034-supplier-tracking-shop-duty-defaults.ts`, `035-pos-port-departure-date.ts`, `036-zambia-historical-purchase-cost.ts` | Tracking, accounting, inventory valuation, FX |
| Newest batches | `037-factory-pressing-machine-tracking.ts`, `038-factory-pressing-history-report.ts`, `039-stock-transfer-order-wa-approval.ts`, `040-stock-transfer-order-wa-webhook.ts`, `041-stock-transfer-order-wa-delivery.ts`, `042-stock-transfer-order-wa-reconciliation.ts` | Pressing and stock-transfer approval |

**Critical:** Several services import individual startup-schema modules instead of importing only `index.ts`. Those must be redirected before any deletion.

### All 15 bridge files — preliminary source classification

| Bridge | Classification | Phase 2–4 disposition |
|---|---|---|
| `apiPaginationBridge.mjs` | Runtime behavior, not DDL | **Retain** pagination behavior; do not delete merely to meet filename count |
| `companyScopeRlsBridge.mjs` | Schema/RLS migration and checks; conditional data repair | Move mutation to versioned SQL; preserve read-only tenant verification |
| `criticalSecuritySchemaBridge.mjs` | DDL and data cleanup/seed | Separate schema and reviewed data migration; verify security catalog |
| `customerOrderBaleScanAuditBridge.mjs` | Audit DDL, function and trigger | Migrate in execution order; preserve enforcement |
| `exportBufferBridge.mjs` | Runtime large-export behavior, not DDL | **Retain** export functionality |
| `factoryBilingualSchemaBridge.mjs` | Column and index DDL | Move to numbered migration |
| `factoryContainerSchemaBridge.mjs` | Factory column DDL plus UPDATE backfill | Move reviewed DDL/backfill; preserve values |
| `factoryTrilingualSchemaBridge.mjs` | Runs existing versioned SQL plus additional ALTER | Register and port missing ALTER, then retain verifier |
| `fixedProductionPlannerSchemaBridge.mjs` | Runs existing versioned SQL | Route through controlled runner; retain read-only verification |
| `fxFetchTimeoutBridge.mjs` | Runtime external-fetch timeout, not DDL | **Retain** external timeout behavior |
| `inventoryValuationWave6RepairBridge.mjs` | Conditional inventory data repair | **Not ordinary schema DDL**; migrate to explicit, audited data-repair path, not automatic boot |
| `scheduledAttachmentBridge.mjs` | Runtime attachment handling, not DDL | **Retain** attachment behavior |
| `stockItemSchemaRepairBridge.mjs` | Stock-item column DDL | Move to numbered migration |
| `supplierCompanyScopeBridge.mjs` | Executes existing supplier-company SQL | Register as controlled migration; preserve checks |
| `wave3SalesHotpathIndexBridge.mjs` | Conditional CREATE/DROP INDEX | Move index modifications to numbered migration; preserve performance |

Four bridges do not appear to be database schema writers; deleting their **functionality** is explicitly out of scope. If the desired end state is literally zero `*Bridge.mjs` files, rename/refactor these four into normal runtime modules while preserving exact behavior and test coverage.

## Confirmed extra schema writers beyond 59 requested files

- `server/index.ts` imports `startupMigrations`, invokes `runStartupMigrations`, and invokes `ensureRuntimeSchema(pool)`; `RUN_STARTUP_MIGRATIONS=false` does **not** make all startup schema work read-only.
- `server/startup/ensureRuntimeSchema.ts` contains additional Retail and rental CREATE/ALTER paths; it cannot stay as a boot-time mutator.
- `server/startupPreload.mjs` imports DDL bridges via `server/schemaPreload.mjs` and rejects global verify-only mode until the conversion is done.
- Individual direct imports found in `server/startup/ensureZambiaHistoricalPurchaseCost.ts`, `server/startup/ensureSupplierTrackingShopDutyDefaults.ts`, `server/startup/ensureStockTransferOrderWhatsAppApprovalSchema.ts`, and `server/services/inventory/ensureCanonicalStockMovementJournal.ts`. A wider source reference scan is required before removal.
- Additional possible startup/service writers include `server/startup/ensureFactoryLoadingDispatchSchema.ts`, `server/startup/ensureFactoryTargetBonusPaymentSchema.ts`, and service-local `ensure*Schema.ts` methods in accounting, inventory, rental, factory and retail. Classify **call sites**, not just names.
- `server/companyScopeRlsBridge.mjs` conditionally imports `inventoryValuationWave6RepairBridge.mjs`, so indirect load paths matter.

## Migration registration and baseline blockers

1. The existing `scripts/run-controlled-migrations.mjs` executes SQL from **`migrations/controlled/` only**, not all `migrations/*.sql`. The top-level migration journal (`migrations/meta/_journal.json`) and the controlled runner are separate histories; do not assume a top-level file will be applied automatically.
2. Controlled migrations are checksum-verified, sorted, transaction-wrapped, serialized by a PostgreSQL advisory lock and tracked in `erp_controlled_migration_history`. The runner currently rejects unknown applied migrations and non-prefix histories; baseline/adoption of existing production installations needs a carefully planned compatibility path.
3. Historical journal tags `0000_conscious_william_stryker`, `0001_parallel_guardian`, `0002_married_loa` have no committed SQL. **Do not fabricate those historical files or rewrite applied journal history.**
4. `docs/fresh-db-bootstrap.md` confirms that the boot array cannot create original core tables including `companies`, `vouchers`, `users`. A verified clean-install baseline is mandatory.
5. Prior documentation warns that `drizzle-kit push` can drift/destroy production tables. Never substitute it for numbered migrations against a persistent installation.
6. The production catalog must be compared using a sanitized, read-only schema snapshot to catch extensions, RLS, triggers, views, indexes and defaults absent from source code. That evidence is **not yet available**.

## Phase 1 acceptance, evidence, and handoff

- [x] Confirmed both requested file-set counts against the repository Git tree.
- [x] Classified each bridge as runtime, schema, or data repair and identified non-deletable runtime functionality.
- [x] Recorded all 43 ordered startup modules and the **non-lexical** duplicate-005 ordering.
- [x] Identified server boot/preload paths and additional schema writers outside the 59 files.
- [x] Examined the controlled runner, separate journal and documented clean-database failure.
- [x] Identified essential production safety constraints.
- [ ] **Phase 2 prerequisite**: obtain approved, sanitized production schema metadata and a restored staging snapshot for authoritative equivalence testing.

**No deletions, migration executions, financial changes or production deployment have been performed.** Phase 2 must convert and test in incremental, reviewable batches; an empty database and read-only startup are the final exit gates, not assumptions.
