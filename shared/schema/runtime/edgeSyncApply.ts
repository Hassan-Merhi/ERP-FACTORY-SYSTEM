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
  bigint,
  bigserial,
  char,
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
import { factoryPressingConfirmations } from "../factory/pressing-machine-tracking";

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
    unique().on(t.siteId, t.stream, t.companyId, t.localRef),
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

export const factoryEdgeAppliedEvents = pgTable(
  "factory_edge_applied_events",
  {
    siteId: uuid("site_id").notNull(),
    stream: text("stream").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    operationId: uuid("operation_id").notNull(),
    companyId: integer("company_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    operationKind: text("operation_kind").notNull(),
    localRef: integer("local_ref").notNull(),
    cloudRef: integer("cloud_ref"),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    businessDate: date("business_date"),
    outcome: text("outcome").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.stream, t.sequence] }), unique().on(t.siteId, t.operationId)]
);

// ── Phase 10 LAN operator pause/resume log (server/edge/phase10SyncControl.mjs)
export const factoryEdgeSyncControlLog = pgTable("factory_edge_sync_control_log", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  siteId: uuid("site_id").notNull(),
  action: text("action").notNull(),
  operatorName: text("operator_name").notNull(),
  reason: text("reason").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});
