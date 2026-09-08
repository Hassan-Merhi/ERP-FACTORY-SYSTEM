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
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { companies, locations } from "../common";
import { customers } from "../erp";
import { containers } from "../containers";

// ─── Bales ───────────────────────────────────────────────────────────────────
export const bales = pgTable(
  "bales",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id").references(() => containers.id, { onDelete: "restrict" }),
    barcode: varchar("barcode", { length: 100 }).notNull(),
    category: text("category").notNull(),
    grade: text("grade").notNull(),
    origin: text("origin").notNull(),
    weight: decimal("weight", { precision: 10, scale: 3 }).notNull(),
    datePressed: date("date_pressed").notNull(),
    price: decimal("price", { precision: 12, scale: 2 }),
    currency: varchar("currency", { length: 3 }).default("USD"),
    customerId: integer("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    soldDate: timestamp("sold_date"),
    status: text("status").notNull().default("AVAILABLE"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyBarcode: uniqueIndex("bales_company_barcode_unique").on(t.companyId, t.barcode),
  })
);

export const insertBaleSchema = createInsertSchema(bales)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    containerId: z.number().optional(),
    barcode: z.string().min(1, "Barcode is required"),
    category: z.string().min(1, "Category is required"),
    grade: z.enum(["A", "B", "C"]),
    origin: z.enum(["EU", "AUS", "USA"]),
    weight: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, "Weight must be positive"),
    datePressed: z.string().min(1, "Date pressed is required"),
    price: z.string().optional(),
    currency: z.string().length(3).optional(),
    status: z.enum(["AVAILABLE", "HOLD", "SOLD"]).optional(),
  });

export type InsertBale = z.infer<typeof insertBaleSchema>;
export type Bale = typeof bales.$inferSelect;

// ─── Pending Barcodes ─────────────────────────────────────────────────────────
export const pendingBarcodes = pgTable(
  "pending_barcodes",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    barcode: varchar("barcode", { length: 100 }).notNull(),
    category: text("category"),
    grade: text("grade"),
    origin: text("origin"),
    printed: boolean("printed").notNull().default(false),
    used: boolean("used").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyPendingBarcode: uniqueIndex("pending_barcodes_company_barcode_unique").on(t.companyId, t.barcode),
  })
);

export const insertPendingBarcodeSchema = createInsertSchema(pendingBarcodes).omit({
  id: true,
  createdAt: true,
});

export type InsertPendingBarcode = z.infer<typeof insertPendingBarcodeSchema>;
export type PendingBarcode = typeof pendingBarcodes.$inferSelect;

// ─── Production Raw Stock ─────────────────────────────────────────────────────
export const productionRawStock = pgTable(
  "production_raw_stock",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "restrict" }),
    receivedKg: decimal("received_kg", { precision: 15, scale: 3 }).notNull(),
    usedKg: decimal("used_kg", { precision: 15, scale: 3 }).notNull().default("0"),
    costPerKg: decimal("cost_per_kg", { precision: 20, scale: 4 }).notNull(),
    offloadedAt: timestamp("offloaded_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyContainer: uniqueIndex("production_raw_stock_company_container_unique").on(t.companyId, t.containerId),
  })
);

export const insertProductionRawStockSchema = createInsertSchema(productionRawStock)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    containerId: z.number().min(1, "Container is required"),
    receivedKg: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, "Received kg must be positive"),
    usedKg: z.string().optional(),
    costPerKg: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Cost per kg must be non-negative"),
  });

export type InsertProductionRawStock = z.infer<typeof insertProductionRawStockSchema>;
export type ProductionRawStock = typeof productionRawStock.$inferSelect;

// ─── Mix Batches ──────────────────────────────────────────────────────────────
export const mixBatches = pgTable(
  "mix_batches",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    batchCode: varchar("batch_code", { length: 50 }).notNull(),
    name: text("name"),
    totalWeightKg: decimal("total_weight_kg", { precision: 15, scale: 3 }).notNull(),
    usedKg: decimal("used_kg", { precision: 15, scale: 3 }).notNull().default("0"),
    costPerKg: decimal("cost_per_kg", { precision: 20, scale: 4 }).notNull(),
    totalCost: decimal("total_cost", { precision: 20, scale: 2 }).notNull(),
    notes: text("notes"),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("mix_batches_company_idx").on(t.companyId),
  })
);

export const insertMixBatchSchema = createInsertSchema(mixBatches)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    batchCode: z.string().optional(),
    name: z.string().optional(),
    totalWeightKg: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, "Total weight must be positive"),
    totalCost: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Total cost must be non-negative"),
    costPerKg: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Cost per kg must be non-negative"),
    usedKg: z.string().optional(),
    status: z.enum(["ACTIVE", "COMPLETED"]).optional(),
  });

export type InsertMixBatch = z.infer<typeof insertMixBatchSchema>;
export type MixBatch = typeof mixBatches.$inferSelect;

// ─── Mix Batch Sources ────────────────────────────────────────────────────────
export const mixBatchSources = pgTable("mix_batch_sources", {
  id: serial("id").primaryKey(),
  mixBatchId: integer("mix_batch_id").notNull(),
  containerId: integer("container_id").references(() => containers.id, { onDelete: "restrict" }),
  sourceBatchId: integer("source_batch_id"),
  weightKg: decimal("weight_kg", { precision: 15, scale: 3 }).notNull(),
  costPerKg: decimal("cost_per_kg", { precision: 20, scale: 2 }).notNull(),
  totalCost: decimal("total_cost", { precision: 20, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertMixBatchSourceSchema = createInsertSchema(mixBatchSources)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    mixBatchId: z.number().min(1, "Mix batch is required"),
    containerId: z.number().optional().nullable(),
    sourceBatchId: z.number().optional().nullable(),
    weightKg: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, "Weight must be positive"),
    costPerKg: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Cost per kg must be non-negative"),
    totalCost: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Total cost must be non-negative"),
  });

export type InsertMixBatchSource = z.infer<typeof insertMixBatchSourceSchema>;
export type MixBatchSource = typeof mixBatchSources.$inferSelect;

// ─── Bale Product Categories ──────────────────────────────────────────────────
export const baleProductCategories = pgTable(
  "bale_product_categories",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyName: uniqueIndex("bale_product_categories_company_name_unique").on(t.companyId, t.name),
  })
);

export const insertBaleProductCategorySchema = createInsertSchema(baleProductCategories)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    name: z.string().min(1, "Category name is required"),
    isActive: z.boolean().optional(),
  });

export type InsertBaleProductCategory = z.infer<typeof insertBaleProductCategorySchema>;
export type BaleProductCategory = typeof baleProductCategories.$inferSelect;

// ─── Bale Products ────────────────────────────────────────────────────────────
export const baleProducts = pgTable(
  "bale_products",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    code: varchar("code", { length: 50 }).notNull(),
    articleCode: varchar("article_code", { length: 50 }),
    name: text("name").notNull(),
    description: text("description"),
    weightPerBaleKg: decimal("weight_per_bale_kg", { precision: 10, scale: 2 }),
    categoryId: integer("category_id"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyCode: uniqueIndex("bale_products_company_code_unique").on(t.companyId, t.code),
    uniqueCompanyArticleCode: uniqueIndex("bale_products_company_article_code_unique").on(t.companyId, t.articleCode),
  })
);

export const insertBaleProductSchema = createInsertSchema(baleProducts)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    code: z.string().optional(),
    articleCode: z.string().min(1, "Article code is required"),
    name: z.string().min(1, "Product name is required"),
    description: z.string().optional(),
    weightPerBaleKg: z.string().optional(),
    categoryId: z.number().optional().nullable(),
    active: z.boolean().optional(),
  });

export type InsertBaleProduct = z.infer<typeof insertBaleProductSchema>;
export type BaleProduct = typeof baleProducts.$inferSelect;

// ─── Bale Sequences ───────────────────────────────────────────────────────────
export const baleSequences = pgTable(
  "bale_sequences",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    nextNumber: integer("next_number").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyId: uniqueIndex("bale_sequences_company_unique").on(t.companyId),
  })
);

export type BaleSequence = typeof baleSequences.$inferSelect;

// ─── Pressing Batches ─────────────────────────────────────────────────────────
export const pressingBatches = pgTable(
  "pressing_batches",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    mixBatchId: integer("mix_batch_id"),
    productId: integer("product_id"),
    expectedCount: integer("expected_count").notNull(),
    status: text("status").notNull().default("PENDING"),
    // users.id is a varchar, and startup migration 002 converts this column to
    // character varying. Declaring it as integer made `drizzle-kit push` fail
    // against any database where that migration had already run.
    createdBy: varchar("created_by"),
    finalizedAt: timestamp("finalized_at"),
    finalizedLocationId: integer("finalized_location_id").references(() => locations.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("pressing_batches_company_idx").on(t.companyId),
  })
);

export const insertPressingBatchSchema = createInsertSchema(pressingBatches).omit({
  id: true,
  createdAt: true,
});

export type InsertPressingBatch = z.infer<typeof insertPressingBatchSchema>;
export type PressingBatch = typeof pressingBatches.$inferSelect;

// ─── Production Bales ─────────────────────────────────────────────────────────
export const productionBales = pgTable(
  "production_bales",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    mixBatchId: integer("mix_batch_id"),
    productId: integer("product_id"),
    locationId: integer("location_id").references(() => locations.id, { onDelete: "restrict" }),
    pressingBatchId: integer("pressing_batch_id"),
    baleCode: varchar("bale_code", { length: 50 }).notNull(),
    barcodeValue: varchar("barcode_value", { length: 100 }).notNull(),
    category: text("category"),
    grade: text("grade"),
    quantity: integer("quantity").notNull().default(1),
    weightKg: decimal("weight_kg", { precision: 15, scale: 3 }).notNull(),
    costPerKg: decimal("cost_per_kg", { precision: 20, scale: 2 }).notNull(),
    totalCost: decimal("total_cost", { precision: 20, scale: 2 }).notNull(),
    warehouseLocation: text("warehouse_location"),
    status: text("status").notNull().default("LABEL_PRINTED"),
    pressedAt: timestamp("pressed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyBarcodeValue: uniqueIndex("production_bales_company_barcode_unique").on(t.companyId, t.barcodeValue),
  })
);

export const insertProductionBaleSchema = createInsertSchema(productionBales)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    mixBatchId: z.number().optional(),
    productId: z.number().optional(),
    baleCode: z.string().min(1, "Bale code is required"),
    barcodeValue: z.string().min(1, "Barcode value is required"),
    category: z.string().optional(),
    grade: z.string().optional(),
    weightKg: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, "Weight must be positive"),
    costPerKg: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Cost per kg must be non-negative"),
    totalCost: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Total cost must be non-negative"),
    warehouseLocation: z.string().optional(),
    status: z.enum(["PENDING", "LABEL_PRINTED", "PRESSED", "IN_STOCK", "RESERVED", "SOLD"]).optional(),
    pressedAt: z.string().optional(),
  });

export type InsertProductionBale = z.infer<typeof insertProductionBaleSchema>;
export type ProductionBale = typeof productionBales.$inferSelect;

// ─── Bale Transfers ───────────────────────────────────────────────────────────
export const baleTransfers = pgTable(
  "bale_transfers",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    sourceLocationId: integer("source_location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    destinationLocationId: integer("destination_location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    transferDate: date("transfer_date").notNull(),
    notes: text("notes"),
    createdBy: varchar("created_by").notNull(),
    updatedBy: varchar("updated_by"),
    status: text("status").notNull().default("PENDING"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("bale_transfers_company_idx").on(t.companyId),
  })
);

export const insertBaleTransferSchema = createInsertSchema(baleTransfers)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    sourceLocationId: z.number().min(1, "Source location is required"),
    destinationLocationId: z.number().min(1, "Destination location is required"),
    transferDate: z.string().min(1, "Transfer date is required"),
    notes: z.string().optional(),
    createdBy: z.string().min(1, "Creator is required"),
    updatedBy: z.string().optional(),
    status: z.enum(["PENDING", "COMPLETED"]).optional(),
  });

export type InsertBaleTransfer = z.infer<typeof insertBaleTransferSchema>;
export type BaleTransfer = typeof baleTransfers.$inferSelect;

// ─── Bale Transfer Items ──────────────────────────────────────────────────────
export const baleTransferItems = pgTable("bale_transfer_items", {
  id: serial("id").primaryKey(),
  transferId: integer("transfer_id").notNull(),
  productionBaleId: integer("production_bale_id").notNull(),
  quantity: integer("quantity").notNull().default(1),
  weightKg: decimal("weight_kg", { precision: 15, scale: 3 }).notNull(),
  costPerKg: decimal("cost_per_kg", { precision: 20, scale: 2 }).notNull(),
  totalCost: decimal("total_cost", { precision: 20, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertBaleTransferItemSchema = createInsertSchema(baleTransferItems)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    transferId: z.number().min(1, "Transfer is required"),
    productionBaleId: z.number().min(1, "Bale is required"),
    quantity: z.number().min(1, "Quantity must be at least 1"),
    weightKg: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, "Weight must be positive"),
    costPerKg: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Cost per kg must be non-negative"),
    totalCost: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Total cost must be non-negative"),
  });

export type InsertBaleTransferItem = z.infer<typeof insertBaleTransferItemSchema>;
export type BaleTransferItem = typeof baleTransferItems.$inferSelect;
