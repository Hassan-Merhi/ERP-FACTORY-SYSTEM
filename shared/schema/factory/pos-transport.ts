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
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { locations } from "../common";
import { ledgerAccounts } from "../accounting";
import { customers, vouchers } from "../erp";
import { customerOrders } from "./customer-orders";

// ─── Factory POS Sales ────────────────────────────────────────────────────────
export const factoryPosSales = pgTable(
  "factory_pos_sales",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    saleNumber: text("sale_number").notNull(),
    txDate: date("tx_date").notNull(),
    locationId: integer("location_id").references(() => locations.id, { onDelete: "restrict" }),
    customerName: text("customer_name"),
    customerId: integer("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    notes: text("notes"),
    totalAmount: decimal("total_amount", { precision: 20, scale: 2 }).notNull().default("0"),
    currencyCode: varchar("currency_code", { length: 10 }).notNull().default("USD"),
    cashAccountId: integer("cash_account_id").references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    paymentType: text("payment_type").notNull().default("CASH"),
    depositAmount: decimal("deposit_amount", { precision: 20, scale: 2 }).default("0"),
    status: text("status").notNull().default("COMPLETED"),
    // users.id is a varchar, and startup migration 002 converts this column to
    // character varying. Declaring it as integer made `drizzle-kit push` fail
    // against any database where that migration had already run.
    createdBy: varchar("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expensesJson: text("expenses_json"),
  },
  (t) => ({
    companyIdx: index("factory_pos_sales_company_idx").on(t.companyId),
  })
);

export const insertFactoryPosSaleSchema = createInsertSchema(factoryPosSales)
  .omit({ id: true, createdAt: true })
  .extend({
    companyId: z.number().min(1),
    saleNumber: z.string().min(1),
    txDate: z.string().min(1),
    totalAmount: z.string().optional(),
    currencyCode: z.string().optional(),
    cashAccountId: z.number().optional().nullable(),
    locationId: z.number().optional().nullable(),
    customerName: z.string().optional().nullable(),
    customerId: z.number().optional().nullable(),
    paymentType: z.string().optional(),
    depositAmount: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    status: z.string().optional(),
    createdBy: z.number().optional().nullable(),
  });
export type InsertFactoryPosSale = z.infer<typeof insertFactoryPosSaleSchema>;
export type FactoryPosSale = typeof factoryPosSales.$inferSelect;

// ─── Factory POS Sale Items ───────────────────────────────────────────────────
export const factoryPosSaleItems = pgTable(
  "factory_pos_sale_items",
  {
    id: serial("id").primaryKey(),
    saleId: integer("sale_id").notNull(),
    companyId: integer("company_id").notNull(),
    productId: integer("product_id"),
    productName: text("product_name").notNull(),
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

// ─── Factory Worker Categories ────────────────────────────────────────────────
export const factoryWorkerCategories = pgTable(
  "factory_worker_categories",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    workerIds: jsonb("worker_ids").notNull().default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_worker_categories_company_idx").on(t.companyId),
  })
);

export const insertFactoryWorkerCategorySchema = createInsertSchema(factoryWorkerCategories)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    name: z.string().min(1),
    workerIds: z.array(z.number()).default([]),
  });
export type InsertFactoryWorkerCategory = z.infer<typeof insertFactoryWorkerCategorySchema>;
export type FactoryWorkerCategory = typeof factoryWorkerCategories.$inferSelect;

// ─── Factory Transporters ─────────────────────────────────────────────────────
export const factoryTransporters = pgTable(
  "factory_transporters",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    name: text("name").notNull(),
    phone: varchar("phone", { length: 50 }),
    notes: text("notes"),
    ledgerAccountId: integer("ledger_account_id"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    byCompany: index("factory_transporters_company_idx").on(t.companyId),
  })
);

export const insertFactoryTransporterSchema = createInsertSchema(factoryTransporters)
  .omit({
    id: true,
    createdAt: true,
    ledgerAccountId: true,
  })
  .extend({
    name: z.string().min(1, "Name is required"),
  });
export type InsertFactoryTransporter = z.infer<typeof insertFactoryTransporterSchema>;
export type FactoryTransporter = typeof factoryTransporters.$inferSelect;

// ─── Factory Transporter Transactions ────────────────────────────────────────
export const factoryTransporterTransactions = pgTable(
  "factory_transporter_transactions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    transporterId: integer("transporter_id").notNull(),
    txType: text("tx_type").notNull(),
    amount: decimal("amount", { precision: 20, scale: 4 }).notNull(),
    txDate: date("tx_date").notNull(),
    description: text("description"),
    expenseAccountId: integer("expense_account_id"),
    cashAccountId: integer("cash_account_id").references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    voucherId: integer("voucher_id").references(() => vouchers.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    byTransporter: index("factory_transporter_tx_idx").on(t.transporterId),
    byCompany: index("factory_transporter_tx_company_idx").on(t.companyId),
  })
);

export const insertFactoryTransporterTransactionSchema = createInsertSchema(factoryTransporterTransactions)
  .omit({
    id: true,
    createdAt: true,
    voucherId: true,
  })
  .extend({
    amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
    txDate: z.string().min(1, "Date is required"),
    txType: z.enum(["charge", "payment"]),
  });
export type InsertFactoryTransporterTransaction = z.infer<typeof insertFactoryTransporterTransactionSchema>;
export type FactoryTransporterTransaction = typeof factoryTransporterTransactions.$inferSelect;

// ─── Location Price Groups — defined in erp.ts, imported here for reference ───
// (do not re-export; erp.ts owns this table)

// ─── Customer Order Bale Removals ─────────────────────────────────────────────
export const customerOrderBaleRemovals = pgTable("customer_order_bale_removals", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .notNull()
    .references(() => customerOrders.id, { onDelete: "cascade" }),
  baleId: integer("bale_id").notNull(),
  referenceNumber: varchar("reference_number", { length: 100 }).notNull(),
  articleCode: varchar("article_code", { length: 50 }),
  productName: text("product_name"),
  weightKg: decimal("weight_kg", { precision: 15, scale: 3 }),
  removedByUserId: varchar("removed_by_user_id"),
  removedByUsername: varchar("removed_by_username"),
  removedAt: timestamp("removed_at").notNull().defaultNow(),
});
export type CustomerOrderBaleRemoval = typeof customerOrderBaleRemovals.$inferSelect;
