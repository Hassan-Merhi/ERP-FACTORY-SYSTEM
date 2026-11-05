import { pgTable, bigserial, integer, varchar, text, timestamp, jsonb, boolean, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const supportTickets = pgTable("support_tickets", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: integer("company_id").notNull(),
  ticketNumber: varchar("ticket_number", { length: 40 }).notNull(),
  sourceMode: varchar("source_mode", { length: 12 }).notNull(),
  category: varchar("category", { length: 80 }).notNull(),
  priority: varchar("priority", { length: 16 }).notNull().default("normal"),
  status: varchar("status", { length: 24 }).notNull().default("open"),
  title: varchar("title", { length: 240 }).notNull(),
  description: text("description").notNull(),
  createdBy: varchar("created_by", { length: 100 }).notNull(),
  assignedTo: varchar("assigned_to", { length: 100 }).notNull(),
  reportedUserId: varchar("reported_user_id", { length: 100 }),
  resolutionNote: text("resolution_note"),
  finalizedBy: varchar("finalized_by", { length: 100 }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  reopenedCount: integer("reopened_count").notNull().default(0),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  numberUnique: uniqueIndex("support_tickets_company_number_uq").on(t.companyId, t.ticketNumber),
  statusIndex: index("support_tickets_company_status_idx").on(t.companyId, t.status),
  assigneeIndex: index("support_tickets_company_assignee_idx").on(t.companyId, t.assignedTo),
  dueIndex: index("support_tickets_company_due_idx").on(t.companyId, t.dueAt),
  stateCheck: check("support_tickets_status_ck", sql`${t.status} IN ('open','seen','working','finalized','reopened')`),
  modeCheck: check("support_tickets_mode_ck", sql`${t.sourceMode} IN ('erp','factory')`),
  priorityCheck: check("support_tickets_priority_ck", sql`${t.priority} IN ('low','normal','high','urgent')`),
}));

export const supportTicketParticipants = pgTable("support_ticket_participants", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ticketId: integer("ticket_id").notNull(),
  companyId: integer("company_id").notNull(),
  userId: varchar("user_id", { length: 100 }).notNull(),
  addedBy: varchar("added_by", { length: 100 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ uniqueMember: uniqueIndex("support_ticket_participant_uq").on(t.ticketId, t.userId), companyIndex: index("support_ticket_participant_company_idx").on(t.companyId, t.userId) }));

export const supportTicketRecords = pgTable("support_ticket_records", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ticketId: integer("ticket_id").notNull(),
  companyId: integer("company_id").notNull(),
  recordType: varchar("record_type", { length: 80 }).notNull(),
  recordId: varchar("record_id", { length: 120 }).notNull(),
  displayReference: varchar("display_reference", { length: 160 }).notNull(),
  snapshot: jsonb("snapshot").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ ticketIndex: index("support_ticket_records_ticket_idx").on(t.ticketId) }));

export const supportTicketAttachments = pgTable("support_ticket_attachments", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ticketId: integer("ticket_id").notNull(),
  companyId: integer("company_id").notNull(),
  uploadedBy: varchar("uploaded_by", { length: 100 }).notNull(),
  storageKey: text("storage_key").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: varchar("mime_type", { length: 120 }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: varchar("sha256", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ ticketIndex: index("support_ticket_attachments_ticket_idx").on(t.ticketId) }));

export const supportTicketComments = pgTable("support_ticket_comments", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ticketId: integer("ticket_id").notNull(),
  companyId: integer("company_id").notNull(),
  authorId: varchar("author_id", { length: 100 }).notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ ticketIndex: index("support_ticket_comments_ticket_idx").on(t.ticketId) }));

export const supportTicketEvents = pgTable("support_ticket_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ticketId: integer("ticket_id").notNull(),
  companyId: integer("company_id").notNull(),
  actorId: varchar("actor_id", { length: 100 }).notNull(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  beforeState: jsonb("before_state"),
  afterState: jsonb("after_state"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ ticketIndex: index("support_ticket_events_ticket_idx").on(t.ticketId, t.createdAt) }));

export const supportTicketOutbox = pgTable("support_ticket_outbox", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: integer("company_id").notNull(),
  ticketId: integer("ticket_id").notNull(),
  eventKey: varchar("event_key", { length: 180 }).notNull(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  payload: jsonb("payload").notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  attemptCount: integer("attempt_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ eventKeyUnique: uniqueIndex("support_ticket_outbox_key_uq").on(t.eventKey), pendingIndex: index("support_ticket_outbox_pending_idx").on(t.processedAt, t.availableAt) }));

export const supportTicketNotifications = pgTable("support_ticket_notifications", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: integer("company_id").notNull(),
  ticketId: integer("ticket_id").notNull(),
  outboxId: integer("outbox_id").notNull(),
  recipientUserId: varchar("recipient_user_id", { length: 100 }).notNull(),
  channel: varchar("channel", { length: 16 }).notNull(),
  deliveryStatus: varchar("delivery_status", { length: 24 }).notNull().default("pending"),
  providerMessageId: text("provider_message_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  readAt: timestamp("read_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ uniqueDelivery: uniqueIndex("support_ticket_notification_delivery_uq").on(t.outboxId,t.recipientUserId,t.channel) }));
