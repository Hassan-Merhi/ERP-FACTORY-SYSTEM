import {
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

export const RETAIL_STOCK_MOVEMENT_TYPES = [
  "sale",
  "return",
  "adjustment",
  "import",
  "transfer_out",
  "transfer_in",
  "cancellation",
  "reversal",
] as const;

export type RetailStockMovementType = (typeof RETAIL_STOCK_MOVEMENT_TYPES)[number];

export const retailPosSales = pgTable(
  "retail_pos_sales",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("completed"),
    totalAmount: decimal("total_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    createdBy: varchar("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    notes: text("notes"),
    canceledAt: timestamp("canceled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_pos_sales_company_idx").on(t.companyId),
    locationIdx: index("retail_pos_sales_location_idx").on(t.locationId),
    companyIdempotencyUnique: uniqueIndex("retail_pos_sales_company_idempotency_unique").on(
      t.companyId,
      t.idempotencyKey
    ),
  })
);

export const retailPosSaleItems = pgTable(
  "retail_pos_sale_items",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    saleId: integer("sale_id")
      .notNull()
      .references(() => retailPosSales.id, { onDelete: "cascade" }),
    variantId: integer("variant_id")
      .notNull()
      .references(() => retailProductVariants.id, { onDelete: "restrict" }),
    quantity: decimal("quantity", { precision: 20, scale: 6 }).notNull(),
    returnedQuantity: decimal("returned_quantity", { precision: 20, scale: 6 }).notNull().default("0"),
    unitPrice: decimal("unit_price", { precision: 20, scale: 6 }).notNull(),
    unitCost: decimal("unit_cost", { precision: 20, scale: 6 }).notNull().default("0"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_pos_sale_items_company_idx").on(t.companyId),
    saleIdx: index("retail_pos_sale_items_sale_idx").on(t.saleId),
    variantIdx: index("retail_pos_sale_items_variant_idx").on(t.variantId),
  })
);

export const retailPosReturns = pgTable(
  "retail_pos_returns",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    saleId: integer("sale_id")
      .notNull()
      .references(() => retailPosSales.id, { onDelete: "restrict" }),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    createdBy: varchar("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_pos_returns_company_idx").on(t.companyId),
    saleIdx: index("retail_pos_returns_sale_idx").on(t.saleId),
    companyIdempotencyUnique: uniqueIndex("retail_pos_returns_company_idempotency_unique").on(
      t.companyId,
      t.idempotencyKey
    ),
  })
);

export const retailPosReturnItems = pgTable(
  "retail_pos_return_items",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    returnId: integer("return_id")
      .notNull()
      .references(() => retailPosReturns.id, { onDelete: "cascade" }),
    saleItemId: integer("sale_item_id")
      .notNull()
      .references(() => retailPosSaleItems.id, { onDelete: "restrict" }),
    variantId: integer("variant_id")
      .notNull()
      .references(() => retailProductVariants.id, { onDelete: "restrict" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    quantity: decimal("quantity", { precision: 20, scale: 6 }).notNull(),
    unitPrice: decimal("unit_price", { precision: 20, scale: 6 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_pos_return_items_company_idx").on(t.companyId),
    returnIdx: index("retail_pos_return_items_return_idx").on(t.returnId),
    saleItemIdx: index("retail_pos_return_items_sale_item_idx").on(t.saleItemId),
  })
);

export const retailStockOperations = pgTable(
  "retail_stock_operations",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    operationType: varchar("operation_type", { length: 40 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    referenceId: varchar("reference_id", { length: 191 }),
    createdBy: varchar("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_stock_operations_company_idx").on(t.companyId),
    companyIdempotencyUnique: uniqueIndex("retail_stock_operations_company_idempotency_unique").on(
      t.companyId,
      t.idempotencyKey
    ),
  })
);

export const retailStockMovements = pgTable(
  "retail_stock_movements",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    variantId: integer("variant_id")
      .notNull()
      .references(() => retailProductVariants.id, { onDelete: "restrict" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    movementType: varchar("movement_type", { length: 40 }).notNull(),
    quantityDelta: decimal("quantity_delta", { precision: 20, scale: 6 }).notNull(),
    quantityBefore: decimal("quantity_before", { precision: 20, scale: 6 }).notNull(),
    quantityAfter: decimal("quantity_after", { precision: 20, scale: 6 }).notNull(),
    eventKey: varchar("event_key", { length: 255 }).notNull(),
    referenceType: varchar("reference_type", { length: 40 }),
    referenceId: varchar("reference_id", { length: 191 }),
    createdBy: varchar("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_stock_movements_company_idx").on(t.companyId),
    variantIdx: index("retail_stock_movements_variant_idx").on(t.variantId),
    locationIdx: index("retail_stock_movements_location_idx").on(t.locationId),
    createdAtIdx: index("retail_stock_movements_created_at_idx").on(t.createdAt),
    companyEventUnique: uniqueIndex("retail_stock_movements_company_event_unique").on(t.companyId, t.eventKey),
  })
);

export type RetailPosSale = typeof retailPosSales.$inferSelect;
export type RetailPosSaleItem = typeof retailPosSaleItems.$inferSelect;
export type RetailPosReturn = typeof retailPosReturns.$inferSelect;
export type RetailStockMovement = typeof retailStockMovements.$inferSelect;