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
import { sql } from "drizzle-orm";
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
  "receive",
] as const;

export type RetailStockMovementType = (typeof RETAIL_STOCK_MOVEMENT_TYPES)[number];

/** One cashier's immutable open/close record at one Retail location. */
export const retailCashierShifts = pgTable(
  "retail_cashier_shifts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    cashierId: varchar("cashier_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    openingCash: decimal("opening_cash", { precision: 20, scale: 6 }).notNull().default("0"),
    openedAt: timestamp("opened_at").notNull().defaultNow(),
    openIdempotencyKey: varchar("open_idempotency_key", { length: 191 }).notNull(),
    cashSalesTotal: decimal("cash_sales_total", { precision: 20, scale: 6 }),
    refundTotal: decimal("refund_total", { precision: 20, scale: 6 }),
    cashInTotal: decimal("cash_in_total", { precision: 20, scale: 6 }),
    cashOutTotal: decimal("cash_out_total", { precision: 20, scale: 6 }),
    expectedClosingCash: decimal("expected_closing_cash", { precision: 20, scale: 6 }),
    actualCountedCash: decimal("actual_counted_cash", { precision: 20, scale: 6 }),
    variance: decimal("variance", { precision: 20, scale: 6 }),
    closedBy: varchar("closed_by").references(() => users.id, { onDelete: "restrict" }),
    closedAt: timestamp("closed_at"),
    closeNotes: text("close_notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyLocationIdx: index("retail_cashier_shifts_company_location_opened_idx").on(
      t.companyId,
      t.locationId,
      t.openedAt
    ),
    cashierIdx: index("retail_cashier_shifts_cashier_opened_idx").on(t.cashierId, t.openedAt),
    openIdempotencyUnique: uniqueIndex("retail_cashier_shifts_open_idempotency_unique").on(
      t.companyId,
      t.openIdempotencyKey
    ),
    oneOpenShiftPerCashierLocation: uniqueIndex("retail_cashier_shifts_one_open_per_cashier_location_unique")
      .on(t.companyId, t.locationId, t.cashierId)
      .where(sql`${t.status} = 'open'`),
  })
);

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
    requestFingerprint: varchar("request_fingerprint", { length: 64 }),
    checkoutVersion: integer("checkout_version"),
    shiftId: integer("shift_id").references(() => retailCashierShifts.id, { onDelete: "set null" }),
    status: varchar("status", { length: 32 }).notNull().default("completed"),
    subtotalAmount: decimal("subtotal_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    discountAmount: decimal("discount_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    taxAmount: decimal("tax_amount", { precision: 20, scale: 6 }).notNull().default("0"),
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
    grossAmount: decimal("gross_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    discountAmount: decimal("discount_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    taxAmount: decimal("tax_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    totalAmount: decimal("total_amount", { precision: 20, scale: 6 }).notNull().default("0"),
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
    totalAmount: decimal("total_amount", { precision: 20, scale: 6 }).notNull().default("0"),
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
    grossAmount: decimal("gross_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    discountAmount: decimal("discount_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    taxAmount: decimal("tax_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    totalAmount: decimal("total_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    unitCost: decimal("unit_cost", { precision: 20, scale: 6 }).notNull().default("0"),
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

export type RetailCashierShift = typeof retailCashierShifts.$inferSelect;
export type RetailPosSale = typeof retailPosSales.$inferSelect;
export type RetailPosSaleItem = typeof retailPosSaleItems.$inferSelect;
export type RetailPosReturn = typeof retailPosReturns.$inferSelect;
export type RetailPosReturnItem = typeof retailPosReturnItems.$inferSelect;
export type RetailStockMovement = typeof retailStockMovements.$inferSelect;
