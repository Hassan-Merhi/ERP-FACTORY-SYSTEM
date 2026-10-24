import { sql } from "drizzle-orm";
import { bigint, bigserial, index, integer, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * Append-only change history of the factory tables the historical Net Position
 * reads (server/services/audit/factoryRowHistory.ts installs the triggers).
 *   op S  baseline snapshot of a row that existed when its table's trigger was installed
 *   op I  row inserted (new_values = whole row)
 *   op U  row updated (old_values / new_values = only the columns that changed)
 *   op D  row deleted (old_values = whole row)
 * recorded_at is when the change was written (clock_timestamp(), not the
 * transaction start), in the same zone as the tracked tables' created_at columns.
 */
export const factoryRowHistory = pgTable(
  "factory_row_history",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tableName: text("table_name").notNull(),
    recordId: bigint("record_id", { mode: "number" }).notNull(),
    companyId: integer("company_id"),
    op: varchar("op", { length: 1 }).notNull(),
    recordedAt: timestamp("recorded_at")
      .notNull()
      .default(sql`(clock_timestamp() AT TIME ZONE 'UTC')`),
    actor: text("actor"),
    oldValues: jsonb("old_values"),
    newValues: jsonb("new_values"),
  },
  (t) => ({
    recordIdx: index("factory_row_history_record_idx").on(t.tableName, t.recordId, t.id),
    companyRecordIdx: index("factory_row_history_company_record_idx").on(t.companyId, t.tableName, t.recordId, t.id),
    recordedIdx: index("factory_row_history_recorded_idx").on(t.tableName, t.recordedAt),
  })
);

/** One row per tracked table: when its trigger and baseline snapshot were installed. */
export const factoryRowHistoryBaselines = pgTable("factory_row_history_baselines", {
  tableName: text("table_name").primaryKey(),
  baselineAt: timestamp("baseline_at").notNull(),
  snapshotRows: integer("snapshot_rows").notNull(),
  version: text("version").notNull(),
});

export type FactoryRowHistory = typeof factoryRowHistory.$inferSelect;
export type FactoryRowHistoryBaseline = typeof factoryRowHistoryBaselines.$inferSelect;
