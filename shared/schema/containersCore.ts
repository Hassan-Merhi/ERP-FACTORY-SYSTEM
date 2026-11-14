/** Core container, tracking event and tracking check Drizzle tables. */
import {
  pgTable,
  text,
  varchar,
  serial,
  integer,
  decimal,
  date,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { suppliers } from "./erp";

export const containers = pgTable(
  "containers",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerNumber: varchar("container_number", { length: 100 }).notNull().unique(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("OTW"),
    importDate: date("import_date").notNull(),
    itemsTotal: decimal("items_total", { precision: 20, scale: 2 }).default("0"),
    chargesTotal: decimal("charges_total", { precision: 20, scale: 2 }).default("0"),
    grandTotal: decimal("grand_total", { precision: 20, scale: 2 }).default("0"),
    itemName: text("item_name"),
    ratePerKg: decimal("rate_per_kg", { precision: 10, scale: 2 }),
    totalKg: decimal("total_kg", { precision: 15, scale: 2 }),
    shopName: text("shop_name"),
    eta: date("eta"),
    portDepartureDate: date("port_departure_date"),
    etaSource: text("eta_source").default("manual"),
    transporter: varchar("transporter", { length: 100 }),
    transportFee: decimal("transport_fee", { precision: 15, scale: 2 }),
    numberPlate: varchar("number_plate", { length: 50 }),
    trackingLocation: text("tracking_location"),
    borderDate: date("border_date"),
    offloadDate: date("offload_date"),
    agent: varchar("agent", { length: 100 }),
    dutyFee: decimal("duty_fee", { precision: 15, scale: 2 }),
    docReceived: boolean("doc_received").default(false),
    trackingDescription: text("tracking_description"),
    blDocs: text("bl_docs"),
    docsSentDate: date("docs_sent_date"),
    freightStatus: text("freight_status"),
    trackingLink: text("tracking_link"),
    trackingProvider: text("tracking_provider"),
    trackingEnabled: boolean("tracking_enabled").notNull().default(false),
    trackingAutoUpdate: boolean("tracking_auto_update").notNull().default(false),
    trackingCarrierHint: text("tracking_carrier_hint"),
    trackingLastCheckedAt: timestamp("tracking_last_checked_at", { withTimezone: true }),
    trackingLastStatus: text("tracking_last_status"),
    trackingLastLocation: text("tracking_last_location"),
    trackingLastEventDate: timestamp("tracking_last_event_date", { withTimezone: true }),
    trackingLastDescription: text("tracking_last_description"),
    trackingError: text("tracking_error"),
    trackingChangedAt: timestamp("tracking_changed_at", { withTimezone: true }),
    trackingDetectedCarrier: text("tracking_detected_carrier"),
    trackingFallbackUsed: boolean("tracking_fallback_used").default(false),
    trackingFallbackReason: text("tracking_fallback_reason"),
    trackingNextCheckAt: timestamp("tracking_next_check_at", { withTimezone: true }),
    trackingLastSkipReason: text("tracking_last_skip_reason"),
    // ── JSONCargo — dedicated ETA-only provider (Maersk/Hapag-Lloyd/MSC/CMA CGM) ──
    // Kept separate from the generic tracking* fields above because JSONCargo runs
    // on its own weekly cadence (JSONCARGO_REFRESH_HOURS) independent of the
    // multi-provider status/location scheduler, and only ever touches `eta`.
    jsonCargoLastCheckedAt: timestamp("json_cargo_last_checked_at", { withTimezone: true }),
    jsonCargoTrackingStatus: text("json_cargo_tracking_status"),
    jsonCargoError: text("json_cargo_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("containers_company_idx").on(t.companyId),
  })
);

export const insertContainerSchema = createInsertSchema(containers)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    containerNumber: z.string().min(1, "Container number is required"),
    supplierId: z.number().min(1, "Supplier is required"),
    importDate: z.string().min(1, "Import date is required"),
  });

export type InsertContainer = z.infer<typeof insertContainerSchema>;
export type Container = typeof containers.$inferSelect;

export const containerTrackingEvents = pgTable(
  "container_tracking_events",
  {
    id: serial("id").primaryKey(),
    containerId: integer("container_id").notNull(),
    provider: text("provider").notNull().default("parcelsapp"),
    eventTime: timestamp("event_time", { withTimezone: true }),
    eventStatus: text("event_status"),
    eventLocation: text("event_location"),
    eventDescription: text("event_description"),
    rawEventJson: jsonb("raw_event_json"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    dedupUnique: uniqueIndex("cte_dedup_unique").on(t.containerId, t.eventTime, t.eventStatus),
  })
);

export type ContainerTrackingEvent = typeof containerTrackingEvents.$inferSelect;

export const containerTrackingChecks = pgTable("container_tracking_checks", {
  id: serial("id").primaryKey(),
  containerId: integer("container_id").notNull(),
  provider: text("provider").notNull().default("parcelsapp"),
  status: text("status").notNull(),
  checkedAt: timestamp("checked_at").notNull(),
  errorMessage: text("error_message"),
  rawResponseJson: jsonb("raw_response_json"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ContainerTrackingCheck = typeof containerTrackingChecks.$inferSelect;
