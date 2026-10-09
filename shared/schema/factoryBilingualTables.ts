import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  decimal,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { locations } from "./common";
import { baleRecodeSessions, customerOrders, customerProformas } from "./factoryBase";
import { isNonNegativeNumeric, isPositiveNumeric } from "../numericString";

// This module owns the bilingual replacements for tables that persist Factory
// catalog names. shared/schema/factory.ts explicitly re-exports these definitions
// over the legacy English-only declarations in factoryBase.ts.

export const factoryCategories = pgTable(
  "factory_categories",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    nameAr: varchar("name_ar", { length: 100 }),
    isActive: boolean("is_active").notNull().default(true),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyName: uniqueIndex("factory_categories_company_name_unique").on(t.companyId, t.name),
  })
);

export const insertFactoryCategorySchema = createInsertSchema(factoryCategories)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    name: z.string().min(1, "Category name is required"),
    nameAr: z.string().optional().nullable(),
    isActive: z.boolean().optional(),
  });

export type InsertFactoryCategory = z.infer<typeof insertFactoryCategorySchema>;
export type FactoryCategory = typeof factoryCategories.$inferSelect;

export const factoryBaleProducts = pgTable(
  "factory_bale_products",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    code: varchar("code", { length: 50 }).notNull(),
    articleCode: varchar("article_code", { length: 50 }),
    name: text("name").notNull(),
    nameAr: text("name_ar"),
    description: text("description"),
    descriptionAr: text("description_ar"),
    weightPerBaleKg: decimal("weight_per_bale_kg", { precision: 10, scale: 2 }),
    categoryId: integer("category_id"),
    sellingPrice: decimal("selling_price", { precision: 20, scale: 2 }).default("0"),
    productionPrice: decimal("production_price", { precision: 20, scale: 2 }).default("0"),
    labelDesignColor: varchar("label_design_color", { length: 20 }),
    active: boolean("active").notNull().default(true),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyCode: uniqueIndex("factory_bale_products_company_code_unique").on(t.companyId, t.code),
    uniqueCompanyArticleCode: uniqueIndex("factory_bale_products_company_article_code_unique").on(
      t.companyId,
      t.articleCode
    ),
    normalizedCompanyArticleCode: index("factory_bale_products_company_article_code_normalized_idx").using(
      "btree",
      t.companyId,
      sql`upper(btrim(${t.articleCode}))`
    ),
  })
);

export const insertFactoryBaleProductSchema = createInsertSchema(factoryBaleProducts)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    code: z.string().optional(),
    articleCode: z.string().optional().nullable(),
    name: z.string().min(1, "Product name is required"),
    nameAr: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    descriptionAr: z.string().optional().nullable(),
    weightPerBaleKg: z.string().optional().nullable(),
    sellingPrice: z.string().optional().nullable(),
    productionPrice: z.string().optional().nullable(),
    categoryId: z.number().optional().nullable(),
    labelDesignColor: z.string().optional().nullable(),
    active: z.boolean().optional(),
  });

export type InsertFactoryBaleProduct = z.infer<typeof insertFactoryBaleProductSchema>;
export type FactoryBaleProduct = typeof factoryBaleProducts.$inferSelect;

export const factoryBales = pgTable(
  "factory_bales",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    mixBatchId: integer("mix_batch_id"),
    productId: integer("product_id"),
    pressingBatchId: integer("pressing_batch_id"),
    erpLocationId: integer("erp_location_id").references(() => locations.id, { onDelete: "restrict" }),
    baleCode: varchar("bale_code", { length: 50 }).notNull(),
    referenceNumber: varchar("reference_number", { length: 100 }).notNull(),
    articleCode: varchar("article_code", { length: 50 }),
    productName: text("product_name"),
    productNameAr: text("product_name_ar"),
    category: text("category"),
    categoryAr: text("category_ar"),
    grade: text("grade"),
    quantity: integer("quantity").notNull().default(1),
    weightKg: decimal("weight_kg", { precision: 15, scale: 3 }).notNull(),
    costPerKg: decimal("cost_per_kg", { precision: 20, scale: 7 }).notNull().default("0"),
    totalCost: decimal("total_cost", { precision: 20, scale: 7 }).notNull().default("0"),
    status: text("status").notNull().default("PENDING_PRESSING"),
    pressedAt: timestamp("pressed_at"),
    finalizedAt: timestamp("finalized_at"),
    finalizedBy: integer("finalized_by"),
    workerName: text("worker_name"),
    stockEntryDate: date("stock_entry_date"),
    importBatchId: integer("import_batch_id"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyRef: uniqueIndex("factory_bales_company_ref_unique").on(t.companyId, t.referenceNumber),
    statusIdx: index("factory_bales_status_idx").on(t.status),
    pressingBatchIdx: index("factory_bales_pressing_batch_idx").on(t.pressingBatchId),
    mixBatchIdx: index("factory_bales_mix_batch_idx").on(t.mixBatchId),
    companyIdx: index("factory_bales_company_idx").on(t.companyId),
    productIdx: index("factory_bales_product_idx").on(t.productId),
    companyStatusIdx: index("factory_bales_company_status_idx").on(t.companyId, t.status),
  })
);

export const insertFactoryBaleSchema = createInsertSchema(factoryBales)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    mixBatchId: z.number().optional().nullable(),
    productId: z.number().optional().nullable(),
    pressingBatchId: z.number().optional().nullable(),
    erpLocationId: z.number().optional().nullable(),
    baleCode: z.string().min(1, "Bale code is required"),
    referenceNumber: z.string().min(1, "Reference number is required"),
    articleCode: z.string().optional().nullable(),
    productName: z.string().optional().nullable(),
    productNameAr: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    categoryAr: z.string().optional().nullable(),
    grade: z.string().optional().nullable(),
    weightKg: z.string().refine(isPositiveNumeric, "Weight must be positive"),
    costPerKg: z.string().optional(),
    totalCost: z.string().optional(),
    status: z
      .enum(["PENDING_PRESSING", "IN_STOCK", "RESERVED_FOR_ORDER", "FINALIZED", "SOLD", "DISPATCHED", "DELETED"])
      .optional(),
    pressedAt: z.string().optional().nullable(),
    finalizedAt: z.string().optional().nullable(),
    finalizedBy: z.number().optional().nullable(),
  });

export type InsertFactoryBale = z.infer<typeof insertFactoryBaleSchema>;
export type FactoryBale = typeof factoryBales.$inferSelect;

export const customerProformaLines = pgTable(
  "customer_proforma_lines",
  {
    id: serial("id").primaryKey(),
    proformaId: integer("proforma_id")
      .notNull()
      .references(() => customerProformas.id, { onDelete: "cascade" }),
    articleCode: varchar("article_code", { length: 50 }).notNull(),
    productName: text("product_name").notNull(),
    productNameAr: text("product_name_ar"),
    quantity: integer("quantity").notNull().default(0),
    pricePerBale: decimal("price_per_bale", { precision: 20, scale: 2 }).notNull(),
    productionPricePerBale: decimal("production_price_per_bale", { precision: 20, scale: 2 }).notNull().default("0"),
    priceFixed: boolean("price_fixed").notNull().default(false),
    pricingMode: text("pricing_mode").notNull().default("per_bale"),
    pricePerKg: decimal("price_per_kg", { precision: 20, scale: 6 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    proformaIdx: index("customer_proforma_lines_proforma_idx").on(t.proformaId),
  })
);

export const insertCustomerProformaLineSchema = createInsertSchema(customerProformaLines)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    proformaId: z.number().min(1, "Proforma is required"),
    articleCode: z.string().min(1, "Article code is required"),
    productName: z.string().min(1, "Product name is required"),
    productNameAr: z.string().optional().nullable(),
    quantity: z.number().int().min(1, "Quantity must be at least 1"),
    pricePerBale: z.string().refine(isNonNegativeNumeric, {
      message: "Price must be non-negative",
    }),
    pricingMode: z.enum(["per_bale", "per_kg"]).optional().default("per_bale"),
    pricePerKg: z.string().optional().nullable(),
  });

export type InsertCustomerProformaLine = z.infer<typeof insertCustomerProformaLineSchema>;
export type CustomerProformaLine = typeof customerProformaLines.$inferSelect;

export const customerOrderLines = pgTable(
  "customer_order_lines",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => customerOrders.id, { onDelete: "cascade" }),
    articleCode: varchar("article_code", { length: 50 }).notNull(),
    baleName: text("bale_name").notNull(),
    baleNameAr: text("bale_name_ar"),
    qty: integer("qty").notNull().default(1),
    weightPerBale: decimal("weight_per_bale", { precision: 15, scale: 3 }).notNull(),
    totalWeight: decimal("total_weight", { precision: 15, scale: 3 }).notNull(),
    pricePerBale: decimal("price_per_bale", { precision: 20, scale: 2 }).notNull(),
    totalPrice: decimal("total_price", { precision: 20, scale: 2 }).notNull(),
    pricingMode: text("pricing_mode").notNull().default("per_bale"),
    pricePerKg: decimal("price_per_kg", { precision: 20, scale: 6 }),
  },
  (t) => ({
    orderIdx: index("customer_order_lines_order_idx").on(t.orderId),
  })
);

export type CustomerOrderLine = typeof customerOrderLines.$inferSelect;

export const customerOrderBales = pgTable(
  "customer_order_bales",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => customerOrders.id, { onDelete: "cascade" }),
    baleId: integer("bale_id").notNull(),
    baleReference: varchar("bale_reference", { length: 100 }).notNull(),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    weight: decimal("weight", { precision: 15, scale: 3 }).notNull(),
    articleCode: varchar("article_code", { length: 50 }),
    baleName: text("bale_name"),
    baleNameAr: text("bale_name_ar"),
    priceUsed: decimal("price_used", { precision: 20, scale: 2 }).notNull(),
    scannedBy: text("scanned_by"),
  },
  (t) => ({
    orderIdx: index("customer_order_bales_order_idx").on(t.orderId),
    baleIdx: index("customer_order_bales_bale_idx").on(t.baleId),
  })
);

export type CustomerOrderBale = typeof customerOrderBales.$inferSelect;

export const customerOrderBalesHistory = pgTable("customer_order_bales_history", {
  id: serial("id").primaryKey(),
  originalId: integer("original_id").notNull(),
  orderId: integer("order_id").notNull(),
  baleId: integer("bale_id").notNull(),
  baleReference: varchar("bale_reference", { length: 100 }).notNull(),
  locationId: integer("location_id").notNull(),
  weight: decimal("weight", { precision: 15, scale: 3 }).notNull(),
  articleCode: varchar("article_code", { length: 50 }),
  baleName: text("bale_name"),
  baleNameAr: text("bale_name_ar"),
  priceUsed: decimal("price_used", { precision: 20, scale: 2 }).notNull(),
  scannedBy: text("scanned_by"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customerOrderExpectedLines = pgTable(
  "customer_order_expected_lines",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    orderId: integer("order_id")
      .notNull()
      .references(() => customerOrders.id, { onDelete: "cascade" }),
    proformaId: integer("proforma_id"),
    proformaLineId: integer("proforma_line_id"),
    articleCode: varchar("article_code", { length: 50 }).notNull(),
    productName: text("product_name"),
    productNameAr: text("product_name_ar"),
    expectedQty: integer("expected_qty").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index("coel_order_idx").on(t.orderId),
    companyIdx: index("coel_company_idx").on(t.companyId),
    orderArticleUnique: uniqueIndex("coel_order_article_unique").on(t.orderId, t.articleCode),
  })
);

export const insertCustomerOrderExpectedLineSchema = createInsertSchema(customerOrderExpectedLines).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCustomerOrderExpectedLine = z.infer<typeof insertCustomerOrderExpectedLineSchema>;
export type CustomerOrderExpectedLine = typeof customerOrderExpectedLines.$inferSelect;

export const factoryPosSaleItems = pgTable(
  "factory_pos_sale_items",
  {
    id: serial("id").primaryKey(),
    saleId: integer("sale_id").notNull(),
    companyId: integer("company_id").notNull(),
    productId: integer("product_id"),
    productName: text("product_name").notNull(),
    productNameAr: text("product_name_ar"),
    articleCode: text("article_code"),
    quantity: integer("quantity").notNull().default(1),
    unitPrice: decimal("unit_price", { precision: 20, scale: 2 }).notNull().default("0"),
    totalAmount: decimal("total_amount", { precision: 20, scale: 2 }).notNull().default("0"),
    currencyCode: varchar("currency_code", { length: 10 }).notNull().default("USD"),
  },
  (t) => ({
    companyIdx: index("factory_pos_sale_items_company_idx").on(t.companyId),
  })
);

export const insertFactoryPosSaleItemSchema = createInsertSchema(factoryPosSaleItems).omit({ id: true });
export type InsertFactoryPosSaleItem = z.infer<typeof insertFactoryPosSaleItemSchema>;
export type FactoryPosSaleItem = typeof factoryPosSaleItems.$inferSelect;

export const customerOrderBaleRemovals = pgTable("customer_order_bale_removals", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .notNull()
    .references(() => customerOrders.id, { onDelete: "cascade" }),
  baleId: integer("bale_id").notNull(),
  referenceNumber: varchar("reference_number", { length: 100 }).notNull(),
  articleCode: varchar("article_code", { length: 50 }),
  productName: text("product_name"),
  productNameAr: text("product_name_ar"),
  weightKg: decimal("weight_kg", { precision: 15, scale: 3 }),
  removedByUserId: varchar("removed_by_user_id"),
  removedByUsername: varchar("removed_by_username"),
  removedAt: timestamp("removed_at").notNull().defaultNow(),
});

export type CustomerOrderBaleRemoval = typeof customerOrderBaleRemovals.$inferSelect;

export const factoryV3LoadBales = pgTable("factory_v3_load_bales", {
  id: serial("id").primaryKey(),
  loadId: integer("load_id").notNull(),
  baleId: integer("bale_id")
    .notNull()
    .references(() => factoryBales.id, { onDelete: "cascade" }),
  baleReference: varchar("bale_reference", { length: 100 }).notNull(),
  articleCode: varchar("article_code", { length: 50 }),
  productName: text("product_name"),
  productNameAr: text("product_name_ar"),
  weightKg: decimal("weight_kg", { precision: 15, scale: 3 }).notNull().default("0"),
  phase: text("phase").notNull().default("scanned"),
  addedBy: varchar("added_by"),
  addedByName: text("added_by_name"),
  addedAt: timestamp("added_at").notNull().defaultNow(),
  removedBy: varchar("removed_by"),
  removedByName: text("removed_by_name"),
  removedAt: timestamp("removed_at"),
  notes: text("notes"),
});

export const insertFactoryV3LoadBaleSchema = createInsertSchema(factoryV3LoadBales).omit({
  id: true,
  addedAt: true,
  removedAt: true,
});

export type FactoryV3LoadBale = typeof factoryV3LoadBales.$inferSelect;
export type InsertFactoryV3LoadBale = z.infer<typeof insertFactoryV3LoadBaleSchema>;

export const factoryInvoiceLoadingBales = pgTable(
  "factory_invoice_loading_bales",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    sessionId: integer("session_id").notNull(),
    invoiceId: integer("invoice_id").notNull(),
    baleId: integer("bale_id").notNull(),
    baleReference: varchar("bale_reference", { length: 100 }).notNull(),
    articleCode: varchar("article_code", { length: 50 }),
    productName: text("product_name"),
    productNameAr: text("product_name_ar"),
    weightKg: decimal("weight_kg", { precision: 15, scale: 3 }).notNull().default("0"),
    scannedAt: timestamp("scanned_at").notNull().defaultNow(),
    scannedBy: varchar("scanned_by", { length: 100 }),
    scannedByName: text("scanned_by_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_invoice_loading_bales_company_idx").on(t.companyId),
    sessionIdx: index("factory_invoice_loading_bales_session_idx").on(t.sessionId),
    invoiceIdx: index("factory_invoice_loading_bales_invoice_idx").on(t.invoiceId),
    baleIdx: index("factory_invoice_loading_bales_bale_idx").on(t.baleId),
  })
);

export const insertFactoryInvoiceLoadingBaleSchema = createInsertSchema(factoryInvoiceLoadingBales).omit({
  id: true,
  scannedAt: true,
  createdAt: true,
});

export type FactoryInvoiceLoadingBale = typeof factoryInvoiceLoadingBales.$inferSelect;
export type InsertFactoryInvoiceLoadingBale = z.infer<typeof insertFactoryInvoiceLoadingBaleSchema>;

export const customerDispatchBaleScans = pgTable(
  "customer_dispatch_bale_scans",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    batchId: integer("batch_id").notNull(),
    truckRideId: integer("truck_ride_id").notNull(),
    baleId: integer("bale_id").notNull(),
    baleReference: varchar("bale_reference", { length: 100 }).notNull(),
    articleCode: varchar("article_code", { length: 50 }),
    productName: text("product_name"),
    productNameAr: text("product_name_ar"),
    weightKg: decimal("weight_kg", { precision: 15, scale: 3 }).notNull().default("0"),
    priceUsed: decimal("price_used", { precision: 20, scale: 2 }).notNull().default("0"),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull().default("0"),
    scannedBy: text("scanned_by"),
    scannedAt: timestamp("scanned_at").notNull().defaultNow(),
    removedAt: timestamp("removed_at"),
    removalReason: text("removal_reason"),
  },
  (t) => ({
    batchIdx: index("cdbs_batch_idx").on(t.batchId),
    rideIdx: index("cdbs_ride_idx").on(t.truckRideId),
    baleIdx: index("cdbs_bale_idx").on(t.baleId),
  })
);

export type CustomerDispatchBaleScan = typeof customerDispatchBaleScans.$inferSelect;

export const baleRecodeItems = pgTable("bale_recode_items", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .notNull()
    .references(() => baleRecodeSessions.id, { onDelete: "cascade" }),
  oldReferenceCode: text("old_reference_code").notNull(),
  newReferenceCode: text("new_reference_code"),
  productName: text("product_name"),
  productNameAr: text("product_name_ar"),
  articleCode: text("article_code"),
  weightKg: text("weight_kg"),
  status: text("status").notNull().default("SUCCESS"),
  errorMessage: text("error_message"),
});

export const insertBaleRecodeItemSchema = createInsertSchema(baleRecodeItems)
  .omit({
    id: true,
  })
  .extend({
    sessionId: z.number().min(1),
    oldReferenceCode: z.string().min(1),
  });

export type InsertBaleRecodeItem = z.infer<typeof insertBaleRecodeItemSchema>;
export type BaleRecodeItem = typeof baleRecodeItems.$inferSelect;
