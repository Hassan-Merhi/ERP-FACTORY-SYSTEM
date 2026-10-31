/**
 * Phase 4 LAN/cloud synchronization evidence tables.
 *
 * These are runtime-created, site-scoped tables and are deliberately not the
 * application's voucher/ledger schema. "Staged" must never mean "applied".
 * Keep columns in exact lockstep with server/edge runtime DDL.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const factoryEdgeOutboxCounter = pgTable("factory_edge_outbox_counter", {
  siteId: uuid("site_id").primaryKey().notNull(),
  lastSequence: bigint("last_sequence", { mode: "bigint" }).notNull(),
});

export const factoryEdgeVoucherOutbox = pgTable(
  "factory_edge_voucher_outbox",
  {
    sequence: bigint("sequence", { mode: "bigint" }).primaryKey().notNull(),
    siteId: uuid("site_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    companyId: integer("company_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    localVoucherId: integer("local_voucher_id").notNull(),
    operationKind: text("operation_kind").notNull().default("voucher.with-entries.v1"),
    payload: jsonb("payload").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("factory_edge_voucher_outbox_id").on(table.siteId, table.operationId),
    uniqueIndex("factory_edge_voucher_outbox_voucher").on(table.siteId, table.companyId, table.localVoucherId),
  ]
);

export const factoryEdgeStageReceipts = pgTable(
  "factory_edge_stage_receipts",
  {
    siteId: uuid("site_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    operationId: uuid("operation_id").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    state: text("state").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.siteId, table.sequence] })]
);

export const factoryEdgeStageCursor = pgTable("factory_edge_stage_cursor", {
  siteId: uuid("site_id").primaryKey().notNull(),
  // drizzle-kit cannot serialize a BigInt literal default; keep it in SQL.
  lastSequence: bigint("last_sequence", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
});

export const factoryEdgeStagedVouchers = pgTable(
  "factory_edge_staged_vouchers",
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
    stagedAt: timestamp("staged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.siteId, table.sequence] }),
    uniqueIndex("factory_edge_staged_vouchers_operation").on(table.siteId, table.operationId),
    uniqueIndex("factory_edge_staged_vouchers_business").on(table.siteId, table.companyId, table.localVoucherId),
  ]
);
