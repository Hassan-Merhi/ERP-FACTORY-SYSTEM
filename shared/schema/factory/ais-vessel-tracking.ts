import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  decimal,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { factoryContainers } from "./suppliers-containers";

/**
 * Latest AIS/vessel state linked to a factory container.
 *
 * Container-to-vessel resolution is implemented in Wave 2. This table is kept
 * separate from factory_containers so high-frequency AIS state never bloats the
 * accounting/shipping row and can evolve independently.
 */
export const factoryContainerVesselTracking = pgTable(
  "factory_container_vessel_tracking",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id")
      .notNull()
      .references(() => factoryContainers.id, { onDelete: "cascade" }),
    vesselName: varchar("vessel_name", { length: 255 }),
    imo: varchar("imo", { length: 16 }),
    mmsi: varchar("mmsi", { length: 16 }),
    voyageNumber: varchar("voyage_number", { length: 100 }),
    carrier: varchar("carrier", { length: 100 }),
    mappingSource: varchar("mapping_source", { length: 50 }),
    mappingConfidence: varchar("mapping_confidence", { length: 20 }).notNull().default("unknown"),

    latitude: decimal("latitude", { precision: 10, scale: 7 }),
    longitude: decimal("longitude", { precision: 11, scale: 7 }),
    speedKnots: decimal("speed_knots", { precision: 8, scale: 3 }),
    course: decimal("course", { precision: 8, scale: 3 }),
    heading: integer("heading"),
    navigationStatus: varchar("navigation_status", { length: 100 }),
    aisDestination: text("ais_destination"),
    aisEta: timestamp("ais_eta", { withTimezone: true }),
    lastPositionAt: timestamp("last_position_at", { withTimezone: true }),
    lastAisUpdateAt: timestamp("last_ais_update_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueContainer: uniqueIndex("factory_container_vessel_tracking_container_unique").on(t.containerId),
    companyIdx: index("factory_container_vessel_tracking_company_idx").on(t.companyId),
    mmsiIdx: index("factory_container_vessel_tracking_mmsi_idx").on(t.mmsi),
  })
);

export type FactoryContainerVesselTracking = typeof factoryContainerVesselTracking.$inferSelect;
export type InsertFactoryContainerVesselTracking = typeof factoryContainerVesselTracking.$inferInsert;
