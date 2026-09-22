import { pgTable, serial, integer, varchar, decimal, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { factoryContainers } from "./suppliers-containers";

/** Sampled AIS positions used for the actual-travel vessel trail. */
export const factoryContainerAisPositionHistory = pgTable(
  "factory_container_ais_position_history",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id").notNull().references(() => factoryContainers.id, { onDelete: "cascade" }),
    mmsi: varchar("mmsi", { length: 16 }).notNull(),
    vesselName: varchar("vessel_name", { length: 255 }),
    latitude: decimal("latitude", { precision: 10, scale: 7 }).notNull(),
    longitude: decimal("longitude", { precision: 11, scale: 7 }).notNull(),
    speedKnots: decimal("speed_knots", { precision: 8, scale: 3 }),
    course: decimal("course", { precision: 8, scale: 3 }),
    heading: integer("heading"),
    navigationStatus: varchar("navigation_status", { length: 100 }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    containerObservedIdx: index("factory_container_ais_history_container_observed_idx").on(t.containerId, t.observedAt),
    mmsiObservedIdx: index("factory_container_ais_history_mmsi_observed_idx").on(t.mmsi, t.observedAt),
    sampleUnique: uniqueIndex("factory_container_ais_history_sample_unique").on(t.containerId, t.mmsi, t.observedAt),
  })
);

export type FactoryContainerAisPositionHistory = typeof factoryContainerAisPositionHistory.$inferSelect;
