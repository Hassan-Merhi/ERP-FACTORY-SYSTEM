/**
 * Canonical stock movements and inventory valuation records.
 *
 * These tables are created by runtime DDL (CREATE TABLE IF NOT EXISTS in the
 * startup migrations and ensure* services). They are declared here so
 * drizzle-kit and the type system see the real schema; the definitions match
 * production column for column and the runtime DDL constraint for constraint
 * (tests/runtime-declared-tables-ddl.test.ts).
 */
import {
  pgTable,
  check,
  bigserial,
  serial,
  text,
  timestamp,
  integer,
  varchar,
  numeric,
  index,
  foreignKey,
  unique,
  bigint,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies, locations } from "../common";
import { stockItems } from "../inventory";
import { vouchers } from "../erp/vouchers";

export const inventoryValuationOverrides = pgTable(
  "inventory_valuation_overrides",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    locationId: integer("location_id").notNull(),
    stockItemId: integer("stock_item_id").notNull(),
    inventoryId: integer("inventory_id"),
    sourceType: text("source_type").notNull(),
    beforeQuantity: numeric("before_quantity", { precision: 18, scale: 6 }).notNull(),
    beforeAverageRate: numeric("before_average_rate", { precision: 18, scale: 6 }).notNull(),
    beforeTotalValue: numeric("before_total_value", { precision: 24, scale: 6 }).notNull(),
    afterQuantity: numeric("after_quantity", { precision: 18, scale: 6 }).notNull(),
    afterAverageRate: numeric("after_average_rate", { precision: 18, scale: 6 }).notNull(),
    afterTotalValue: numeric("after_total_value", { precision: 24, scale: 6 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("inventory_valuation_overrides_company_item_location_idx").using(
      "btree",
      table.companyId,
      table.stockItemId,
      table.locationId,
      table.createdAt
    ),
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "inventory_valuation_overrides_company_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [locations.id],
      name: "inventory_valuation_overrides_location_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.stockItemId],
      foreignColumns: [stockItems.id],
      name: "inventory_valuation_overrides_stock_item_id_fkey",
    }).onDelete("restrict"),
  ]
);

export const canonicalStockMovements = pgTable(
  "canonical_stock_movements",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    stockItemId: integer("stock_item_id").notNull(),
    locationId: integer("location_id").notNull(),
    quantityDelta: numeric("quantity_delta", { precision: 18, scale: 6 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 18, scale: 6 }).notNull(),
    movementKind: text("movement_kind").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    reversalOfMovementId: bigint("reversal_of_movement_id", { mode: "number" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("canonical_stock_movements_company_item_location_idx").using(
      "btree",
      table.companyId,
      table.stockItemId,
      table.locationId
    ),
    index("canonical_stock_movements_company_source_idx").using(
      "btree",
      table.companyId,
      table.sourceType,
      table.sourceId
    ),
    index("canonical_stock_movements_reversal_idx")
      .using("btree", table.reversalOfMovementId)
      .where(sql`(reversal_of_movement_id IS NOT NULL)`),
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "canonical_stock_movements_company_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.stockItemId],
      foreignColumns: [stockItems.id],
      name: "canonical_stock_movements_stock_item_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [locations.id],
      name: "canonical_stock_movements_location_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.reversalOfMovementId],
      foreignColumns: [table.id],
      name: "canonical_stock_movements_reversal_of_movement_id_fkey",
    }).onDelete("restrict"),
    check("canonical_stock_movements_quantity_nonzero", sql`quantity_delta <> (0)::numeric`),
    check("canonical_stock_movements_unit_cost_nonnegative", sql`unit_cost >= (0)::numeric`),
  ]
);

export const canonicalStockMovementRequests = pgTable(
  "canonical_stock_movement_requests",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    movementIds: bigint("movement_ids", { mode: "number" }).array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("canonical_stock_movement_requests_source_idx").using(
      "btree",
      table.companyId,
      table.sourceType,
      table.sourceId
    ),
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "canonical_stock_movement_requests_company_id_fkey",
    }).onDelete("restrict"),
    unique("canonical_stock_movement_requests_company_key_unique").on(table.companyId, table.idempotencyKey),
  ]
);

export const canonicalStockMovementAudit = pgTable(
  "canonical_stock_movement_audit",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    movementIds: bigint("movement_ids", { mode: "number" }).array().notNull(),
    quantity: numeric({ precision: 18, scale: 6 }).notNull(),
    value: numeric({ precision: 24, scale: 6 }).notNull(),
    actorUserId: text("actor_user_id"),
    actorUsername: text("actor_username"),
    reason: text(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("canonical_stock_movement_audit_company_source_idx").using(
      "btree",
      table.companyId,
      table.sourceType,
      table.sourceId
    ),
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "canonical_stock_movement_audit_company_id_fkey",
    }).onDelete("restrict"),
  ]
);

export const phase3InventoryValuationCutovers = pgTable(
  "phase3_inventory_valuation_cutovers",
  {
    companyId: bigint("company_id", { mode: "number" }).primaryKey().notNull(),
    movementCutoffId: bigint("movement_cutoff_id", { mode: "number" }).default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "phase3_inventory_valuation_cutovers_company_id_fkey",
    }).onDelete("restrict"),
  ]
);

export const phase3InventoryValuationBaselines = pgTable(
  "phase3_inventory_valuation_baselines",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: bigint("company_id", { mode: "number" }).notNull(),
    stockItemId: bigint("stock_item_id", { mode: "number" }).notNull(),
    locationId: bigint("location_id", { mode: "number" }).notNull(),
    quantity: numeric({ precision: 18, scale: 3 }).notNull(),
    averageRate: numeric("average_rate", { precision: 20, scale: 2 }).notNull(),
    totalValue: numeric("total_value", { precision: 20, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("phase3_inventory_valuation_baselines_company_idx").using("btree", table.companyId),
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "phase3_inventory_valuation_baselines_company_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.stockItemId],
      foreignColumns: [stockItems.id],
      name: "phase3_inventory_valuation_baselines_stock_item_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [locations.id],
      name: "phase3_inventory_valuation_baselines_location_id_fkey",
    }).onDelete("restrict"),
    unique("phase3_inventory_valuation_baseline_unique").on(table.companyId, table.stockItemId, table.locationId),
  ]
);

export const inventoryNegativeLayers = pgTable(
  "inventory_negative_layers",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    locationId: integer("location_id").notNull(),
    stockItemId: integer("stock_item_id").notNull(),
    qty: numeric({ precision: 15, scale: 3 }).notNull(),
    provisionalRate: numeric("provisional_rate", { precision: 20, scale: 4 })
      .default(sql`0`)
      .notNull(),
    sourceVoucherType: varchar("source_voucher_type", { length: 100 }),
    sourceVoucherId: integer("source_voucher_id"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("inv_neg_layers_loc_item").using("btree", table.locationId, table.stockItemId),
    foreignKey({
      columns: [table.stockItemId],
      foreignColumns: [stockItems.id],
      name: "inventory_negative_layers_stock_item_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [locations.id],
      name: "inventory_negative_layers_location_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.sourceVoucherId],
      foreignColumns: [vouchers.id],
      name: "inventory_negative_layers_source_voucher_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "inventory_negative_layers_company_id_fkey",
    }).onDelete("restrict"),
  ]
);
