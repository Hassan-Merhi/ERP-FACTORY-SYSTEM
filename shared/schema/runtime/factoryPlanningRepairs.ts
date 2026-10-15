/**
 * Fixed Production Planner plans (migrations/20261015_001_factory_fixed_production_planner.sql)
 * and the one-time customer loading-date repair audit trails
 * (server/startup/runApprovedCustomerLoadingDateRepair.ts and
 * runApprovedReturnedLoadingDateRepair.ts).
 *
 * These tables are created by runtime DDL (CREATE TABLE IF NOT EXISTS). They
 * are declared here so drizzle-kit and the type system see the real schema;
 * the definitions match the runtime DDL column for column
 * (tests/runtime-declared-tables-ddl.test.ts).
 */
import {
  pgTable,
  check,
  foreignKey,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  date,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "../common";

export const factoryFixedProductionPlans = pgTable(
  "factory_fixed_production_plans",
  {
    companyId: integer("company_id").primaryKey().notNull(),
    allocations20t: jsonb("allocations_20t").default({}).notNull(),
    isLocked: boolean("is_locked").default(false).notNull(),
    revision: integer("revision").default(1).notNull(),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "factory_fixed_production_plans_company_id_fkey",
    }).onDelete("cascade"),
    check("factory_fixed_production_plans_revision_check", sql`revision > 0`),
    check("factory_fixed_production_allocations_object", sql`jsonb_typeof(allocations_20t) = 'object'`),
  ]
);

export const factoryCustomerLoadingDateRepairAudit = pgTable(
  "factory_customer_loading_date_repair_audit",
  {
    companyId: integer("company_id").notNull(),
    orderId: integer("order_id").notNull(),
    runKey: text("run_key").notNull(),
    sourceDaybookEntryId: integer("source_daybook_entry_id").notNull(),
    oldLoadingFinalizedAt: timestamp("old_loading_finalized_at", { mode: "string" }).notNull(),
    newLoadingFinalizedAt: timestamp("new_loading_finalized_at", { mode: "string" }).notNull(),
    selectedLoadingDate: date("selected_loading_date").notNull(),
    oldStatus: text("old_status").notNull(),
    invoiceNumber: text("invoice_number"),
    containerNumber: text("container_number"),
    repairedAt: timestamp("repaired_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ name: "factory_customer_loading_date_repair_audit_pkey", columns: [table.companyId, table.orderId] }),
  ]
);

export const factoryCustomerReturnedLoadingDateRepairAudit = pgTable(
  "factory_customer_returned_loading_date_repair_audit",
  {
    companyId: integer("company_id").notNull(),
    orderId: integer("order_id").notNull(),
    sourceDaybookEntryId: integer("source_daybook_entry_id").notNull(),
    oldLoadingFinalizedAt: timestamp("old_loading_finalized_at", { mode: "string" }),
    newLoadingFinalizedAt: timestamp("new_loading_finalized_at", { mode: "string" }).notNull(),
    statusBefore: text("status_before").notNull(),
    repairedAt: timestamp("repaired_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "factory_customer_returned_loading_date_repair_audit_pkey",
      columns: [table.companyId, table.orderId],
    }),
  ]
);
