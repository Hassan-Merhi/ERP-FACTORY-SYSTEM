import { sql } from "drizzle-orm";
import { check, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./common";

/**
 * Full offline mode (Phase C1), migration 0013_offline_pc_record_map: which
 * cloud customer or ledger account each record a PC created offline became, per
 * PC (server/edge/phase9PcRecordMap.mjs). Rows are never changed or removed.
 */
export const factoryEdgePcRecordMap = pgTable(
  "factory_edge_pc_record_map",
  {
    siteId: uuid("site_id").notNull(),
    recordType: text("record_type").notNull(),
    localId: integer("local_id").notNull(),
    cloudId: integer("cloud_id").notNull(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    operationId: uuid("operation_id").notNull(),
    mappedAt: timestamp("mapped_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    primaryKey({ name: "factory_edge_pc_record_map_pkey", columns: [table.siteId, table.recordType, table.localId] }),
    check("factory_edge_pc_record_map_type_check", sql`${table.recordType} IN ('customer', 'ledger_account')`),
    check("factory_edge_pc_record_map_local_id_check", sql`${table.localId} >= 1000000000`),
    check("factory_edge_pc_record_map_cloud_id_check", sql`${table.cloudId} > 0 AND ${table.cloudId} < 1000000000`),
  ]
);

export type FactoryEdgePcRecordMapping = typeof factoryEdgePcRecordMap.$inferSelect;
