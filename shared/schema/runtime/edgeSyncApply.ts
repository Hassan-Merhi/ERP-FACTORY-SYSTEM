/**
 * Phase 8–10 LAN/cloud apply, event-stream and operator-control evidence.
 *
 * Declared here so the schema is visible to Drizzle and the runtime-only
 * table ratchet. The authoritative DDL — CHECK constraints, immutability
 * triggers and grants — is installed by a reviewed DBA step
 * (server/edge/offlineSchemaInstall.ts); a table created by `drizzle-kit push`
 * alone is NOT an approved install, and the LAN capture gate also requires
 * the immutability trigger. Keep columns in exact lockstep with server/edge DDL.
 */
import { sql } from "drizzle-orm";
import {
  uniqueIndex,
  bigint,
  bigserial,
  char,
  customType,
  date,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { vouchers } from "../erp/vouchers";
import { stockItems } from "../inventory";
import { factoryPressingConfirmations } from "../factory/pressing-machine-tracking";
import { containerOffloads } from "../containers";
import { storedFiles } from "../erp/documents";

// ── Phase 8 cloud voucher apply (server/edge/phase8ApplyStore.mjs) ─────────
export const factoryEdgeApplyCursor = pgTable("factory_edge_apply_cursor", {
  siteId: uuid("site_id").primaryKey().notNull(),
  lastSequence: bigint("last_sequence", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
});

export const factoryEdgeAppliedVouchers = pgTable(
  "factory_edge_applied_vouchers",
  {
    siteId: uuid("site_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    operationId: uuid("operation_id").notNull(),
    companyId: integer("company_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    localVoucherId: integer("local_voucher_id").notNull(),
    cloudVoucherId: integer("cloud_voucher_id")
      .notNull()
      .references(() => vouchers.id, { onDelete: "restrict" }),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    businessDate: date("business_date").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.sequence] }),
    unique().on(t.siteId, t.operationId),
    unique().on(t.siteId, t.companyId, t.localVoucherId),
    unique().on(t.companyId, t.cloudVoucherId),
  ]
);

export const factoryEdgeApplyApprovals = pgTable(
  "factory_edge_apply_approvals",
  {
    siteId: uuid("site_id").notNull(),
    companyId: integer("company_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    baselineSha256: char("baseline_sha256", { length: 64 }).notNull(),
    approvedUntil: timestamp("approved_until", { withTimezone: true }).notNull(),
    approvedBy: text("approved_by").notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.companyId, t.actorUserId] })]
);

// ── Phase 8 LAN applied-voucher receipt log (server/edge/edgeVoucherOutbox.ts)
export const factoryEdgeAppliedReceipts = pgTable(
  "factory_edge_applied_receipts",
  {
    siteId: uuid("site_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    operationId: uuid("operation_id").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    companyId: integer("company_id").notNull(),
    localVoucherId: integer("local_voucher_id").notNull(),
    cloudVoucherId: integer("cloud_voucher_id").notNull(),
    businessDate: date("business_date").notNull(),
    state: text("state").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.sequence] }), unique().on(t.siteId, t.operationId)]
);

// ── Phase 9 LAN pressing capture (server/edge/phase9PressingOutbox.ts) ─────
export const factoryEdgePressingCounter = pgTable("factory_edge_pressing_counter", {
  siteId: uuid("site_id").primaryKey().notNull(),
  lastSequence: bigint("last_sequence", { mode: "bigint" }).notNull(),
});

export const factoryEdgePressingOutbox = pgTable(
  "factory_edge_pressing_outbox",
  {
    siteId: uuid("site_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    operationId: uuid("operation_id").notNull(),
    companyId: integer("company_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    localConfirmationId: integer("local_confirmation_id").notNull(),
    operationKind: text("operation_kind").notNull(),
    payload: jsonb("payload").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.sequence] }),
    unique().on(t.siteId, t.operationId),
    unique().on(t.siteId, t.companyId, t.localConfirmationId),
    foreignKey({
      name: "factory_edge_pressing_source_fk",
      columns: [t.companyId, t.localConfirmationId],
      foreignColumns: [factoryPressingConfirmations.companyId, factoryPressingConfirmations.id],
    }).onDelete("restrict"),
  ]
);

// ── Phase 9 LAN stock capture (server/edge/phase9StockOutbox.ts) ────────
export const factoryEdgeStockCounter = pgTable("factory_edge_stock_counter", {
  siteId: uuid("site_id").primaryKey().notNull(),
  lastSequence: bigint("last_sequence", { mode: "bigint" }).notNull(),
});

export const factoryEdgeStockOutbox = pgTable(
  "factory_edge_stock_outbox",
  {
    siteId: uuid("site_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    operationId: uuid("operation_id").notNull(),
    companyId: integer("company_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    localMovementId: bigint("local_movement_id", { mode: "number" }).notNull(),
    operationKind: text("operation_kind").notNull(),
    payload: jsonb("payload").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.sequence] }),
    unique().on(t.siteId, t.operationId),
    unique().on(t.siteId, t.operationKind, t.localMovementId),
  ]
);

// ── Phase 9 LAN POS sale capture (server/edge/phase9PosOutbox.ts) ───────
export const factoryEdgePosCounter = pgTable("factory_edge_pos_counter", {
  siteId: uuid("site_id").primaryKey().notNull(),
  lastSequence: bigint("last_sequence", { mode: "bigint" }).notNull(),
});

export const factoryEdgePosOutbox = pgTable(
  "factory_edge_pos_outbox",
  {
    siteId: uuid("site_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    operationId: uuid("operation_id").notNull(),
    companyId: integer("company_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    localVoucherId: integer("local_voucher_id").notNull(),
    lanInvoiceNumber: text("lan_invoice_number"),
    operationKind: text("operation_kind").notNull(),
    payload: jsonb("payload").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.sequence] }),
    unique().on(t.siteId, t.operationId),
    unique().on(t.siteId, t.lanInvoiceNumber),
    foreignKey({
      name: "factory_edge_pos_source_fk",
      columns: [t.localVoucherId],
      foreignColumns: [vouchers.id],
    }).onDelete("restrict"),
  ]
);

// ── Phase 9 LAN receiving capture (server/edge/phase9ReceivingOutbox.ts) ─
export const factoryEdgeReceivingCounter = pgTable("factory_edge_receiving_counter", {
  siteId: uuid("site_id").primaryKey().notNull(),
  lastSequence: bigint("last_sequence", { mode: "bigint" }).notNull(),
});

export const factoryEdgeReceivingOutbox = pgTable(
  "factory_edge_receiving_outbox",
  {
    siteId: uuid("site_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    operationId: uuid("operation_id").notNull(),
    companyId: integer("company_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    localOffloadId: integer("local_offload_id").notNull(),
    operationKind: text("operation_kind").notNull(),
    payload: jsonb("payload").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.sequence] }),
    unique().on(t.siteId, t.operationId),
    unique().on(t.siteId, t.localOffloadId),
    foreignKey({
      name: "factory_edge_receiving_source_fk",
      columns: [t.localOffloadId],
      foreignColumns: [containerOffloads.id],
    }).onDelete("restrict"),
  ]
);

// ── Phase 9 LAN attachment capture (server/edge/phase9AttachmentOutbox.ts) ─
export const factoryEdgeAttachmentCounter = pgTable("factory_edge_attachment_counter", {
  siteId: uuid("site_id").primaryKey().notNull(),
  lastSequence: bigint("last_sequence", { mode: "bigint" }).notNull(),
});

export const factoryEdgeAttachmentOutbox = pgTable(
  "factory_edge_attachment_outbox",
  {
    siteId: uuid("site_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    operationId: uuid("operation_id").notNull(),
    companyId: integer("company_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    localFileId: integer("local_file_id").notNull(),
    operationKind: text("operation_kind").notNull(),
    payload: jsonb("payload").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.sequence] }),
    unique().on(t.siteId, t.operationId),
    // Plan batch 4: renames and moves name the same file, so only the upload is one-per-file.
    uniqueIndex("factory_edge_attachment_outbox_upload_once")
      .on(t.siteId, t.localFileId)
      .where(sql`operation_kind = 'attachment.file.v1'`),
    foreignKey({
      name: "factory_edge_attachment_source_fk",
      columns: [t.localFileId],
      foreignColumns: [storedFiles.id],
    }).onDelete("restrict"),
  ]
);

export const factoryEdgeAttachmentFileReceipts = pgTable(
  "factory_edge_attachment_file_receipts",
  {
    siteId: uuid("site_id").notNull(),
    fileSha256: char("file_sha256", { length: 64 }).notNull(),
    byteSize: integer("byte_size").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.fileSha256] })]
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

// Cloud: which cloud stock item each LAN-created item became (plan batch 2,
// server/edge/phase9StockItemMap.mjs). The id CHECK, uniques and the
// immutability trigger are installed by the runtime DDL.
export const factoryEdgeStockItemMap = pgTable(
  "factory_edge_stock_item_map",
  {
    siteId: uuid("site_id").notNull(),
    lanItemId: integer("lan_item_id").notNull(),
    cloudItemId: integer("cloud_item_id")
      .notNull()
      .references(() => stockItems.id, { onDelete: "restrict" }),
    operationId: uuid("operation_id").notNull(),
    mappedAt: timestamp("mapped_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.lanItemId] }),
    unique().on(t.cloudItemId),
    unique().on(t.siteId, t.operationId),
  ]
);

// Cloud: verified attachment bytes (server/edge/phase9CloudEventStore.mjs).
export const factoryEdgeStagedFiles = pgTable(
  "factory_edge_staged_files",
  {
    siteId: uuid("site_id").notNull(),
    fileSha256: char("file_sha256", { length: 64 }).notNull(),
    byteSize: integer("byte_size").notNull(),
    content: bytea("content").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.fileSha256] })]
);

// ── Phase 9 LAN payment capture (server/edge/phase9PaymentOutbox.ts) ────
export const factoryEdgePaymentCounter = pgTable("factory_edge_payment_counter", {
  siteId: uuid("site_id").primaryKey().notNull(),
  lastSequence: bigint("last_sequence", { mode: "bigint" }).notNull(),
});

export const factoryEdgePaymentOutbox = pgTable(
  "factory_edge_payment_outbox",
  {
    siteId: uuid("site_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    operationId: uuid("operation_id").notNull(),
    companyId: integer("company_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    localVoucherId: integer("local_voucher_id").notNull(),
    operationKind: text("operation_kind").notNull(),
    payload: jsonb("payload").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.sequence] }),
    unique().on(t.siteId, t.operationId),
    // Plan batch 4: edits and deletes name the same voucher, so only the create is one-per-voucher.
    uniqueIndex("factory_edge_payment_outbox_create_once")
      .on(t.siteId, t.localVoucherId)
      .where(sql`operation_kind = 'voucher.payment-receipt.v1'`),
    foreignKey({
      name: "factory_edge_payment_source_fk",
      columns: [t.localVoucherId],
      foreignColumns: [vouchers.id],
    }).onDelete("restrict"),
  ]
);

// ── Phase 9 LAN event-stream receipt logs ─────────────────────────────────
export const factoryEdgeEventStageReceipts = pgTable(
  "factory_edge_event_stage_receipts",
  {
    siteId: uuid("site_id").notNull(),
    stream: text("stream").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    operationId: uuid("operation_id").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    state: text("state").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.stream, t.sequence] })]
);

export const factoryEdgeEventAppliedReceipts = pgTable(
  "factory_edge_event_applied_receipts",
  {
    siteId: uuid("site_id").notNull(),
    stream: text("stream").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    operationId: uuid("operation_id").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    companyId: integer("company_id").notNull(),
    localRef: integer("local_ref").notNull(),
    cloudRef: integer("cloud_ref"),
    businessDate: date("business_date"),
    outcome: text("outcome").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.stream, t.sequence] }), unique().on(t.siteId, t.operationId)]
);

// ── Phase 9 cloud event streams (server/edge/phase9CloudEventStore.mjs) ────
export const factoryEdgeEventStageCursor = pgTable(
  "factory_edge_event_stage_cursor",
  {
    siteId: uuid("site_id").notNull(),
    stream: text("stream").notNull(),
    lastSequence: bigint("last_sequence", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.stream] })]
);

export const factoryEdgeStagedEvents = pgTable(
  "factory_edge_staged_events",
  {
    siteId: uuid("site_id").notNull(),
    stream: text("stream").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    operationId: uuid("operation_id").notNull(),
    companyId: integer("company_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    operationKind: text("operation_kind").notNull(),
    localRef: integer("local_ref").notNull(),
    payload: jsonb("payload").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    stagedAt: timestamp("staged_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.stream, t.sequence] }),
    unique().on(t.siteId, t.operationId),
    // No unique local_ref: follow-up records (an edit, a cancellation, a
    // delete) name the same LAN row as the record that created it.
  ]
);

export const factoryEdgeEventApplyCursor = pgTable(
  "factory_edge_event_apply_cursor",
  {
    siteId: uuid("site_id").notNull(),
    stream: text("stream").notNull(),
    lastSequence: bigint("last_sequence", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.stream] })]
);

export const factoryEdgeEventConflicts = pgTable(
  "factory_edge_event_conflicts",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    siteId: uuid("site_id").notNull(),
    stream: text("stream").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    operationId: uuid("operation_id").notNull(),
    companyId: integer("company_id").notNull(),
    operationKind: text("operation_kind").notNull(),
    code: text("code").notNull(),
    detail: jsonb("detail")
      .notNull()
      .default(sql`'{}'::jsonb`),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [unique().on(t.siteId, t.stream, t.sequence, t.code)]
);

export const factoryEdgeEventConflictDecisions = pgTable(
  "factory_edge_event_conflict_decisions",
  {
    siteId: uuid("site_id").notNull(),
    stream: text("stream").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    conflictId: bigint("conflict_id", { mode: "bigint" })
      .notNull()
      .references(() => factoryEdgeEventConflicts.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    decidedBy: text("decided_by").notNull(),
    reason: text("reason").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.stream, t.sequence] })]
);

export { factoryEdgeAppliedEvents, factoryEdgeSyncControlLog } from "./edgeSyncApplyFinalTables";
