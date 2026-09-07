import {
  pgTable,
  text,
  varchar,
  serial,
  integer,
  decimal,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { locations } from "../common";
import { stockItems } from "../inventory";
import { vouchers } from "./vouchers";

export const stockTransferVouchers = pgTable("stock_transfer_vouchers", {
  id: serial("id").primaryKey(),
  voucherId: integer("voucher_id")
    .notNull()
    .references(() => vouchers.id, { onDelete: "restrict" }),
  sourceLocationId: integer("source_location_id").references(() => locations.id, { onDelete: "restrict" }),
  destinationLocationId: integer("destination_location_id")
    .notNull()
    .references(() => locations.id, { onDelete: "restrict" }),
  notes: text("notes"),
  inventoryApplied: boolean("inventory_applied").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertStockTransferVoucherSchema = createInsertSchema(stockTransferVouchers)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    voucherId: z.number().min(1, "Voucher is required"),
    sourceLocationId: z.number().optional(),
    destinationLocationId: z.number().min(1, "Destination location is required"),
  });

export type InsertStockTransferVoucher = z.infer<typeof insertStockTransferVoucherSchema>;
export type StockTransferVoucher = typeof stockTransferVouchers.$inferSelect;

export const stockTransferItems = pgTable("stock_transfer_items", {
  id: serial("id").primaryKey(),
  transferId: integer("transfer_id")
    .notNull()
    .references(() => stockTransferVouchers.id, { onDelete: "restrict" }),
  stockItemId: integer("stock_item_id")
    .notNull()
    .references(() => stockItems.id, { onDelete: "restrict" }),
  sourceLocationId: integer("source_location_id").references(() => locations.id, { onDelete: "restrict" }),
  quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
  rate: decimal("rate", { precision: 15, scale: 2 }).notNull(),
  totalAmount: decimal("total_amount", { precision: 15, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertStockTransferItemSchema = createInsertSchema(stockTransferItems)
  .omit({
    id: true,
    createdAt: true,
    totalAmount: true,
  })
  .extend({
    transferId: z.number().min(1, "Transfer is required"),
    stockItemId: z.number().min(1, "Stock item is required"),
    quantity: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, "Quantity must be positive"),
    rate: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Rate must be non-negative"),
  });

export type InsertStockTransferItem = z.infer<typeof insertStockTransferItemSchema>;
export type StockTransferItem = typeof stockTransferItems.$inferSelect;

export const stockAdjustmentVouchers = pgTable("stock_adjustment_vouchers", {
  id: serial("id").primaryKey(),
  voucherId: integer("voucher_id")
    .notNull()
    .references(() => vouchers.id, { onDelete: "cascade" }),
  locationId: integer("location_id")
    .notNull()
    .references(() => locations.id, { onDelete: "restrict" }),
  adjustmentType: text("adjustment_type").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertStockAdjustmentVoucherSchema = createInsertSchema(stockAdjustmentVouchers)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    voucherId: z.number().min(1, "Voucher is required"),
    locationId: z.number().min(1, "Location is required"),
    adjustmentType: z.enum(["Production", "Consumption", "Mixed"]),
  });

export type InsertStockAdjustmentVoucher = z.infer<typeof insertStockAdjustmentVoucherSchema>;
export type StockAdjustmentVoucher = typeof stockAdjustmentVouchers.$inferSelect;

export const stockAdjustmentItems = pgTable("stock_adjustment_items", {
  id: serial("id").primaryKey(),
  adjustmentId: integer("adjustment_id")
    .notNull()
    .references(() => stockAdjustmentVouchers.id, { onDelete: "cascade" }),
  stockItemId: integer("stock_item_id")
    .notNull()
    .references(() => stockItems.id, { onDelete: "restrict" }),
  quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
  rate: decimal("rate", { precision: 15, scale: 2 }).notNull(),
  totalAmount: decimal("total_amount", { precision: 15, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertStockAdjustmentItemSchema = createInsertSchema(stockAdjustmentItems)
  .omit({
    id: true,
    createdAt: true,
    totalAmount: true,
  })
  .extend({
    adjustmentId: z.number().min(1, "Adjustment is required"),
    stockItemId: z.number().min(1, "Stock item is required"),
    quantity: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) !== 0, "Quantity cannot be zero"),
    rate: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Rate must be non-negative"),
  });

export type InsertStockAdjustmentItem = z.infer<typeof insertStockAdjustmentItemSchema>;
export type StockAdjustmentItem = typeof stockAdjustmentItems.$inferSelect;

export const stockTransferRevisions = pgTable(
  "stock_transfer_revisions",
  {
    id: serial("id").primaryKey(),
    transferId: integer("transfer_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    note: text("note"),
    optional: boolean("optional").default(false).notNull(),
    revisionDate: timestamp("revision_date").notNull().defaultNow(),
    createdBy: varchar("created_by"),
    status: text("status").notNull().default("pending"),
    reviewedAt: timestamp("reviewed_at"),
    reviewedBy: varchar("reviewed_by"),
    rejectionReason: text("rejection_reason"),
    supersededByRevisionId: integer("superseded_by_revision_id"),
    payloadHash: varchar("payload_hash", { length: 64 }),
  },
  (table) => ({
    transferRevisionUnique: uniqueIndex("stock_transfer_revisions_transfer_number_unique").on(
      table.transferId,
      table.revisionNumber
    ),
    transferStatusRevisionIndex: index("stock_transfer_revisions_transfer_status_number_idx").on(
      table.transferId,
      table.status,
      table.revisionNumber
    ),
  })
);

export const stockTransferRevisionItems = pgTable("stock_transfer_revision_items", {
  id: serial("id").primaryKey(),
  revisionId: integer("revision_id").notNull(),
  stockItemId: integer("stock_item_id")
    .notNull()
    .references(() => stockItems.id, { onDelete: "restrict" }),
  stockItemName: text("stock_item_name").notNull(),
  sourceLocationId: integer("source_location_id").references(() => locations.id, { onDelete: "restrict" }),
  sourceLocationName: text("source_location_name"),
  originalQuantity: decimal("original_quantity", { precision: 15, scale: 3 }).notNull(),
  delta: decimal("delta", { precision: 15, scale: 3 }).notNull(),
  newQuantity: decimal("new_quantity", { precision: 15, scale: 3 }).notNull(),
});

export type StockTransferRevision = typeof stockTransferRevisions.$inferSelect;
export type StockTransferRevisionItem = typeof stockTransferRevisionItems.$inferSelect;

export const updateStockTransferItemSchema = z.object({
  sourceLocationId: z.coerce.number().int().positive("Source location must be a positive integer"),
  stockItemId: z.coerce.number().int().positive("Stock item must be a positive integer"),
  quantity: z.coerce
    .number()
    .finite("Quantity must be a finite number")
    .refine((val) => val !== 0, "Quantity cannot be zero"),
  rate: z.coerce.number().nonnegative("Rate must be non-negative").finite("Rate must be a finite number"),
});

export const updateStockTransferSchema = z.object({
  destinationLocationId: z.coerce.number().int().positive("Destination location must be a positive integer"),
  notes: z.string().optional(),
  items: z.array(updateStockTransferItemSchema).min(1, "At least one item is required"),
});

export type UpdateStockTransfer = z.infer<typeof updateStockTransferSchema>;

export const updateStockAdjustmentItemSchema = z.object({
  stockItemId: z.coerce.number().int().positive("Stock item must be a positive integer"),
  quantity: z.coerce
    .number()
    .finite("Quantity must be a finite number")
    .refine((val) => val !== 0, "Quantity cannot be zero"),
  rate: z.coerce.number().nonnegative("Rate must be non-negative").finite("Rate must be a finite number"),
});

export const updateStockAdjustmentSchema = z.object({
  locationId: z.coerce.number().int().positive("Location must be a positive integer"),
  adjustmentType: z.enum(["Production", "Consumption", "Mixed"]),
  notes: z.string().optional(),
  items: z.array(updateStockAdjustmentItemSchema).min(1, "At least one item is required"),
});

export type UpdateStockAdjustment = z.infer<typeof updateStockAdjustmentSchema>;

export const salesItems = pgTable(
  "sales_items",
  {
    id: serial("id").primaryKey(),
    voucherId: integer("voucher_id")
      .notNull()
      .references(() => vouchers.id, { onDelete: "cascade" }),
    stockItemId: integer("stock_item_id")
      .notNull()
      .references(() => stockItems.id, { onDelete: "restrict" }),
    quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
    sellingPrice: decimal("selling_price", { precision: 15, scale: 6 }).notNull(),
    costPrice: decimal("cost_price", { precision: 15, scale: 2 }).notNull(),
    totalSales: decimal("total_sales", { precision: 15, scale: 2 }).notNull(),
    totalCost: decimal("total_cost", { precision: 15, scale: 2 }).notNull(),
    profit: decimal("profit", { precision: 15, scale: 2 }).notNull(),
    configuredPrice: decimal("configured_price", { precision: 15, scale: 6 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    voucherIdx: index("sales_items_voucher_idx").on(table.voucherId),
    stockItemVoucherIdx: index("sales_items_stock_item_voucher_idx").on(table.stockItemId, table.voucherId),
  })
);

export const insertSalesItemSchema = createInsertSchema(salesItems)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    voucherId: z.number().min(1, "Voucher is required"),
    stockItemId: z.number().min(1, "Stock item is required"),
    quantity: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, "Quantity must be positive"),
    sellingPrice: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Selling price must be non-negative"),
    costPrice: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Cost price must be non-negative"),
    totalSales: z.string(),
    totalCost: z.string(),
    profit: z.string(),
  });

export type InsertSalesItem = z.infer<typeof insertSalesItemSchema>;
export type SalesItem = typeof salesItems.$inferSelect;
