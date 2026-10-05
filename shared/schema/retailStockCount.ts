import {
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { companies, locations } from "./common";
import { retailProductVariants } from "./retail";
import { users } from "./users";

/**
 * Physical stock count sessions (Wave 2, Track D).
 *
 * A session belongs to exactly one company + location. `expected_quantity` per line
 * is a snapshot taken when counting starts; `counted_quantity` is what staff scanned
 * or typed; finalizing compares the counted quantity to the *live* quantity under the
 * inventory row lock and writes `stock_count` movements, so POS sales during the count
 * cannot corrupt the reconciliation (the snapshot explains the variance, the movement
 * corrects the actual stock).
 */
export const RETAIL_STOCK_COUNT_STATUSES = ["draft", "counting", "review", "finalized", "canceled"] as const;
export type RetailStockCountStatus = (typeof RETAIL_STOCK_COUNT_STATUSES)[number];

export const RETAIL_STOCK_COUNT_LINE_STATUSES = ["uncounted", "counted", "variance", "unexpected"] as const;
export type RetailStockCountLineStatus = (typeof RETAIL_STOCK_COUNT_LINE_STATUSES)[number];

export const RETAIL_STOCK_COUNT_EVENT_TYPES = [
  "created",
  "started",
  "scan",
  "manual_entry",
  "note",
  "recount_requested",
  "review_started",
  "recount_started",
  "finalized",
  "canceled",
] as const;
export type RetailStockCountEventType = (typeof RETAIL_STOCK_COUNT_EVENT_TYPES)[number];

export const retailStockCountSessions = pgTable(
  "retail_stock_count_sessions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    /** Human reference, e.g. SC-000123, unique per company. */
    code: varchar("code", { length: 60 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    notes: text("notes"),
    snapshotAt: timestamp("snapshot_at"),
    countingStartedAt: timestamp("counting_started_at"),
    reviewStartedAt: timestamp("review_started_at"),
    finalizedAt: timestamp("finalized_at"),
    canceledAt: timestamp("canceled_at"),
    createdBy: varchar("created_by", { length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    finalizedBy: varchar("finalized_by", { length: 255 }).references(() => users.id, { onDelete: "restrict" }),
    canceledBy: varchar("canceled_by", { length: 255 }).references(() => users.id, { onDelete: "restrict" }),
    lineCount: integer("line_count").notNull().default(0),
    countedLineCount: integer("counted_line_count").notNull().default(0),
    uncountedLineCount: integer("uncounted_line_count").notNull().default(0),
    varianceLineCount: integer("variance_line_count").notNull().default(0),
    unexpectedLineCount: integer("unexpected_line_count").notNull().default(0),
    recountLineCount: integer("recount_line_count").notNull().default(0),
    expectedQuantityTotal: decimal("expected_quantity_total", { precision: 20, scale: 6 }).notNull().default("0"),
    countedQuantityTotal: decimal("counted_quantity_total", { precision: 20, scale: 6 }).notNull().default("0"),
    varianceQuantityTotal: decimal("variance_quantity_total", { precision: 20, scale: 6 }).notNull().default("0"),
    varianceValueTotal: decimal("variance_value_total", { precision: 20, scale: 6 }).notNull().default("0"),
    // Stored finalize summary so an idempotent replay returns the original result.
    finalizedResult: jsonb("finalized_result").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_stock_count_sessions_company_idx").on(t.companyId),
    companyStatusIdx: index("retail_stock_count_sessions_company_status_idx").on(t.companyId, t.status),
    locationIdx: index("retail_stock_count_sessions_location_idx").on(t.locationId),
    companyCodeUnique: uniqueIndex("retail_stock_count_sessions_company_code_unique").on(t.companyId, t.code),
  })
);

export const retailStockCountLines = pgTable(
  "retail_stock_count_lines",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => retailStockCountSessions.id, { onDelete: "cascade" }),
    variantId: integer("variant_id")
      .notNull()
      .references(() => retailProductVariants.id, { onDelete: "restrict" }),
    /** Quantity snapshot when the count started (0 for unexpected findings). */
    expectedQuantity: decimal("expected_quantity", { precision: 20, scale: 6 }).notNull().default("0"),
    /** null = never counted (status `uncounted`). */
    countedQuantity: decimal("counted_quantity", { precision: 20, scale: 6 }),
    status: varchar("status", { length: 20 }).notNull().default("uncounted"),
    recountRequired: boolean("recount_required").notNull().default(false),
    notes: text("notes"),
    // Finalize evidence: what live stock was before the adjustment, and the delta written.
    expectedLiveQuantity: decimal("expected_live_quantity", { precision: 20, scale: 6 }),
    varianceQuantity: decimal("variance_quantity", { precision: 20, scale: 6 }),
    movementDelta: decimal("movement_delta", { precision: 20, scale: 6 }),
    countedBy: varchar("counted_by", { length: 255 }).references(() => users.id, { onDelete: "restrict" }),
    countedAt: timestamp("counted_at"),
    lastScannedAt: timestamp("last_scanned_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_stock_count_lines_company_idx").on(t.companyId),
    sessionIdx: index("retail_stock_count_lines_session_idx").on(t.sessionId),
    statusIdx: index("retail_stock_count_lines_status_idx").on(t.status),
    sessionVariantUnique: uniqueIndex("retail_stock_count_lines_session_variant_unique").on(t.sessionId, t.variantId),
  })
);

/** Append-only audit trail of everything that happened during a count session. */
export const retailStockCountEvents = pgTable(
  "retail_stock_count_events",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => retailStockCountSessions.id, { onDelete: "cascade" }),
    lineId: integer("line_id").references(() => retailStockCountLines.id, { onDelete: "set null" }),
    variantId: integer("variant_id").references(() => retailProductVariants.id, { onDelete: "set null" }),
    eventType: varchar("event_type", { length: 40 }).notNull(),
    previousQuantity: decimal("previous_quantity", { precision: 20, scale: 6 }),
    quantity: decimal("quantity", { precision: 20, scale: 6 }),
    delta: decimal("delta", { precision: 20, scale: 6 }),
    note: text("note"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: varchar("created_by", { length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_stock_count_events_company_idx").on(t.companyId),
    sessionIdx: index("retail_stock_count_events_session_idx").on(t.sessionId),
    createdAtIdx: index("retail_stock_count_events_created_at_idx").on(t.createdAt),
  })
);

export type RetailStockCountSession = typeof retailStockCountSessions.$inferSelect;
export type RetailStockCountLine = typeof retailStockCountLines.$inferSelect;
export type RetailStockCountEvent = typeof retailStockCountEvents.$inferSelect;
