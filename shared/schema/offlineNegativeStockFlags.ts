import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { companies } from "./common";

/**
 * Full offline mode (Phase B2), migration 0010_offline_negative_stock_flags:
 * one row per PC entry the cloud applied although it took stock below zero
 * (owner decision: such sales go negative and are flagged), until an Admin or
 * Developer closes it with a note.
 */
export const offlineNegativeStockFlags = pgTable(
  "offline_negative_stock_flags",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    deviceId: uuid("device_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    kind: text("kind").notNull(),
    conflictCode: text("conflict_code").notNull(),
    detail: jsonb("detail")
      .notNull()
      .default(sql`'{}'::jsonb`),
    cloudRef: integer("cloud_ref"),
    createdBy: varchar("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: varchar("resolved_by"),
    resolutionNote: text("resolution_note"),
  },
  (table) => [
    unique("offline_negative_stock_flags_operation_unique").on(table.deviceId, table.operationId),
    check(
      "offline_negative_stock_flags_resolution_check",
      sql`(${table.resolvedAt} IS NULL) = (${table.resolvedBy} IS NULL)`
    ),
    index("offline_negative_stock_flags_open_idx")
      .on(table.companyId, table.createdAt)
      .where(sql`${table.resolvedAt} IS NULL`),
  ]
);

export type OfflineNegativeStockFlag = typeof offlineNegativeStockFlags.$inferSelect;
