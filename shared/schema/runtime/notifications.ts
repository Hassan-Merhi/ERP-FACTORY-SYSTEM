/**
 * WhatsApp and e-mail export settings, schedules and delivery records.
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
  jsonb,
  index,
  foreignKey,
  unique,
  bigint,
  boolean,
  uniqueIndex,
  date,
  time,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies, locations } from "../common";
import { stockCategories, stockGroups } from "../inventory";

export const locationWhatsappStockDeliveries = pgTable(
  "location_whatsapp_stock_deliveries",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    locationId: integer("location_id").notNull(),
    source: text().notNull(),
    retryOfId: bigint("retry_of_id", { mode: "number" }),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text().default("running").notNull(),
    includeCost: boolean("include_cost").default(false).notNull(),
    includeZeroStock: boolean("include_zero_stock").default(false).notNull(),
    includeNegativeStock: boolean("include_negative_stock").default(true).notNull(),
    stockGroupId: integer("stock_group_id"),
    stockGroupUnassigned: boolean("stock_group_unassigned").default(false).notNull(),
    categoryId: integer("category_id"),
    initiatedByUserId: text("initiated_by_user_id"),
    scheduledFor: date("scheduled_for"),
    destinationChatId: text("destination_chat_id"),
    destinationGroupName: text("destination_group_name"),
    reportGeneratedAt: timestamp("report_generated_at", { withTimezone: true }),
    itemCount: integer("item_count"),
    pageCount: integer("page_count"),
    fileName: text("file_name"),
    error: text(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("location_whatsapp_stock_deliveries_location_idx").using(
      "btree",
      table.companyId,
      table.locationId,
      table.startedAt.desc().nullsFirst()
    ),
    uniqueIndex("location_whatsapp_stock_deliveries_one_active_retry_idx")
      .using("btree", table.retryOfId)
      .where(sql`((retry_of_id IS NOT NULL) AND (status = ANY (ARRAY['running'::text, 'sent'::text])))`),
    index("location_whatsapp_stock_deliveries_retry_idx")
      .using("btree", table.retryOfId)
      .where(sql`(retry_of_id IS NOT NULL)`),
    index("location_whatsapp_stock_deliveries_running_idx")
      .using("btree", table.startedAt)
      .where(sql`(status = 'running'::text)`),
    index("location_whatsapp_stock_deliveries_status_idx").using(
      "btree",
      table.companyId,
      table.status,
      table.startedAt.desc().nullsFirst()
    ),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [locations.id],
      name: "location_whatsapp_stock_deliveries_location_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.retryOfId],
      foreignColumns: [table.id],
      name: "location_whatsapp_stock_deliveries_retry_of_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.stockGroupId],
      foreignColumns: [stockGroups.id],
      name: "location_whatsapp_stock_deliveries_stock_group_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [stockCategories.id],
      name: "location_whatsapp_stock_deliveries_category_id_fkey",
    }).onDelete("set null"),
    unique("location_whatsapp_stock_deliveries_idempotency_unique").on(table.idempotencyKey),
    check(
      "location_whatsapp_stock_deliveries_source_check",
      sql`source = ANY (ARRAY['manual'::text, 'scheduled'::text, 'retry'::text])`
    ),
    check(
      "location_whatsapp_stock_deliveries_status_check",
      sql`status = ANY (ARRAY['running'::text, 'sent'::text, 'failed'::text, 'skipped_empty'::text])`
    ),
  ]
);

export const scheduledWhatsappOccurrences = pgTable(
  "scheduled_whatsapp_occurrences",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    jobType: text("job_type").notNull(),
    companyId: integer("company_id"),
    recipientKey: text("recipient_key").notNull(),
    recipientChatId: text("recipient_chat_id").notNull(),
    scheduledLocalDate: date("scheduled_local_date").notNull(),
    scheduledLocalHour: integer("scheduled_local_hour").notNull(),
    occurrenceKey: text("occurrence_key").notNull(),
    status: text().default("claimed").notNull(),
    claimToken: text("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    deliveryStartedAt: timestamp("delivery_started_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("scheduled_whatsapp_occurrences_recipient_idx").using(
      "btree",
      table.jobType,
      table.companyId,
      table.recipientKey,
      table.createdAt.desc().nullsFirst()
    ),
    index("scheduled_whatsapp_occurrences_retry_idx").using(
      "btree",
      table.jobType,
      table.status,
      table.createdAt.desc().nullsFirst()
    ),
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "scheduled_whatsapp_occurrences_company_id_fkey",
    }).onDelete("set null"),
    unique("scheduled_whatsapp_occurrences_key_unique").on(table.occurrenceKey),
    check(
      "scheduled_whatsapp_occurrences_hour_check",
      sql`(scheduled_local_hour >= 0) AND (scheduled_local_hour <= 23)`
    ),
    check(
      "scheduled_whatsapp_occurrences_status_check",
      sql`status = ANY (ARRAY['claimed'::text, 'delivering'::text, 'partial'::text, 'failed'::text, 'sent'::text])`
    ),
  ]
);

export const scheduledWhatsappAttachments = pgTable(
  "scheduled_whatsapp_attachments",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    occurrenceId: bigint("occurrence_id", { mode: "number" }).notNull(),
    attachmentKey: text("attachment_key").notNull(),
    status: text().default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("scheduled_whatsapp_attachments_status_idx").using("btree", table.occurrenceId, table.status),
    foreignKey({
      columns: [table.occurrenceId],
      foreignColumns: [scheduledWhatsappOccurrences.id],
      name: "scheduled_whatsapp_attachments_occurrence_id_fkey",
    }).onDelete("cascade"),
    unique("scheduled_whatsapp_attachments_occurrence_key_unique").on(table.occurrenceId, table.attachmentKey),
    check(
      "scheduled_whatsapp_attachments_status_check",
      sql`status = ANY (ARRAY['pending'::text, 'sending'::text, 'failed'::text, 'sent'::text])`
    ),
  ]
);

export const exportRecipients = pgTable(
  "export_recipients",
  {
    id: serial().primaryKey().notNull(),
    email: varchar({ length: 255 }).notNull(),
    active: boolean().default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [unique("export_recipients_email_key").on(table.email)]
);

export const exportSettings = pgTable("export_settings", {
  id: integer().primaryKey().notNull(),
  gmailUser: varchar("gmail_user", { length: 255 }).default("").notNull(),
  gmailAppPassword: text("gmail_app_password").default("").notNull(),
  scheduleEnabled: boolean("schedule_enabled").default(false).notNull(),
  lastRunAt: timestamp("last_run_at"),
  scheduleHour: integer("schedule_hour").default(18).notNull(),
  scheduleTimezone: text("schedule_timezone").default("America/New_York").notNull(),
});

export const whatsappRecipients = pgTable(
  "whatsapp_recipients",
  {
    id: serial().primaryKey().notNull(),
    chatId: varchar("chat_id", { length: 255 }).notNull(),
    name: varchar({ length: 255 }).default("").notNull(),
    isGroup: boolean("is_group").default(false).notNull(),
    active: boolean().default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    companyId: integer("company_id"),
  },
  (table) => [
    uniqueIndex("whatsapp_recipients_company_chat_unique").using("btree", table.companyId, table.chatId),
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "whatsapp_recipients_company_id_fkey",
    }).onDelete("restrict"),
  ]
);

export const whatsappSettings = pgTable("whatsapp_settings", {
  id: integer().primaryKey().notNull(),
  instanceId: varchar("instance_id", { length: 255 }).default("").notNull(),
  apiToken: text("api_token").default("").notNull(),
  enabled: boolean().default(false).notNull(),
  monthlyAutoSend: boolean("monthly_auto_send").default(false).notNull(),
  dailyAutoSend: boolean("daily_auto_send").default(false).notNull(),
  dailyRecipientId: integer("daily_recipient_id"),
  containersWaGroupChatId: text("containers_wa_group_chat_id").default("").notNull(),
  containersWaScheduleEnabled: boolean("containers_wa_schedule_enabled").default(false).notNull(),
  containersWaScheduleHour: integer("containers_wa_schedule_hour").default(8).notNull(),
  containersWaLastSentAt: timestamp("containers_wa_last_sent_at"),
  transferWaGroupChatId: text("transfer_wa_group_chat_id").default("").notNull(),
  agentDutyWaGroups: jsonb("agent_duty_wa_groups").default({}).notNull(),
  weeklyReportWaGroupChatId: text("weekly_report_wa_group_chat_id").default("").notNull(),
});

export const whatsappStockSettings = pgTable(
  "whatsapp_stock_settings",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id"),
    recipientId: integer("recipient_id"),
    autoSend: boolean("auto_send").default(false).notNull(),
    enabled: boolean().default(false).notNull(),
    frequency: varchar({ length: 20 }).default("daily").notNull(),
    sendHour: integer("send_hour").default(18).notNull(),
    sendDayOfWeek: integer("send_day_of_week"),
    lastSentAt: timestamp("last_sent_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "whatsapp_stock_settings_company_id_fkey",
    }).onDelete("restrict"),
  ]
);

export const netPositionExportSettings = pgTable("net_position_export_settings", {
  id: integer().default(1).primaryKey().notNull(),
  recipientId: integer("recipient_id"),
  frequency: varchar({ length: 20 }).default("daily").notNull(),
  sendHour: integer("send_hour").default(18).notNull(),
  sendDayOfWeek: integer("send_day_of_week"),
  enabled: boolean().default(false).notNull(),
  autoSend: boolean("auto_send").default(false).notNull(),
  lastSentAt: timestamp("last_sent_at"),
});

export const dailyExportRuns = pgTable("daily_export_runs", {
  id: serial().primaryKey().notNull(),
  runType: text("run_type").notNull(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
  status: text().default("running").notNull(),
  zipSizeBytes: integer("zip_size_bytes"),
  companiesCount: integer("companies_count"),
  companyFilesCount: integer("company_files_count"),
  skippedCompanies: text("skipped_companies"),
  emailAttempted: boolean("email_attempted").default(false),
  emailSuccess: boolean("email_success").default(false),
  emailError: text("email_error"),
  emailAttempts: integer("email_attempts").default(0),
  whatsappAttempted: boolean("whatsapp_attempted").default(false),
  whatsappSuccess: boolean("whatsapp_success").default(false),
  whatsappError: text("whatsapp_error"),
  whatsappAttempts: integer("whatsapp_attempts").default(0),
  skippedReason: text("skipped_reason"),
  details: jsonb(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const locationWhatsappStockReports = pgTable(
  "location_whatsapp_stock_reports",
  {
    locationId: integer("location_id").primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    whatsappGroupChatId: text("whatsapp_group_chat_id"),
    whatsappGroupName: text("whatsapp_group_name"),
    enabled: boolean().default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("location_whatsapp_stock_reports_company_idx").using("btree", table.companyId, table.locationId),
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "location_whatsapp_stock_reports_company_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [locations.id],
      name: "location_whatsapp_stock_reports_location_id_fkey",
    }).onDelete("cascade"),
    check(
      "location_whatsapp_stock_reports_enabled_requires_group",
      sql`(NOT enabled) OR (whatsapp_group_chat_id IS NOT NULL)`
    ),
  ]
);

export const locationWhatsappStockSchedules = pgTable(
  "location_whatsapp_stock_schedules",
  {
    locationId: integer("location_id").primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    enabled: boolean().default(false).notNull(),
    frequency: text().default("daily").notNull(),
    daysOfWeek: integer("days_of_week")
      .array()
      .default(sql`ARRAY[0, 1, 2, 3, 4, 5, 6]`)
      .notNull(),
    sendTime: time("send_time").default("18:00:00").notNull(),
    timezone: text().default("Africa/Lubumbashi").notNull(),
    includeCost: boolean("include_cost").default(false).notNull(),
    includeZeroStock: boolean("include_zero_stock").default(false).notNull(),
    includeNegativeStock: boolean("include_negative_stock").default(true).notNull(),
    stockGroupId: integer("stock_group_id"),
    categoryId: integer("category_id"),
    lastScheduledFor: date("last_scheduled_for"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("location_whatsapp_stock_schedules_category_idx")
      .using("btree", table.companyId, table.categoryId)
      .where(sql`(category_id IS NOT NULL)`),
    index("location_whatsapp_stock_schedules_due_idx").using("btree", table.enabled, table.companyId, table.locationId),
    index("location_whatsapp_stock_schedules_group_idx")
      .using("btree", table.companyId, table.stockGroupId)
      .where(sql`(stock_group_id IS NOT NULL)`),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [locations.id],
      name: "location_whatsapp_stock_schedules_location_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.stockGroupId],
      foreignColumns: [stockGroups.id],
      name: "location_whatsapp_stock_schedules_stock_group_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [stockCategories.id],
      name: "location_whatsapp_stock_schedules_category_id_fkey",
    }).onDelete("set null"),
    check(
      "location_whatsapp_stock_schedules_frequency_check",
      sql`frequency = ANY (ARRAY['daily'::text, 'selected_days'::text])`
    ),
  ]
);
