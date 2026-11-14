/** Factory historical replay, physical deletion and priority scan runtime tables. */
import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  varchar,
  jsonb,
  index,
  uniqueIndex,
  date,
  bigserial,
  bigint,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Raw-stock recalc and exact Historical Replay undo log (startup-schema/032). */
export const factoryRecalcUndoLog = pgTable(
  "factory_recalc_undo_log",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    userId: text("user_id"),
    username: text(),
    description: text().notNull(),
    containerCount: integer("container_count").default(0).notNull(),
    containerNumbers: text("container_numbers")
      .array()
      .default(sql`'{}'`)
      .notNull(),
    snapshot: jsonb().notNull(),
    operationType: text("operation_type").default("RAW_STOCK_RECALC").notNull(),
    algorithmVersion: text("algorithm_version"),
    scopeFingerprint: text("scope_fingerprint"),
    appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoneByUserId: text("undone_by_user_id"),
    undoneByUsername: text("undone_by_username"),
  },
  (table) => [
    index("factory_recalc_undo_log_company_applied_idx").using(
      "btree",
      table.companyId,
      table.appliedAt.desc().nullsFirst()
    ),
    index("factory_recalc_undo_log_exact_fingerprint_idx")
      .using("btree", table.companyId, table.scopeFingerprint)
      .where(sql`operation_type = 'HISTORICAL_REPLAY_EXACT'`),
  ]
);

/** Consumed exact Historical Replay tokens; a token can be spent once (startup-schema/032). */
export const factoryReplayConsumedTokens = pgTable(
  "factory_replay_consumed_tokens",
  {
    tokenHash: text("token_hash").primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    userId: text("user_id"),
    replayAlgorithmVersion: text("replay_algorithm_version").notNull(),
    scopeFingerprint: text("scope_fingerprint").notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("factory_replay_consumed_tokens_company_consumed_idx").using(
      "btree",
      table.companyId,
      table.consumedAt.desc().nullsFirst()
    ),
  ]
);

/**
 * Audit trail of physical stock deletion. The historical row has no foreign
 * keys to bale or customer order, so cleanup cannot destroy this evidence.
 * A unique company/bale key makes a second physical deletion impossible.
 */
export const factoryPhysicalBaleDeletions = pgTable(
  "factory_physical_bale_deletions",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    baleId: integer("bale_id").notNull(),
    referenceNumber: varchar("reference_number", { length: 100 }).notNull(),
    previousStatus: text("previous_status").notNull(),
    originalLocationId: integer("original_location_id"),
    removedByUserId: text("removed_by_user_id"),
    removedByName: text("removed_by_name").notNull(),
    reason: text("reason").notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("fpbd_company_bale_unique").on(table.companyId, table.baleId),
    index("fpbd_company_removed_idx").on(table.companyId, table.removedAt.desc(), table.id.desc()),
  ]
);

/**
 * Permanent original assignment of an automatically allocated physical bale.
 * Reversals annotate the old row without deleting it. If a still-physical bale\n * is later allocated again, that becomes a new timeline entry; at most one\n * active record exists per company/bale.
 */
export const factoryPriorityAutoAllocations = pgTable(
  "factory_priority_auto_allocations",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    baleId: integer("bale_id").notNull(),
    orderId: integer("order_id").notNull(),
    referenceNumber: varchar("reference_number", { length: 100 }).notNull(),
    priority: integer().notNull(),
    color: varchar({ length: 64 }).notNull(),
    allocationSource: varchar("allocation_source", { length: 32 }).notNull(),
    proformaId: integer("proforma_id"),
    articleCode: varchar("article_code", { length: 50 }),
    assignedByUserId: text("assigned_by_user_id"),
    assignedByName: text("assigned_by_name"),
    historyId: bigint("history_id", { mode: "number" }),
    allocatedAt: timestamp("allocated_at", { withTimezone: true }).defaultNow().notNull(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: text("reversed_by"),
    reversedByUserId: text("reversed_by_user_id"),
    reversalReason: text("reversal_reason"),
  },
  (table) => [
    uniqueIndex("fpaa_company_bale_active_unique")
      .on(table.companyId, table.baleId)
      .where(sql`${table.reversedAt} IS NULL`),
    index("fpaa_company_order_active_idx")
      .on(table.companyId, table.orderId)
      .where(sql`${table.reversedAt} IS NULL`),
  ]
);

/** One Priority Scan per row: which bale was scanned into which loading, at which priority, on which day. */
export const factoryPriorityScanHistory = pgTable(
  "factory_priority_scan_history",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    orderId: integer("order_id").notNull(),
    baleId: integer("bale_id").notNull(),
    referenceNumber: varchar("reference_number", { length: 100 }).notNull(),
    productName: text("product_name"),
    articleCode: varchar("article_code", { length: 50 }),
    priority: integer().notNull(),
    color: varchar({ length: 64 }).notNull(),
    businessDate: date("business_date").notNull(),
    scannedBy: text("scanned_by"),
    assignedByUserId: text("assigned_by_user_id"),
    proformaId: integer("proforma_id"),
    allocationSource: varchar("allocation_source", { length: 32 }).default("manual").notNull(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: text("reversed_by"),
    reversedByUserId: text("reversed_by_user_id"),
    reversalReason: text("reversal_reason"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("fpsh_company_date_scanned_idx").using(
      "btree",
      table.companyId,
      table.businessDate,
      table.scannedAt.desc().nullsFirst(),
      table.id.desc().nullsFirst()
    ),
    index("fpsh_company_bale_timeline_idx").on(table.companyId, table.baleId, table.id.desc()),
    index("fpsh_company_order_timeline_idx").on(table.companyId, table.orderId, table.id.desc()),
  ]
);
