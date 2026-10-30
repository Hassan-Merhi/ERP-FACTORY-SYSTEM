import { sql } from "drizzle-orm";
import {
  pgTable, serial, integer, varchar, text, boolean, timestamp, time, date,
  numeric, jsonb, index, uniqueIndex, unique, check, foreignKey,
} from "drizzle-orm/pg-core";
import { companies } from "../common";
import { factoryBales } from "./raw-stock-mix";

// Physical pressing completion is independent of Factory stock finalization.
// In particular, none of these tables posts inventory, costing or accounting.
//
// Composite (company_id, id) uniqueness is declared as a table CONSTRAINT, not a
// uniqueIndex: drizzle-kit creates foreign keys before standalone indexes, so a
// composite FK that references a bare unique index fails on a fresh database
// ("there is no unique constraint matching given keys"). The versioned SQL and
// startup stage 037 create the equivalent unique indexes under the same names,
// which PostgreSQL also accepts as FK targets; IF NOT EXISTS keeps both paths
// idempotent.
export const factoryPressingMachines = pgTable("factory_pressing_machines", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  machineCode: varchar("machine_code", { length: 60 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  active: boolean("active").notNull().default(true),
  targetBalesPerHour: numeric("target_bales_per_hour", { precision: 12, scale: 3 }),
  createdBy: varchar("created_by", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUnique: unique("factory_pressing_machines_code_uk").on(t.companyId, t.machineCode),
  tenantIdUnique: unique("factory_pressing_machines_tenant_id_uk").on(t.companyId, t.id),
  activeIdx: index("factory_pressing_machines_company_active_idx").on(t.companyId, t.active),
  targetCheck: check("factory_pressing_machines_target_ck", sql`${t.targetBalesPerHour} IS NULL OR ${t.targetBalesPerHour} > 0`),
}));

// Current assignments are unique by (company, user); old assignments remain for audit.
export const factoryPressingAssignments = pgTable("factory_pressing_assignments", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  machineId: integer("machine_id").notNull(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  assignedBy: varchar("assigned_by", { length: 255 }).notNull(),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  unassignedAt: timestamp("unassigned_at", { withTimezone: true }),
  unassignedBy: varchar("unassigned_by", { length: 255 }),
}, (t) => ({
  tenantIdUnique: unique("factory_pressing_assignments_tenant_id_uk").on(t.companyId, t.id),
  identityUnique: unique("factory_pressing_assignments_identity_uk").on(t.companyId, t.id, t.machineId, t.userId),
  activeUserUnique: uniqueIndex("factory_pressing_assignments_active_user_uk").on(t.companyId, t.userId).where(sql`${t.unassignedAt} IS NULL`),
  machineDateIdx: index("factory_pressing_assignments_machine_date_idx").on(t.companyId, t.machineId, t.assignedAt.desc()),
  machineFk: foreignKey({ name: "factory_pressing_assignments_machine_fk", columns: [t.companyId, t.machineId], foreignColumns: [factoryPressingMachines.companyId, factoryPressingMachines.id] }).onDelete("restrict"),
  intervalCheck: check("factory_pressing_assignments_interval_ck", sql`${t.unassignedAt} IS NULL OR ${t.unassignedAt} >= ${t.assignedAt}`),
}));

// Start/end times are local wall-clock values; overnight shifts cross midnight.
// The timezone is an IANA timezone; the API validates it before creating a shift.
export const factoryPressingShifts = pgTable("factory_pressing_shifts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  shiftCode: varchar("shift_code", { length: 50 }).notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  startLocal: time("start_local").notNull(),
  endLocal: time("end_local").notNull(),
  timezoneName: varchar("timezone_name", { length: 100 }).notNull().default("UTC"),
  active: boolean("active").notNull().default(true),
  createdBy: varchar("created_by", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUnique: unique("factory_pressing_shifts_code_uk").on(t.companyId, t.shiftCode),
  tenantIdUnique: unique("factory_pressing_shifts_tenant_id_uk").on(t.companyId, t.id),
  hoursCheck: check("factory_pressing_shifts_hours_ck", sql`${t.startLocal} <> ${t.endLocal}`),
}));

export const factoryPressingSessions = pgTable("factory_pressing_sessions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  machineId: integer("machine_id").notNull(),
  assignmentId: integer("assignment_id").notNull(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  shiftId: integer("shift_id"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (t) => ({
  tenantIdUnique: unique("factory_pressing_sessions_tenant_id_uk").on(t.companyId, t.id),
  identityUnique: unique("factory_pressing_sessions_identity_uk").on(t.companyId, t.id, t.machineId, t.assignmentId, t.userId),
  activeUserUnique: uniqueIndex("factory_pressing_sessions_active_user_uk").on(t.companyId, t.userId).where(sql`${t.endedAt} IS NULL`),
  machineDateIdx: index("factory_pressing_sessions_machine_date_idx").on(t.companyId, t.machineId, t.startedAt.desc()),
  machineFk: foreignKey({ name: "factory_pressing_sessions_machine_fk", columns: [t.companyId, t.machineId], foreignColumns: [factoryPressingMachines.companyId, factoryPressingMachines.id] }).onDelete("restrict"),
  assignmentFk: foreignKey({ name: "factory_pressing_sessions_assignment_fk", columns: [t.companyId, t.assignmentId], foreignColumns: [factoryPressingAssignments.companyId, factoryPressingAssignments.id] }).onDelete("restrict"),
  assignmentIdentityFk: foreignKey({ name: "factory_pressing_sessions_assignment_identity_fk", columns: [t.companyId, t.assignmentId, t.machineId, t.userId], foreignColumns: [factoryPressingAssignments.companyId, factoryPressingAssignments.id, factoryPressingAssignments.machineId, factoryPressingAssignments.userId] }).onDelete("restrict"),
  shiftFk: foreignKey({ name: "factory_pressing_sessions_shift_fk", columns: [t.companyId, t.shiftId], foreignColumns: [factoryPressingShifts.companyId, factoryPressingShifts.id] }).onDelete("restrict"),
  intervalCheck: check("factory_pressing_sessions_interval_ck", sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`),
}));

// At most ONE non-voided confirmation per bale for its entire lifetime, across
// all machines, shifts, operators and dates. A separate unique request ID
// makes retries after ambiguous network failures idempotent.
export const factoryPressingConfirmations = pgTable("factory_pressing_confirmations", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  baleId: integer("bale_id").notNull(),
  machineId: integer("machine_id").notNull(),
  assignmentId: integer("assignment_id").notNull(),
  sessionId: integer("session_id").notNull(),
  shiftId: integer("shift_id"),
  userId: varchar("user_id", { length: 255 }).notNull(),
  userNameSnapshot: text("user_name_snapshot"),
  machineNameSnapshot: text("machine_name_snapshot").notNull(),
  referenceNumber: varchar("reference_number", { length: 100 }).notNull(),
  articleCode: varchar("article_code", { length: 50 }),
  productName: text("product_name"),
  weightKg: numeric("weight_kg", { precision: 15, scale: 3 }).notNull(),
  requestId: varchar("request_id", { length: 120 }).notNull(),
  deviceCapturedAt: timestamp("device_captured_at", { withTimezone: true }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
  productionDate: date("production_date").notNull(),
  timezoneName: varchar("timezone_name", { length: 100 }).notNull(),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: varchar("voided_by", { length: 255 }),
}, (t) => ({
  tenantIdUnique: unique("factory_pressing_confirmations_tenant_id_uk").on(t.companyId, t.id),
  requestUnique: uniqueIndex("factory_pressing_confirmations_request_uk").on(t.companyId, t.requestId),
  activeBaleUnique: uniqueIndex("factory_pressing_confirmations_one_active_bale_uk").on(t.companyId, t.baleId).where(sql`${t.voidedAt} IS NULL`),
  dateIdx: index("factory_pressing_confirmations_date_idx").on(t.companyId, t.productionDate, t.confirmedAt.desc()),
  machineDateIdx: index("factory_pressing_confirmations_machine_date_idx").on(t.companyId, t.machineId, t.productionDate, t.confirmedAt.desc()),
  operatorDateIdx: index("factory_pressing_confirmations_operator_date_idx").on(t.companyId, t.userId, t.productionDate),
  baleFk: foreignKey({ name: "factory_pressing_confirmations_bale_fk", columns: [t.companyId, t.baleId], foreignColumns: [factoryBales.companyId, factoryBales.id] }).onDelete("restrict"),
  machineFk: foreignKey({ name: "factory_pressing_confirmations_machine_fk", columns: [t.companyId, t.machineId], foreignColumns: [factoryPressingMachines.companyId, factoryPressingMachines.id] }).onDelete("restrict"),
  assignmentFk: foreignKey({ name: "factory_pressing_confirmations_assignment_fk", columns: [t.companyId, t.assignmentId], foreignColumns: [factoryPressingAssignments.companyId, factoryPressingAssignments.id] }).onDelete("restrict"),
  sessionFk: foreignKey({ name: "factory_pressing_confirmations_session_fk", columns: [t.companyId, t.sessionId], foreignColumns: [factoryPressingSessions.companyId, factoryPressingSessions.id] }).onDelete("restrict"),
  sessionIdentityFk: foreignKey({ name: "factory_pressing_confirmations_session_identity_fk", columns: [t.companyId, t.sessionId, t.machineId, t.assignmentId, t.userId], foreignColumns: [factoryPressingSessions.companyId, factoryPressingSessions.id, factoryPressingSessions.machineId, factoryPressingSessions.assignmentId, factoryPressingSessions.userId] }).onDelete("restrict"),
  shiftFk: foreignKey({ name: "factory_pressing_confirmations_shift_fk", columns: [t.companyId, t.shiftId], foreignColumns: [factoryPressingShifts.companyId, factoryPressingShifts.id] }).onDelete("restrict"),
  weightCheck: check("factory_pressing_confirmations_weight_ck", sql`${t.weightKg} >= 0`),
  voidCheck: check("factory_pressing_confirmations_void_ck", sql`(${t.voidedAt} IS NULL AND ${t.voidedBy} IS NULL) OR (${t.voidedAt} IS NOT NULL AND ${t.voidedBy} IS NOT NULL)`),
}));

export const factoryPressingDowntime = pgTable("factory_pressing_downtime", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  machineId: integer("machine_id").notNull(),
  sessionId: integer("session_id"),
  reportedBy: varchar("reported_by", { length: 255 }).notNull(),
  reasonCode: varchar("reason_code", { length: 60 }).notNull(),
  reasonNotes: text("reason_notes"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  openMachineUnique: uniqueIndex("factory_pressing_downtime_open_machine_uk").on(t.companyId, t.machineId).where(sql`${t.endedAt} IS NULL`),
  machineDateIdx: index("factory_pressing_downtime_machine_date_idx").on(t.companyId, t.machineId, t.startedAt.desc()),
  machineFk: foreignKey({ name: "factory_pressing_downtime_machine_fk", columns: [t.companyId, t.machineId], foreignColumns: [factoryPressingMachines.companyId, factoryPressingMachines.id] }).onDelete("restrict"),
  sessionFk: foreignKey({ name: "factory_pressing_downtime_session_fk", columns: [t.companyId, t.sessionId], foreignColumns: [factoryPressingSessions.companyId, factoryPressingSessions.id] }).onDelete("restrict"),
  intervalCheck: check("factory_pressing_downtime_interval_ck", sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`),
  reasonCheck: check("factory_pressing_downtime_reason_ck", sql`length(btrim(${t.reasonCode})) > 0`),
}));

// An immutable event trail. The migration's trigger prevents UPDATE/DELETE.
// Voiding the original confirmation and adding a correction are one transaction
// in the later supervisor API phase.
export const factoryPressingCorrections = pgTable("factory_pressing_corrections", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  confirmationId: integer("confirmation_id").notNull(),
  replacementConfirmationId: integer("replacement_confirmation_id"),
  action: varchar("action", { length: 30 }).notNull(),
  reason: text("reason").notNull(),
  supervisorUserId: varchar("supervisor_user_id", { length: 255 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  dateIdx: index("factory_pressing_corrections_date_idx").on(t.companyId, t.createdAt.desc()),
  confirmationIdx: index("factory_pressing_corrections_confirmation_idx").on(t.companyId, t.confirmationId),
  originalFk: foreignKey({ name: "factory_pressing_corrections_original_fk", columns: [t.companyId, t.confirmationId], foreignColumns: [factoryPressingConfirmations.companyId, factoryPressingConfirmations.id] }).onDelete("restrict"),
  replacementFk: foreignKey({ name: "factory_pressing_corrections_replacement_fk", columns: [t.companyId, t.replacementConfirmationId], foreignColumns: [factoryPressingConfirmations.companyId, factoryPressingConfirmations.id] }).onDelete("restrict"),
  actionCheck: check("factory_pressing_corrections_action_ck", sql`${t.action} IN ('VOID','RECONFIRM')`),
  reasonCheck: check("factory_pressing_corrections_reason_ck", sql`length(btrim(${t.reason})) > 0`),
  distinctCheck: check("factory_pressing_corrections_distinct_ck", sql`${t.replacementConfirmationId} IS NULL OR ${t.replacementConfirmationId} <> ${t.confirmationId}`),
}));

export const factoryPressingSavedViews = pgTable("factory_pressing_saved_views", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  userId: varchar("user_id", { length: 255 }).notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  reportMode: varchar("report_mode", { length: 20 }).notNull().default("detailed"),
  filters: jsonb("filters").notNull().default({}),
  visibleColumns: jsonb("visible_columns").notNull().default([]),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nameUnique: unique("factory_pressing_saved_views_name_uk").on(t.companyId, t.userId, t.name),
  defaultUserUnique: uniqueIndex("factory_pressing_saved_views_default_user_uk").on(t.companyId, t.userId).where(sql`${t.isDefault} = true`),
  modeCheck: check("factory_pressing_saved_views_mode_ck", sql`${t.reportMode} IN ('detailed', 'condensed')`),
  filtersCheck: check("factory_pressing_saved_views_filters_ck", sql`jsonb_typeof(${t.filters}) = 'object'`),
  columnsCheck: check("factory_pressing_saved_views_columns_ck", sql`jsonb_typeof(${t.visibleColumns}) = 'array'`),
}));

export type FactoryPressingMachine = typeof factoryPressingMachines.$inferSelect;
export type FactoryPressingAssignment = typeof factoryPressingAssignments.$inferSelect;
export type FactoryPressingShift = typeof factoryPressingShifts.$inferSelect;
export type FactoryPressingSession = typeof factoryPressingSessions.$inferSelect;
export type FactoryPressingConfirmation = typeof factoryPressingConfirmations.$inferSelect;
export type FactoryPressingDowntime = typeof factoryPressingDowntime.$inferSelect;
export type FactoryPressingCorrection = typeof factoryPressingCorrections.$inferSelect;
export type FactoryPressingSavedView = typeof factoryPressingSavedViews.$inferSelect;
