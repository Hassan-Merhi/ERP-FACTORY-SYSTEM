/**
 * Stock Transfer Order only: WhatsApp approval batch storage.
 *
 * This is deliberately separate from stock-transfer revisions and their existing
 * approval tables. A batch freezes the exact voucher/transfer IDs and revision
 * versions; no ordinary stock transfer can be selected unless it has a persisted
 * stock_transfer_order workflow_origin.
 */
import { sql } from "drizzle-orm";
import {
  pgTable, integer, bigint, bigserial, text, varchar, boolean, timestamp,
  uuid, jsonb, unique, uniqueIndex, index, foreignKey,
} from "drizzle-orm/pg-core";
import { companies, locations } from "../common";
import { stockTransferRevisions, stockTransferVouchers } from "./stock-movements";

export const stockTransferOrderApprovalSettings = pgTable("stock_transfer_order_approval_settings", {
  companyId: integer("company_id").primaryKey().references(() => companies.id, { onDelete: "restrict" }),
  enabled: boolean("enabled").notNull().default(false),
  approvalGroupChatId: text("approval_group_chat_id"),
  authorizedPhoneE164: varchar("authorized_phone_e164", { length: 21 }),
  updatedBy: varchar("updated_by", { length: 255 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const stockTransferOrderDestinationRecipients = pgTable(
  "stock_transfer_order_destination_recipients",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    destinationLocationId: integer("destination_location_id").notNull().references(() => locations.id, { onDelete: "restrict" }),
    chatId: text("chat_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedBy: varchar("updated_by", { length: 255 }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    destinationUnique: unique("sto_wa_dest_company_location_uq").on(t.companyId, t.destinationLocationId),
  })
);

export const stockTransferOrderApprovalBatches = pgTable(
  "stock_transfer_order_approval_batches",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    batchKey: uuid("batch_key").notNull().defaultRandom().unique(),
    companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    destinationLocationId: integer("destination_location_id").notNull().references(() => locations.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("draft"),
    approvalGroupChatId: text("approval_group_chat_id").notNull(),
    authorizedPhoneE164: varchar("authorized_phone_e164", { length: 21 }).notNull(),
    whatsappInstanceId: text("whatsapp_instance_id"),
    requestMessageId: text("request_message_id"),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByPhoneE164: varchar("reviewed_by_phone_e164", { length: 21 }),
    declineReason: text("decline_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdentity: unique("sto_wa_batches_company_id_uq").on(t.companyId, t.id),
    requestMessageUnique: uniqueIndex("sto_wa_batch_message_uk")
      .on(t.whatsappInstanceId, t.approvalGroupChatId, t.requestMessageId)
      .where(sql`request_message_id IS NOT NULL`),
    companyStatusIdx: index("sto_wa_batch_company_status_idx").on(t.companyId, t.status, t.createdAt),
  })
);

export const stockTransferOrderApprovalBatchItems = pgTable(
  "stock_transfer_order_approval_batch_items",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id").notNull(),
    batchId: bigint("batch_id", { mode: "number" }).notNull(),
    transferId: integer("transfer_id").notNull().references(() => stockTransferVouchers.id, { onDelete: "restrict" }),
    voucherNumberSnapshot: varchar("voucher_number_snapshot", { length: 100 }).notNull(),
    itemHashSnapshot: varchar("item_hash_snapshot", { length: 64 }).notNull(),
    reservationActive: boolean("reservation_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    batchFk: foreignKey({
      name: "sto_wa_items_batch_fk",
      columns: [t.companyId, t.batchId],
      foreignColumns: [stockTransferOrderApprovalBatches.companyId, stockTransferOrderApprovalBatches.id],
    }).onDelete("restrict"),
    identityUnique: unique("sto_wa_items_identity_uq").on(t.companyId, t.batchId, t.transferId),
    activeTransfer: uniqueIndex("sto_wa_active_transfer_uk")
      .on(t.companyId, t.transferId).where(sql`reservation_active`),
    batchIdx: index("sto_wa_items_batch_idx").on(t.companyId, t.batchId),
  })
);

export const stockTransferOrderApprovalBatchRevisions = pgTable(
  "stock_transfer_order_approval_batch_revisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id").notNull(),
    batchId: bigint("batch_id", { mode: "number" }).notNull(),
    transferId: integer("transfer_id").notNull(),
    revisionId: integer("revision_id").notNull().references(() => stockTransferRevisions.id, { onDelete: "restrict" }),
    revisionNumberSnapshot: integer("revision_number_snapshot").notNull(),
    payloadHashSnapshot: varchar("payload_hash_snapshot", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    itemFk: foreignKey({
      name: "sto_wa_revision_item_fk",
      columns: [t.companyId, t.batchId, t.transferId],
      foreignColumns: [
        stockTransferOrderApprovalBatchItems.companyId,
        stockTransferOrderApprovalBatchItems.batchId,
        stockTransferOrderApprovalBatchItems.transferId,
      ],
    }).onDelete("restrict"),
    revisionUnique: unique("sto_wa_revision_unique").on(t.companyId, t.batchId, t.revisionId),
    batchIdx: index("sto_wa_revisions_batch_idx").on(t.companyId, t.batchId, t.transferId),
  })
);

export const stockTransferOrderApprovalEvents = pgTable(
  "stock_transfer_order_approval_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id").notNull(),
    batchId: bigint("batch_id", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    whatsappInstanceId: text("whatsapp_instance_id"),
    providerMessageId: text("provider_message_id"),
    senderChatId: text("sender_chat_id"),
    approvalGroupChatId: text("approval_group_chat_id"),
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    batchFk: foreignKey({
      name: "sto_wa_events_batch_fk",
      columns: [t.companyId, t.batchId],
      foreignColumns: [stockTransferOrderApprovalBatches.companyId, stockTransferOrderApprovalBatches.id],
    }).onDelete("restrict"),
    dedupeUnique: uniqueIndex("sto_wa_event_dedupe_uk")
      .on(t.companyId, t.whatsappInstanceId, t.providerMessageId, t.eventType)
      .where(sql`provider_message_id IS NOT NULL`),
    historyIdx: index("sto_wa_events_batch_idx").on(t.companyId, t.batchId, t.occurredAt),
  })
);

export const stockTransferOrderApprovalDeliveries = pgTable(
  "stock_transfer_order_approval_deliveries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id").notNull(),
    batchId: bigint("batch_id", { mode: "number" }).notNull(),
    recipientKind: text("recipient_kind").notNull(),
    recipientChatId: text("recipient_chat_id").notNull(),
    status: text("status").notNull().default("pending"),
    workbookStorageKey: text("workbook_storage_key"),
    workbookSha256: varchar("workbook_sha256", { length: 64 }),
    filename: text("filename"),
    providerMessageId: text("provider_message_id"),
    claimToken: uuid("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    batchFk: foreignKey({
      name: "sto_wa_delivery_batch_fk",
      columns: [t.companyId, t.batchId],
      foreignColumns: [stockTransferOrderApprovalBatches.companyId, stockTransferOrderApprovalBatches.id],
    }).onDelete("restrict"),
    identityUnique: unique("sto_wa_delivery_identity_uq").on(t.companyId, t.batchId, t.recipientKind),
    pendingIdx: index("sto_wa_delivery_pending_idx").on(t.companyId, t.availableAt, t.id)
      .where(sql`status IN ('pending','failed')`),
    batchIdx: index("sto_wa_delivery_batch_idx").on(t.companyId, t.batchId),
  })
);

export type StockTransferOrderApprovalBatch = typeof stockTransferOrderApprovalBatches.$inferSelect;
