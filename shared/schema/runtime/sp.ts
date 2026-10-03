/**
 * SP permissions, audit, cutover and migration bookkeeping (server/services/sp*).
 *
 * These tables are created by runtime DDL (CREATE TABLE IF NOT EXISTS in the
 * startup migrations and ensure* services). They are declared here so
 * drizzle-kit and the type system see the real schema; the definitions match
 * production column for column and the runtime DDL constraint for constraint
 * (tests/runtime-declared-tables-ddl.test.ts).
 */
import {
  pgTable,
  check,
  bigserial,
  serial,
  text,
  timestamp,
  integer,
  varchar,
  numeric,
  jsonb,
  index,
  foreignKey,
  unique,
  bigint,
  boolean,
  uniqueIndex,
  date,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const spPermissionGrants = pgTable(
  "sp_permission_grants",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    userId: text("user_id").notNull(),
    permission: varchar({ length: 64 }).notNull(),
    enabled: boolean().default(true).notNull(),
    grantedBy: text("granted_by"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("sp_permission_grants_company_id_user_id_permission_key").on(
      table.companyId,
      table.userId,
      table.permission
    ),
  ]
);

export const spAuditEvents = pgTable(
  "sp_audit_events",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    userId: text("user_id"),
    username: text(),
    role: varchar({ length: 64 }),
    permission: varchar({ length: 64 }).notNull(),
    action: varchar({ length: 120 }).notNull(),
    method: varchar({ length: 12 }).notNull(),
    path: text().notNull(),
    entityId: text("entity_id"),
    reason: text(),
    confirmation: text(),
    idempotencyKey: text("idempotency_key"),
    statusCode: integer("status_code"),
    requestBody: jsonb("request_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("sp_audit_events_company_created_idx").using("btree", table.companyId, table.createdAt.desc().nullsFirst()),
  ]
);

export const spIdempotencyKeys = pgTable(
  "sp_idempotency_keys",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    userId: text("user_id").notNull(),
    permission: varchar({ length: 64 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    method: varchar({ length: 12 }).notNull(),
    path: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("sp_idempotency_keys_company_id_user_id_permission_idempoten_key").on(
      table.companyId,
      table.userId,
      table.permission,
      table.idempotencyKey
    ),
  ]
);

export const spProductionEvidence = pgTable(
  "sp_production_evidence",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    cutoverId: bigint("cutover_id", { mode: "number" }).notNull(),
    evidenceType: varchar("evidence_type", { length: 80 }).notNull(),
    status: varchar({ length: 16 }).notNull(),
    detail: jsonb().default({}).notNull(),
    recordedBy: text("recorded_by"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("sp_production_evidence_cutover_idx").using("btree", table.companyId, table.cutoverId, table.evidenceType),
    unique("sp_production_evidence_company_id_cutover_id_evidence_type_key").on(
      table.companyId,
      table.cutoverId,
      table.evidenceType
    ),
    check("sp_production_evidence_status_check", sql`status IN ('PASS', 'FAIL', 'RECORDED')`),
  ]
);

export const spCompletionRecords = pgTable(
  "sp_completion_records",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    cutoverId: bigint("cutover_id", { mode: "number" }).notNull(),
    status: varchar({ length: 16 }).default("CLOSED").notNull(),
    completionSnapshot: jsonb("completion_snapshot").notNull(),
    reason: text().notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("sp_completion_records_company_idx").using("btree", table.companyId, table.approvedAt.desc().nullsFirst()),
    unique("sp_completion_records_company_id_cutover_id_key").on(table.companyId, table.cutoverId),
    check("sp_completion_records_status_check", sql`(status)::text = 'CLOSED'::text`),
  ]
);

export const spOffloadReversals = pgTable(
  "sp_offload_reversals",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id").notNull(),
    offloadId: integer("offload_id").notNull(),
    reversalDate: date("reversal_date").notNull(),
    reason: text().notNull(),
    reversedBy: text("reversed_by"),
    voucherIdsOriginal: jsonb("voucher_ids_original").default([]).notNull(),
    voucherIdsReversal: jsonb("voucher_ids_reversal").default([]).notNull(),
    snapshot: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("sp_offload_reversals_company_container_idx").using("btree", table.companyId, table.containerId),
    unique("sp_offload_reversals_offload_unique").on(table.offloadId),
  ]
);

export const spMigrationCutoverRoleChanges = pgTable(
  "sp_migration_cutover_role_changes",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    cutoverId: bigint("cutover_id", { mode: "number" }).notNull(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    sourceRoleId: integer("source_role_id"),
    targetRoleId: integer("target_role_id"),
    createdTargetRole: boolean("created_target_role").default(false).notNull(),
    sourceRoleSnapshot: jsonb("source_role_snapshot"),
    targetRoleSnapshotBefore: jsonb("target_role_snapshot_before"),
    mappedLocationId: integer("mapped_location_id"),
    mappedCashAccountId: integer("mapped_cash_account_id"),
    sessionsSwitched: integer("sessions_switched").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    sourceLocationsSnapshot: jsonb("source_locations_snapshot"),
    sourceCashMappingsSnapshot: jsonb("source_cash_mappings_snapshot"),
    targetLocationsSnapshotBefore: jsonb("target_locations_snapshot_before"),
    targetCashMappingsSnapshotBefore: jsonb("target_cash_mappings_snapshot_before"),
  },
  (table) => [
    foreignKey({
      columns: [table.cutoverId],
      foreignColumns: [spMigrationCutovers.id],
      name: "sp_migration_cutover_role_changes_cutover_id_fkey",
    }).onDelete("cascade"),
    unique("sp_migration_cutover_role_changes_cutover_id_user_id_key").on(table.cutoverId, table.userId),
  ]
);

export const spMigrationCutoverStockDeltas = pgTable(
  "sp_migration_cutover_stock_deltas",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    cutoverId: bigint("cutover_id", { mode: "number" }).notNull(),
    sourceInventoryId: integer("source_inventory_id"),
    targetInventoryId: integer("target_inventory_id"),
    sourceStockItemId: integer("source_stock_item_id"),
    targetStockItemId: integer("target_stock_item_id").notNull(),
    sourceLocationId: integer("source_location_id"),
    targetLocationId: integer("target_location_id").notNull(),
    beforeQuantity: numeric("before_quantity", { precision: 20, scale: 4 })
      .default(sql`0`)
      .notNull(),
    beforeAverageRate: numeric("before_average_rate", { precision: 20, scale: 6 })
      .default(sql`0`)
      .notNull(),
    beforeTotalValue: numeric("before_total_value", { precision: 20, scale: 4 })
      .default(sql`0`)
      .notNull(),
    afterQuantity: numeric("after_quantity", { precision: 20, scale: 4 })
      .default(sql`0`)
      .notNull(),
    afterAverageRate: numeric("after_average_rate", { precision: 20, scale: 6 })
      .default(sql`0`)
      .notNull(),
    afterTotalValue: numeric("after_total_value", { precision: 20, scale: 4 })
      .default(sql`0`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deltaKey: text("delta_key"),
    createdTargetInventory: boolean("created_target_inventory").default(false).notNull(),
  },
  (table) => [
    uniqueIndex("sp_migration_cutover_stock_delta_key_unique")
      .using("btree", table.cutoverId, table.deltaKey)
      .where(sql`(delta_key IS NOT NULL)`),
    foreignKey({
      columns: [table.cutoverId],
      foreignColumns: [spMigrationCutovers.id],
      name: "sp_migration_cutover_stock_deltas_cutover_id_fkey",
    }).onDelete("cascade"),
    unique("sp_migration_cutover_stock_de_cutover_id_source_inventory_i_key").on(
      table.cutoverId,
      table.sourceInventoryId
    ),
  ]
);

export const spMigrationCutovers = pgTable(
  "sp_migration_cutovers",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    sourceCompanyId: integer("source_company_id").notNull(),
    targetCompanyId: integer("target_company_id").notNull(),
    status: varchar({ length: 24 }).notNull(),
    preparedBy: varchar("prepared_by", { length: 255 }),
    activatedBy: varchar("activated_by", { length: 255 }),
    rolledBackBy: varchar("rolled_back_by", { length: 255 }),
    sourceCompanyName: text("source_company_name").notNull(),
    targetCompanyName: text("target_company_name").notNull(),
    readinessSnapshot: jsonb("readiness_snapshot"),
    finalReadinessSnapshot: jsonb("final_readiness_snapshot"),
    deltaSummary: jsonb("delta_summary"),
    roleSummary: jsonb("role_summary"),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).defaultNow().notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    rollbackDeadline: timestamp("rollback_deadline", { withTimezone: true }),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    failureMessage: text("failure_message"),
    notes: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    targetWriteHold: boolean("target_write_hold").default(false).notNull(),
    verificationSnapshot: jsonb("verification_snapshot"),
    recoverySummary: jsonb("recovery_summary"),
    rollbackWindowHours: integer("rollback_window_hours").default(72).notNull(),
    finalizeStartedAt: timestamp("finalize_started_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("sp_migration_cutovers_one_live_pair")
      .using("btree", table.sourceCompanyId, table.targetCompanyId)
      .where(sql`status IN ('prepared', 'active')`),
    uniqueIndex("sp_migration_cutovers_one_live_source")
      .using("btree", table.sourceCompanyId)
      .where(sql`status IN ('prepared', 'active')`),
    uniqueIndex("sp_migration_cutovers_one_live_target")
      .using("btree", table.targetCompanyId)
      .where(sql`status IN ('prepared', 'active')`),
    index("sp_migration_cutovers_source_status_idx").using("btree", table.sourceCompanyId, table.status),
    index("sp_migration_cutovers_target_status_idx").using("btree", table.targetCompanyId, table.status),
  ]
);

export const spMigrationRehearsalRuns = pgTable(
  "sp_migration_rehearsal_runs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    sourceCompanyId: integer("source_company_id").notNull(),
    targetCompanyId: integer("target_company_id").notNull(),
    action: varchar({ length: 20 }).notNull(),
    status: varchar({ length: 20 }).default("pending").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
    rowsCreated: integer("rows_created").default(0),
    errorMessage: text("error_message"),
    notes: text(),
  },
  (table) => [index("sp_migration_runs_target_idx").using("btree", table.targetCompanyId)]
);

export const spMigrationRunRows = pgTable(
  "sp_migration_run_rows",
  {
    id: serial().primaryKey().notNull(),
    runId: uuid("run_id").notNull(),
    tableName: varchar("table_name", { length: 100 }).notNull(),
    rowId: integer("row_id").notNull(),
  },
  (table) => [index("sp_migration_run_rows_run_idx").using("btree", table.runId)]
);
