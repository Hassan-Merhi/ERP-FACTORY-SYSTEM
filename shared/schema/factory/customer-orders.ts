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
import { locations } from "../common";
import { customers, vouchers } from "../erp";

// ─── Customer Proformas ───────────────────────────────────────────────────────
export const customerProformas = pgTable(
  "customer_proformas",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(false),
    status: text("status").notNull().default("ACTIVE"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("customer_proformas_company_idx").on(t.companyId),
    customerCompanyIdx: index("customer_proformas_customer_company_idx").on(t.customerId, t.companyId),
  })
);

export const insertCustomerProformaSchema = createInsertSchema(customerProformas)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    customerId: z.number().min(1, "Customer is required"),
    name: z.string().min(1, "Proforma name is required"),
    isActive: z.boolean().optional(),
    status: z.enum(["ACTIVE", "PARTIALLY_DISPATCHED", "FULLY_INVOICED", "CANCELLED"]).optional(),
  });

export type InsertCustomerProforma = z.infer<typeof insertCustomerProformaSchema>;
export type CustomerProforma = typeof customerProformas.$inferSelect;

// ─── Customer Proforma Lines ──────────────────────────────────────────────────
export const customerProformaLines = pgTable(
  "customer_proforma_lines",
  {
    id: serial("id").primaryKey(),
    proformaId: integer("proforma_id")
      .notNull()
      .references(() => customerProformas.id, { onDelete: "cascade" }),
    articleCode: varchar("article_code", { length: 50 }).notNull(),
    productName: text("product_name").notNull(),
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
    quantity: z.number().int().min(1, "Quantity must be at least 1"),
    pricePerBale: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Price must be non-negative"),
    pricingMode: z.enum(["per_bale", "per_kg"]).optional().default("per_bale"),
    pricePerKg: z.string().optional().nullable(),
  });

export type InsertCustomerProformaLine = z.infer<typeof insertCustomerProformaLineSchema>;
export type CustomerProformaLine = typeof customerProformaLines.$inferSelect;

// ─── Customer Orders ──────────────────────────────────────────────────────────
export const customerOrders = pgTable(
  "customer_orders",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    invoiceNumber: varchar("invoice_number", { length: 50 }),
    orderDate: date("order_date").notNull(),
    proformaIdUsed: integer("proforma_id_used"),
    status: text("status").notNull().default("DRAFT"),
    previousStatus: text("previous_status"),
    subtotalBales: decimal("subtotal_bales", { precision: 20, scale: 2 }).notNull().default("0"),
    freightAmount: decimal("freight_amount", { precision: 20, scale: 2 }).notNull().default("0"),
    otherChargesTotal: decimal("other_charges_total", { precision: 20, scale: 2 }).notNull().default("0"),
    grandTotal: decimal("grand_total", { precision: 20, scale: 2 }).notNull().default("0"),
    totalQtyBales: integer("total_qty_bales").notNull().default(0),
    containerNumber: varchar("container_number", { length: 100 }),
    shippingCompany: varchar("shipping_company", { length: 200 }),
    containerNotes: text("container_notes"),
    destination: text("destination"),
    verifiedByUserId: integer("verified_by_user_id"),
    verifiedAt: timestamp("verified_at"),
    loadingStartedAt: timestamp("loading_started_at"),
    loadingFinalizedAt: timestamp("loading_finalized_at"),
    finalizedAt: timestamp("finalized_at"),
    locationId: integer("location_id").references(() => locations.id, { onDelete: "restrict" }),
    dispatchBatchId: integer("dispatch_batch_id"),
    isHidden: boolean("is_hidden").notNull().default(false),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("customer_orders_company_idx").on(t.companyId),
    customerIdx: index("customer_orders_customer_idx").on(t.customerId),
    statusIdx: index("customer_orders_status_idx").on(t.status),
    invoiceIdx: uniqueIndex("customer_orders_invoice_unique").on(t.companyId, t.invoiceNumber),
  })
);

export const insertCustomerOrderSchema = createInsertSchema(customerOrders)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    customerId: z.number().min(1, "Customer is required"),
    orderDate: z.string().min(1, "Order date is required"),
    proformaIdUsed: z.number().optional().nullable(),
    status: z.enum(["DRAFT", "LOADING", "PENDING_VERIFICATION", "VERIFIED", "FINALIZED", "CANCELLED"]).optional(),
    previousStatus: z.enum(["DRAFT", "LOADING"]).optional().nullable(),
    subtotalBales: z.string().optional(),
    freightAmount: z.string().optional(),
    otherChargesTotal: z.string().optional(),
    grandTotal: z.string().optional(),
    totalQtyBales: z.number().optional(),
    invoiceNumber: z.string().optional().nullable(),
    containerNumber: z.string().optional().nullable(),
    shippingCompany: z.string().optional().nullable(),
    containerNotes: z.string().optional().nullable(),
    destination: z.string().optional().nullable(),
    verifiedByUserId: z.number().optional().nullable(),
    verifiedAt: z.date().optional().nullable(),
    loadingStartedAt: z.date().optional().nullable(),
    loadingFinalizedAt: z.date().optional().nullable(),
    locationId: z.number().optional().nullable(),
  });

export type InsertCustomerOrder = z.infer<typeof insertCustomerOrderSchema>;
export type CustomerOrder = typeof customerOrders.$inferSelect;

// ─── Customer Order Lines ─────────────────────────────────────────────────────
export const customerOrderLines = pgTable(
  "customer_order_lines",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => customerOrders.id, { onDelete: "cascade" }),
    articleCode: varchar("article_code", { length: 50 }).notNull(),
    baleName: text("bale_name").notNull(),
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

// ─── Customer Order Bales ─────────────────────────────────────────────────────
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
    priceUsed: decimal("price_used", { precision: 20, scale: 2 }).notNull(),
    scannedBy: text("scanned_by"),
  },
  (t) => ({
    orderIdx: index("customer_order_bales_order_idx").on(t.orderId),
    baleIdx: index("customer_order_bales_bale_idx").on(t.baleId),
  })
);

export type CustomerOrderBale = typeof customerOrderBales.$inferSelect;

// ─── Customer Order Bales History ─────────────────────────────────────────────
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
  priceUsed: decimal("price_used", { precision: 20, scale: 2 }).notNull(),
  scannedBy: text("scanned_by"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Customer Order Expected Lines ────────────────────────────────────────────
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

// ─── Customer Order Charges ───────────────────────────────────────────────────
export const customerOrderCharges = pgTable(
  "customer_order_charges",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => customerOrders.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
    chargeType: text("charge_type").notNull().default("OTHER"),
    ledgerAccountId: integer("ledger_account_id"),
    voucherId: integer("voucher_id").references(() => vouchers.id, { onDelete: "restrict" }),
  },
  (t) => ({
    orderIdx: index("customer_order_charges_order_idx").on(t.orderId),
  })
);

export type CustomerOrderCharge = typeof customerOrderCharges.$inferSelect;

// ─── Customer Invoice Sequences ───────────────────────────────────────────────
export const customerInvoiceSequences = pgTable(
  "customer_invoice_sequences",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    nextNumber: integer("next_number").notNull().default(1),
  },
  (t) => ({
    uniqueCompanyId: uniqueIndex("customer_invoice_sequences_company_unique").on(t.companyId),
  })
);

export type CustomerInvoiceSequence = typeof customerInvoiceSequences.$inferSelect;
