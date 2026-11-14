/** Immutable Phase 9 applied-events and Phase 10 operator log table definitions. */
import { sql } from "drizzle-orm";
import { bigint, bigserial, char, date, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

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
