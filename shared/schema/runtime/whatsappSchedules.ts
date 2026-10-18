/**
 * Scheduled custom WhatsApp messages and stock-transfer export WhatsApp groups.
 *
 * These tables are created by runtime DDL (ensureScheduledWhatsAppMessageSchema
 * and the stock-transfer export WhatsApp routes). They are declared here so
 * drizzle-kit and the type system see the real schema; the definitions match
 * the runtime DDL column for column (tests/runtime-declared-tables-ddl.test.ts).
 */
import {
  pgTable,
  bigint,
  bigserial,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "../common";
import { whatsappRecipients } from "./notifications";

export const whatsappMessageSchedules = pgTable(
  "whatsapp_message_schedules",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    title: varchar({ length: 120 }).notNull(),
    message: text().notNull(),
    timezone: text().default("Asia/Beirut").notNull(),
    weeklyTimes: jsonb("weekly_times").default({}).notNull(),
    startDate: date("start_date"),
    endDate: date("end_date"),
    enabled: boolean().default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("whatsapp_message_schedules_company_idx").using("btree", table.companyId, table.enabled),
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "whatsapp_message_schedules_company_id_fkey",
    }).onDelete("cascade"),
    check("whatsapp_message_schedules_message_nonempty", sql`char_length(TRIM(BOTH FROM message)) > 0`),
  ]
);

export const whatsappMessageScheduleRecipients = pgTable(
  "whatsapp_message_schedule_recipients",
  {
    scheduleId: bigint("schedule_id", { mode: "number" }).notNull(),
    recipientId: integer("recipient_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.scheduleId, table.recipientId],
      name: "whatsapp_message_schedule_recipients_pkey",
    }),
    foreignKey({
      columns: [table.scheduleId],
      foreignColumns: [whatsappMessageSchedules.id],
      name: "whatsapp_message_schedule_recipients_schedule_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.recipientId],
      foreignColumns: [whatsappRecipients.id],
      name: "whatsapp_message_schedule_recipients_recipient_id_fkey",
    }).onDelete("cascade"),
  ]
);

export const whatsappMessageScheduleDeliveries = pgTable(
  "whatsapp_message_schedule_deliveries",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    scheduleId: bigint("schedule_id", { mode: "number" }).notNull(),
    recipientId: integer("recipient_id"),
    recipientName: text("recipient_name").notNull(),
    localDate: date("local_date").notNull(),
    messageSnapshot: text("message_snapshot").notNull(),
    status: text().default("sending").notNull(),
    error: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    index("whatsapp_message_schedule_deliveries_company_idx").using(
      "btree",
      table.scheduleId,
      table.createdAt.desc().nullsFirst()
    ),
    unique("whatsapp_message_schedule_deliveries_schedule_id_recipient_id_local_date_key").on(
      table.scheduleId,
      table.recipientId,
      table.localDate
    ),
    foreignKey({
      columns: [table.scheduleId],
      foreignColumns: [whatsappMessageSchedules.id],
      name: "whatsapp_message_schedule_deliveries_schedule_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.recipientId],
      foreignColumns: [whatsappRecipients.id],
      name: "whatsapp_message_schedule_deliveries_recipient_id_fkey",
    }).onDelete("set null"),
    check(
      "whatsapp_message_schedule_deliveries_status_check",
      sql`status = ANY (ARRAY['sending'::text, 'sent'::text, 'failed'::text])`
    ),
  ]
);

export const stockTransferExportWaGroups = pgTable(
  "stock_transfer_export_wa_groups",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    name: text().notNull(),
    chatId: text("chat_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("stock_transfer_export_wa_groups_company_id_chat_id_key").on(table.companyId, table.chatId),
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "stock_transfer_export_wa_groups_company_id_fkey",
    }).onDelete("cascade"),
  ]
);
