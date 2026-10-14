import { bigint, bigserial, decimal, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Drizzle definitions for the canonical stock movement journal.
 *
 * These tables are created by server/startup-schema/021-canonical-stock-movement-journal.ts,
 * not by `drizzle-kit push`, so they are deliberately declared here rather than
 * in shared/schema — the same treatment inventory_negative_layers and the other
 * startup-only tables get. Declaring them in the pushed schema would make
 * `push` prompt about whether they are renames of the startup-only tables it
 * can already see in the database, which has no answer in a non-interactive CI
 * step.
 */

export const canonicalStockMovements = pgTable(
  "canonical_stock_movements",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id").notNull(),
    stockItemId: integer("stock_item_id").notNull(),
    locationId: integer("location_id").notNull(),
    quantityDelta: decimal("quantity_delta", { precision: 18, scale: 6 }).notNull(),
    unitCost: decimal("unit_cost", { precision: 18, scale: 6 }).notNull(),
    movementKind: text("movement_kind").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    reversalOfMovementId: bigint("reversal_of_movement_id", { mode: "number" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companySourceIdx: index("canonical_stock_movements_company_source_idx").on(t.companyId, t.sourceType, t.sourceId),
    companyItemLocationIdx: index("canonical_stock_movements_company_item_location_idx").on(
      t.companyId,
      t.stockItemId,
      t.locationId
    ),
  })
);

export const canonicalStockMovementRequests = pgTable(
  "canonical_stock_movement_requests",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    movementIds: bigint("movement_ids", { mode: "number" }).array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyKeyUnique: uniqueIndex("canonical_stock_movement_requests_company_key_unique").on(
      t.companyId,
      t.idempotencyKey
    ),
    sourceIdx: index("canonical_stock_movement_requests_source_idx").on(t.companyId, t.sourceType, t.sourceId),
  })
);

export const canonicalStockMovementAudit = pgTable(
  "canonical_stock_movement_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    movementIds: bigint("movement_ids", { mode: "number" }).array().notNull(),
    quantity: decimal("quantity", { precision: 18, scale: 6 }).notNull(),
    value: decimal("value", { precision: 24, scale: 6 }).notNull(),
    actorUserId: text("actor_user_id"),
    actorUsername: text("actor_username"),
    reason: text("reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companySourceIdx: index("canonical_stock_movement_audit_company_source_idx").on(
      t.companyId,
      t.sourceType,
      t.sourceId
    ),
  })
);
