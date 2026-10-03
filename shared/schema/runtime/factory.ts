/**
 * Factory production planning, staff tracking, scans and logs.
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
  boolean,
  uniqueIndex,
  date,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "../common";
import { employees } from "../erp/parties";
import { factoryProductionPositions } from "../factory/production-positions";

export const factoryStaffTrackingEntries = pgTable(
  "factory_staff_tracking_entries",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    pageType: varchar("page_type", { length: 20 }).notNull(),
    periodType: varchar("period_type", { length: 20 }).notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    personType: varchar("person_type", { length: 20 }).notNull(),
    personId: integer("person_id").notNull(),
    category: varchar({ length: 150 }),
    targetBales: numeric("target_bales", { precision: 12, scale: 2 }),
    producedBales: numeric("produced_bales", { precision: 12, scale: 2 }),
    status: varchar({ length: 20 }).default("Present").notNull(),
    notes: text(),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    groupName: varchar("group_name", { length: 200 }),
    targetOverridden: boolean("target_overridden").default(false).notNull(),
    categoryOverridden: boolean("category_overridden").default(false).notNull(),
  },
  (table) => [
    index("factory_staff_tracking_company_period_idx").using(
      "btree",
      table.companyId,
      table.pageType,
      table.periodStart,
      table.periodEnd
    ),
    uniqueIndex("factory_staff_tracking_unique_period_person").using(
      "btree",
      table.companyId,
      table.pageType,
      table.periodType,
      table.periodStart,
      table.periodEnd,
      table.personType,
      table.personId
    ),
    check("factory_staff_tracking_page_check", sql`page_type IN ('production', 'attendance')`),
    check("factory_staff_tracking_period_check", sql`period_type IN ('daily', 'weekly', 'monthly')`),
    check("factory_staff_tracking_person_check", sql`person_type IN ('worker', 'employee')`),
    check("factory_staff_tracking_status_check", sql`status IN ('Present', 'Absent', 'New')`),
    check("factory_staff_tracking_period_order_check", sql`period_end >= period_start`),
    check("factory_staff_tracking_target_nonnegative", sql`(target_bales IS NULL) OR (target_bales >= (0)::numeric)`),
    check(
      "factory_staff_tracking_produced_nonnegative",
      sql`(produced_bales IS NULL) OR (produced_bales >= (0)::numeric)`
    ),
  ]
);

export const factoryStaffTrackingPeriodClosures = pgTable(
  "factory_staff_tracking_period_closures",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    pageType: varchar("page_type", { length: 20 }).notNull(),
    periodType: varchar("period_type", { length: 20 }).notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    endedBy: varchar("ended_by", { length: 255 }),
    endedAt: timestamp("ended_at").defaultNow().notNull(),
  },
  (table) => [
    unique("factory_staff_tracking_closure_unique").on(
      table.companyId,
      table.pageType,
      table.periodType,
      table.periodStart,
      table.periodEnd
    ),
    check("factory_staff_tracking_closure_page_check", sql`page_type IN ('production', 'attendance')`),
    check("factory_staff_tracking_closure_period_check", sql`period_type IN ('daily', 'weekly', 'monthly')`),
    check("factory_staff_tracking_closure_period_order_check", sql`period_end >= period_start`),
  ]
);

export const factoryStatusBuilderLog = pgTable(
  "factory_status_builder_log",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    sheetId: integer("sheet_id").notNull(),
    sheetName: text("sheet_name").notNull(),
    rowLabel: text("row_label").default("").notNull(),
    columnLabel: text("column_label").default("").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    changedBy: text("changed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_sb_log_company_created").using("btree", table.companyId, table.createdAt.desc().nullsFirst()),
    index("idx_sb_log_sheet").using("btree", table.sheetId),
  ]
);

export const factoryWorkerProductionTargetDefaults = pgTable(
  "factory_worker_production_target_defaults",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    workerId: integer("worker_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    category: varchar({ length: 150 }),
    targetBales: numeric("target_bales", { precision: 12, scale: 2 }),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("factory_worker_production_target_default_lookup_idx").using(
      "btree",
      table.companyId,
      table.workerId,
      table.effectiveFrom.desc().nullsFirst()
    ),
    uniqueIndex("factory_worker_production_target_default_unique").using(
      "btree",
      table.companyId,
      table.workerId,
      table.effectiveFrom
    ),
    check(
      "factory_worker_production_target_default_nonnegative",
      sql`(target_bales IS NULL) OR (target_bales >= (0)::numeric)`
    ),
  ]
);

export const factoryWorkerProductionLinks = pgTable(
  "factory_worker_production_links",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("factory_worker_production_link_lookup_idx").using(
      "btree",
      table.companyId,
      table.effectiveFrom,
      table.effectiveTo
    ),
    check(
      "factory_worker_production_link_period_check",
      sql`(effective_to IS NULL) OR (effective_to >= effective_from)`
    ),
  ]
);

export const factoryWorkerProductionLinkMembers = pgTable(
  "factory_worker_production_link_members",
  {
    id: serial().primaryKey().notNull(),
    linkId: integer("link_id").notNull(),
    companyId: integer("company_id").notNull(),
    workerId: integer("worker_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("factory_worker_production_link_member_lookup_idx").using(
      "btree",
      table.companyId,
      table.workerId,
      table.linkId
    ),
    foreignKey({
      columns: [table.linkId],
      foreignColumns: [factoryWorkerProductionLinks.id],
      name: "factory_worker_production_link_members_link_id_fkey",
    }).onDelete("cascade"),
    unique("factory_worker_production_link_member_unique").on(table.linkId, table.workerId),
  ]
);

export const factoryWorkerProductionLinkTargetDefaults = pgTable(
  "factory_worker_production_link_target_defaults",
  {
    id: serial().primaryKey().notNull(),
    linkId: integer("link_id").notNull(),
    companyId: integer("company_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    targetBales: numeric("target_bales", { precision: 12, scale: 2 }),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("factory_worker_production_link_target_lookup_idx").using(
      "btree",
      table.companyId,
      table.linkId,
      table.effectiveFrom.desc().nullsFirst()
    ),
    foreignKey({
      columns: [table.linkId],
      foreignColumns: [factoryWorkerProductionLinks.id],
      name: "factory_worker_production_link_target_defaults_link_id_fkey",
    }).onDelete("cascade"),
    unique("factory_worker_production_link_target_unique").on(table.linkId, table.effectiveFrom),
    check(
      "factory_worker_production_link_target_nonnegative",
      sql`(target_bales IS NULL) OR (target_bales >= (0)::numeric)`
    ),
  ]
);

export const employeeAttendance = pgTable(
  "employee_attendance",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    attendanceDate: date("attendance_date").notNull(),
    status: varchar({ length: 20 }).default("Present").notNull(),
    notes: text(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("employee_attendance_company_date_idx").using("btree", table.companyId, table.attendanceDate),
    foreignKey({
      columns: [table.employeeId],
      foreignColumns: [employees.id],
      name: "employee_attendance_employee_id_fkey",
    }),
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "employee_attendance_company_id_fkey",
    }).onDelete("restrict"),
    unique("employee_attendance_unique").on(table.employeeId, table.attendanceDate),
  ]
);

export const factoryProductionPlanEntries = pgTable("factory_production_plan_entries", {
  id: serial().primaryKey().notNull(),
  planId: integer("plan_id").notNull(),
  workerId: integer("worker_id").notNull(),
  role: text().default("WORKER").notNull(),
  targetBales: integer("target_bales").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  teamLeaderWorkerId: integer("team_leader_worker_id"),
  workerCount: integer("worker_count").default(0).notNull(),
});

export const factoryProductionPlans = pgTable(
  "factory_production_plans",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    planDate: date("plan_date").notNull(),
    categoryIds: text("category_ids").default("[]").notNull(),
    notes: text(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "factory_production_plans_company_id_fkey",
    }).onDelete("restrict"),
    unique("factory_production_plans_company_id_plan_date_key").on(table.companyId, table.planDate),
  ]
);

export const factoryGroundScanItems = pgTable(
  "factory_ground_scan_items",
  {
    id: serial().primaryKey().notNull(),
    companyId: text("company_id").notNull(),
    locationId: integer("location_id"),
    referenceNumber: text("reference_number").notNull(),
    articleCode: text("article_code"),
    productName: text("product_name"),
    weightKg: numeric("weight_kg", { precision: 12, scale: 3 }),
    status: text(),
    isInLoadingOrder: boolean("is_in_loading_order").default(false).notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).defaultNow().notNull(),
    scannedByUserId: text("scanned_by_user_id"),
  },
  (table) => [
    index("factory_ground_scan_items_company_loc_idx").using("btree", table.companyId, table.locationId),
    unique("factory_ground_scan_items_company_id_location_id_reference__key").on(
      table.companyId,
      table.locationId,
      table.referenceNumber
    ),
  ]
);

export const factoryDailyBaleScans = pgTable(
  "factory_daily_bale_scans",
  {
    id: serial().primaryKey().notNull(),
    companyId: text("company_id").notNull(),
    scanDate: date("scan_date").notNull(),
    referenceNumber: text("reference_number").notNull(),
    articleCode: text("article_code"),
    productName: text("product_name"),
    weightKg: numeric("weight_kg", { precision: 12, scale: 3 }),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).defaultNow().notNull(),
    scannedByUserId: text("scanned_by_user_id"),
  },
  (table) => [
    index("factory_daily_bale_scans_company_date_idx").using("btree", table.companyId, table.scanDate),
    unique("factory_daily_bale_scans_company_id_scan_date_reference_num_key").on(
      table.companyId,
      table.scanDate,
      table.referenceNumber
    ),
  ]
);

export const customerPriceLists = pgTable(
  "customer_price_lists",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    customerId: integer("customer_id").notNull(),
    articleCode: text("article_code").notNull(),
    pricePerBale: numeric("price_per_bale", { precision: 20, scale: 4 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("customer_price_lists_customer_idx").using("btree", table.companyId, table.customerId),
    unique("customer_price_lists_company_id_customer_id_article_code_key").on(
      table.companyId,
      table.customerId,
      table.articleCode
    ),
  ]
);

export const factoryProductionPositionPlanEntries = pgTable(
  "factory_production_position_plan_entries",
  {
    id: serial().primaryKey().notNull(),
    planId: integer("plan_id").notNull(),
    companyId: integer("company_id").notNull(),
    positionId: integer("position_id").notNull(),
    positionNameSnapshot: text("position_name_snapshot").notNull(),
    targetBales: integer("target_bales").default(0).notNull(),
    bonusPerExtraBale: numeric("bonus_per_extra_bale", { precision: 20, scale: 4 })
      .default(sql`0`)
      .notNull(),
    bonusEnabled: boolean("bonus_enabled").default(false).notNull(),
    memberSnapshot: jsonb("member_snapshot").default([]).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("factory_production_position_plan_entries_company_position_idx").using(
      "btree",
      table.companyId,
      table.positionId
    ),
    uniqueIndex("factory_production_position_plan_entries_plan_position_unique").using(
      "btree",
      table.planId,
      table.positionId
    ),
    foreignKey({
      columns: [table.planId],
      foreignColumns: [factoryProductionPlans.id],
      name: "factory_production_position_plan_entries_plan_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.positionId],
      foreignColumns: [factoryProductionPositions.id],
      name: "factory_production_position_plan_entries_position_id_fkey",
    }).onDelete("restrict"),
  ]
);
