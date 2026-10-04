/**
 * Historical sales-cost repair runs (server/services/historicalSalesCostRepair*).
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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const historicalSalesCostRepairRuns = pgTable(
  "historical_sales_cost_repair_runs",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    status: text().notNull(),
    sourceCutoffAt: timestamp("source_cutoff_at", { withTimezone: true }).notNull(),
    requestedCompanyIds: integer("requested_company_ids").array(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    appliedBy: text("applied_by"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    auditHash: varchar("audit_hash", { length: 64 }),
    totalSalesRows: integer("total_sales_rows").default(0).notNull(),
    changedRows: integer("changed_rows").default(0).notNull(),
    blockedRows: integer("blocked_rows").default(0).notNull(),
    blockedItemLocations: integer("blocked_item_locations").default(0).notNull(),
    originalTotalCost: numeric("original_total_cost", { precision: 24, scale: 2 })
      .default(sql`0`)
      .notNull(),
    proposedTotalCost: numeric("proposed_total_cost", { precision: 24, scale: 2 })
      .default(sql`0`)
      .notNull(),
    originalTotalProfit: numeric("original_total_profit", { precision: 24, scale: 2 })
      .default(sql`0`)
      .notNull(),
    proposedTotalProfit: numeric("proposed_total_profit", { precision: 24, scale: 2 })
      .default(sql`0`)
      .notNull(),
    report: jsonb().default({}).notNull(),
    error: text(),
  },
  () => [
    check(
      "historical_sales_cost_repair_runs_status_check",
      sql`status = ANY (ARRAY['building'::text, 'blocked'::text, 'ready'::text, 'applying'::text, 'applied'::text, 'failed'::text])`
    ),
  ]
);

export const historicalSalesCostRepairRows = pgTable(
  "historical_sales_cost_repair_rows",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    companyId: integer("company_id").notNull(),
    locationId: integer("location_id").notNull(),
    stockItemId: integer("stock_item_id").notNull(),
    voucherId: integer("voucher_id").notNull(),
    salesItemId: integer("sales_item_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    evidence: text().notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    originalCostPrice: numeric("original_cost_price", { precision: 24, scale: 2 }).notNull(),
    originalTotalCost: numeric("original_total_cost", { precision: 24, scale: 2 }).notNull(),
    originalProfit: numeric("original_profit", { precision: 24, scale: 2 }).notNull(),
    proposedCostPrice: numeric("proposed_cost_price", { precision: 24, scale: 2 }).notNull(),
    proposedTotalCost: numeric("proposed_total_cost", { precision: 24, scale: 2 }).notNull(),
    proposedProfit: numeric("proposed_profit", { precision: 24, scale: 2 }).notNull(),
    changed: boolean().default(false).notNull(),
    status: text().notNull(),
    blockerCode: text("blocker_code"),
    blockerDetail: text("blocker_detail"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (table) => [
    index("historical_sales_cost_repair_rows_company_idx").using("btree", table.runId, table.companyId),
    index("historical_sales_cost_repair_rows_run_status_idx").using("btree", table.runId, table.status),
    index("historical_sales_cost_repair_rows_sale_idx").using("btree", table.salesItemId),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [historicalSalesCostRepairRuns.id],
      name: "historical_sales_cost_repair_rows_run_id_fkey",
    }).onDelete("restrict"),
    unique("historical_sales_cost_repair_rows_run_id_sales_item_id_key").on(table.runId, table.salesItemId),
    check(
      "historical_sales_cost_repair_rows_status_check",
      sql`status = ANY (ARRAY['ready'::text, 'blocked'::text, 'applied'::text, 'unchanged'::text])`
    ),
  ]
);

export const historicalSalesCostRepairChecks = pgTable(
  "historical_sales_cost_repair_checks",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    companyId: integer("company_id").notNull(),
    locationId: integer("location_id"),
    stockItemId: integer("stock_item_id"),
    checkCode: text("check_code").notNull(),
    status: text().notNull(),
    expectedValue: text("expected_value"),
    actualValue: text("actual_value"),
    detail: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("historical_sales_cost_repair_checks_run_idx").using("btree", table.runId, table.status, table.companyId),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [historicalSalesCostRepairRuns.id],
      name: "historical_sales_cost_repair_checks_run_id_fkey",
    }).onDelete("restrict"),
    check(
      "historical_sales_cost_repair_checks_status_check",
      sql`status = ANY (ARRAY['pass'::text, 'block'::text, 'warning'::text])`
    ),
  ]
);

export const historicalSalesCostRepairPartialApplies = pgTable(
  "historical_sales_cost_repair_partial_applies",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    auditHash: varchar("audit_hash", { length: 64 }).notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    targetHash: varchar("target_hash", { length: 64 }).notNull(),
    targetRows: integer("target_rows").notNull(),
    status: text().notNull(),
    appliedBy: text("applied_by").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
    rolledBackBy: text("rolled_back_by"),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
    report: jsonb().default({}).notNull(),
    rollbackReport: jsonb("rollback_report"),
  },
  (table) => [
    foreignKey({
      columns: [table.runId],
      foreignColumns: [historicalSalesCostRepairRuns.id],
      name: "historical_sales_cost_repair_partial_applies_run_id_fkey",
    }).onDelete("restrict"),
    unique("historical_sales_cost_repair_partial_applies_run_id_key").on(table.runId),
    check(
      "historical_sales_cost_repair_partial_applies_status_check",
      sql`status = ANY (ARRAY['applied'::text, 'rolled_back'::text])`
    ),
  ]
);

export const historicalSalesCostRepairApplyLog = pgTable(
  "historical_sales_cost_repair_apply_log",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    companyId: integer("company_id").notNull(),
    salesItemId: integer("sales_item_id").notNull(),
    beforeCostPrice: numeric("before_cost_price", { precision: 24, scale: 2 }).notNull(),
    beforeTotalCost: numeric("before_total_cost", { precision: 24, scale: 2 }).notNull(),
    beforeProfit: numeric("before_profit", { precision: 24, scale: 2 }).notNull(),
    afterCostPrice: numeric("after_cost_price", { precision: 24, scale: 2 }).notNull(),
    afterTotalCost: numeric("after_total_cost", { precision: 24, scale: 2 }).notNull(),
    afterProfit: numeric("after_profit", { precision: 24, scale: 2 }).notNull(),
    appliedBy: text("applied_by").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
    applyMode: text("apply_mode").default("full").notNull(),
    partialApplyId: bigint("partial_apply_id", { mode: "number" }),
    voucherId: integer("voucher_id"),
    locationId: integer("location_id"),
    stockItemId: integer("stock_item_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    evidence: text(),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    auditHash: varchar("audit_hash", { length: 64 }),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
    rolledBackBy: text("rolled_back_by"),
  },
  (table) => [
    index("historical_sales_cost_repair_apply_log_partial_idx").using("btree", table.partialApplyId),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [historicalSalesCostRepairRuns.id],
      name: "historical_sales_cost_repair_apply_log_run_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.partialApplyId],
      foreignColumns: [historicalSalesCostRepairPartialApplies.id],
      name: "historical_sales_cost_repair_apply_log_partial_apply_id_fkey",
    }).onDelete("restrict"),
    unique("historical_sales_cost_repair_apply_log_run_id_sales_item_id_key").on(table.runId, table.salesItemId),
  ]
);
