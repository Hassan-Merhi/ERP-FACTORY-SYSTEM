/**
 * One-time factory bale repair audit trails (server/startup/
 * ensureFactoryBaleOrderIntegrity.ts and the since-removed one-time legacy bale unit-cost repair).
 *
 * These tables are created by runtime DDL (CREATE TABLE IF NOT EXISTS in the
 * startup services). They are declared here so drizzle-kit and the type system
 * see the real schema; the definitions match the runtime DDL column for column
 * (tests/runtime-declared-tables-ddl.test.ts).
 */
import { pgTable, text, timestamp, integer, numeric } from "drizzle-orm/pg-core";

export const factoryBaleOrderStatusRepairs = pgTable("factory_bale_order_status_repairs", {
  baleId: integer("bale_id").primaryKey().notNull(),
  companyId: integer("company_id").notNull(),
  completedOrderId: integer("completed_order_id").notNull(),
  oldStatus: text("old_status").notNull(),
  newStatus: text("new_status").notNull(),
  repairedAt: timestamp("repaired_at", { withTimezone: true }).defaultNow().notNull(),
});

export const factoryLegacyBaleCostRepairs = pgTable("factory_legacy_bale_cost_repairs", {
  baleId: integer("bale_id").primaryKey().notNull(),
  companyId: integer("company_id").notNull(),
  articleCode: text("article_code"),
  referenceNumber: text("reference_number"),
  oldStatus: text("old_status").notNull(),
  weightKg: numeric("weight_kg", { precision: 20, scale: 7 }).notNull(),
  oldCostPerKg: numeric("old_cost_per_kg", { precision: 20, scale: 7 }).notNull(),
  newCostPerKg: numeric("new_cost_per_kg", { precision: 20, scale: 7 }).notNull(),
  oldTotalCost: numeric("old_total_cost", { precision: 20, scale: 7 }).notNull(),
  newTotalCost: numeric("new_total_cost", { precision: 20, scale: 7 }).notNull(),
  repairRunId: integer("repair_run_id"),
  repairedAt: timestamp("repaired_at", { withTimezone: true }).defaultNow().notNull(),
});
