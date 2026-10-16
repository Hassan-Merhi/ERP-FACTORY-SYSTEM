import {
  pgTable,
  text,
  varchar,
  serial,
  integer,
  decimal,
  date,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const spContainers = pgTable(
  "sp_containers",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    supplierId: integer("supplier_id"),
    supplierName: text("supplier_name").notNull(),
    containerNumber: varchar("container_number", { length: 100 }),
    invoiceNumber: varchar("invoice_number", { length: 100 }).notNull(),
    invoiceDate: date("invoice_date").notNull(),
    invoiceTotalUsd: decimal("invoice_total_usd", { precision: 20, scale: 4 }).notNull().default("0"),
    discountPct: decimal("discount_pct", { precision: 8, scale: 4 }).default("0"),
    // Supplier-invoice charges stated on the container (from the PO Import Excel or
    // typed in). They are part of the invoice total and become landed cost at
    // offload automatically, credited to SP Cost Clearing like the base goods cost.
    freightEstimateUsd: decimal("freight_estimate_usd", { precision: 20, scale: 4 }).default("0"),
    surchargeUsd: decimal("surcharge_usd", { precision: 20, scale: 4 }).default("0"),
    fumigationUsd: decimal("fumigation_usd", { precision: 20, scale: 4 }).default("0"),
    documentChargesUsd: decimal("document_charges_usd", { precision: 20, scale: 4 }).default("0"),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    goodsOtwVoucherId: integer("goods_otw_voucher_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("sp_containers_company_idx").on(t.companyId),
  })
);

export const insertSpContainerSchema = createInsertSchema(spContainers).omit({ id: true, createdAt: true });
export type InsertSpContainer = z.infer<typeof insertSpContainerSchema>;
export type SpContainer = typeof spContainers.$inferSelect;

export const spContainerLines = pgTable(
  "sp_container_lines",
  {
    id: serial("id").primaryKey(),
    containerId: integer("container_id").notNull(),
    companyId: integer("company_id").notNull(),
    articleCode: varchar("article_code", { length: 100 }).notNull(),
    description: text("description"),
    qty: decimal("qty", { precision: 15, scale: 4 }).notNull().default("0"),
    unitRateUsd: decimal("unit_rate_usd", { precision: 20, scale: 4 }).notNull().default("0"),
    stockItemId: integer("stock_item_id"),
  },
  (t) => ({
    containerIdx: index("sp_container_lines_container_idx").on(t.containerId),
  })
);

export const insertSpContainerLineSchema = createInsertSchema(spContainerLines).omit({ id: true });
export type InsertSpContainerLine = z.infer<typeof insertSpContainerLineSchema>;
export type SpContainerLine = typeof spContainerLines.$inferSelect;

export const spPrepaidCharges = pgTable(
  "sp_prepaid_charges",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id"),
    prepaidDate: date("prepaid_date"),
    chargeType: varchar("charge_type", { length: 50 }).notNull(),
    agentName: text("agent_name"),
    amountPaidUsd: decimal("amount_paid_usd", { precision: 20, scale: 4 }).notNull().default("0"),
    amountUsedUsd: decimal("amount_used_usd", { precision: 20, scale: 4 }).notNull().default("0"),
    voucherId: integer("voucher_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    containerIdx: index("sp_prepaid_charges_container_idx").on(t.containerId),
  })
);

export const insertSpPrepaidChargeSchema = createInsertSchema(spPrepaidCharges).omit({ id: true, createdAt: true });
export type InsertSpPrepaidCharge = z.infer<typeof insertSpPrepaidChargeSchema>;
export type SpPrepaidCharge = typeof spPrepaidCharges.$inferSelect;

export const spOffloads = pgTable(
  "sp_offloads",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id").notNull(),
    offloadDate: date("offload_date").notNull(),
    totalQty: decimal("total_qty", { precision: 15, scale: 4 }).notNull().default("0"),
    totalBaseCostUsd: decimal("total_base_cost_usd", { precision: 20, scale: 4 }).notNull().default("0"),
    totalLandedCostUsd: decimal("total_landed_cost_usd", { precision: 20, scale: 4 }).notNull().default("0"),
    totalFinalCostUsd: decimal("total_final_cost_usd", { precision: 20, scale: 4 }).notNull().default("0"),
    voucherIdReversal: integer("voucher_id_reversal"),
    voucherIdStock: integer("voucher_id_stock"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    containerIdx: index("sp_offloads_container_idx").on(t.containerId),
    companyIdx: index("sp_offloads_company_idx").on(t.companyId),
  })
);

export const insertSpOffloadSchema = createInsertSchema(spOffloads).omit({ id: true, createdAt: true });
export type InsertSpOffload = z.infer<typeof insertSpOffloadSchema>;
export type SpOffload = typeof spOffloads.$inferSelect;

export const spOffloadCharges = pgTable(
  "sp_offload_charges",
  {
    id: serial("id").primaryKey(),
    offloadId: integer("offload_id").notNull(),
    companyId: integer("company_id").notNull(),
    chargeType: varchar("charge_type", { length: 50 }).notNull(),
    description: text("description"),
    amountUsd: decimal("amount_usd", { precision: 20, scale: 4 }).notNull().default("0"),
    prepaidChargeId: integer("prepaid_charge_id"),
    creditLedgerAccountId: integer("credit_ledger_account_id"),
    creditBankAccountId: integer("credit_bank_account_id"),
  },
  (t) => ({
    offloadIdx: index("sp_offload_charges_offload_idx").on(t.offloadId),
  })
);

export const insertSpOffloadChargeSchema = createInsertSchema(spOffloadCharges).omit({ id: true });
export type InsertSpOffloadCharge = z.infer<typeof insertSpOffloadChargeSchema>;
export type SpOffloadCharge = typeof spOffloadCharges.$inferSelect;

export const spStockMovements = pgTable(
  "sp_stock_movements",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id"),
    offloadId: integer("offload_id"),
    containerLineId: integer("container_line_id"),
    sourceType: varchar("source_type", { length: 40 }).default("offload"),
    articleCode: varchar("article_code", { length: 100 }).notNull(),
    description: text("description"),
    stockItemId: integer("stock_item_id"),
    locationId: integer("location_id"),
    qtyIn: decimal("qty_in", { precision: 15, scale: 4 }).notNull().default("0"),
    qtyRemaining: decimal("qty_remaining", { precision: 15, scale: 4 }).notNull().default("0"),
    baseUnitCostUsd: decimal("base_unit_cost_usd", { precision: 20, scale: 6 }).notNull().default("0"),
    landedUnitCostUsd: decimal("landed_unit_cost_usd", { precision: 20, scale: 6 }).notNull().default("0"),
    finalUnitCostUsd: decimal("final_unit_cost_usd", { precision: 20, scale: 6 }).notNull().default("0"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("sp_stock_movements_company_idx").on(t.companyId),
    containerIdx: index("sp_stock_movements_container_idx").on(t.containerId),
  })
);

export const insertSpStockMovementSchema = createInsertSchema(spStockMovements).omit({ id: true, createdAt: true });
export type InsertSpStockMovement = z.infer<typeof insertSpStockMovementSchema>;
export type SpStockMovement = typeof spStockMovements.$inferSelect;

export const spSales = pgTable(
  "sp_sales",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    saleDate: date("sale_date").notNull(),
    customerName: text("customer_name").notNull(),
    totalSalePriceUsd: decimal("total_sale_price_usd", { precision: 20, scale: 4 }).notNull().default("0"),
    totalBaseCostUsd: decimal("total_base_cost_usd", { precision: 20, scale: 4 }).notNull().default("0"),
    totalFinalCostUsd: decimal("total_final_cost_usd", { precision: 20, scale: 4 }).notNull().default("0"),
    grossProfitUsd: decimal("gross_profit_usd", { precision: 20, scale: 4 }).notNull().default("0"),
    voucherId: integer("voucher_id"),
    status: varchar("status", { length: 20 }).notNull().default("posted"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("sp_sales_company_idx").on(t.companyId),
  })
);

export const insertSpSaleSchema = createInsertSchema(spSales).omit({ id: true, createdAt: true });
export type InsertSpSale = z.infer<typeof insertSpSaleSchema>;
export type SpSale = typeof spSales.$inferSelect;

export const spSaleLines = pgTable(
  "sp_sale_lines",
  {
    id: serial("id").primaryKey(),
    saleId: integer("sale_id").notNull(),
    companyId: integer("company_id").notNull(),
    movementId: integer("movement_id").notNull(),
    articleCode: varchar("article_code", { length: 100 }).notNull(),
    description: text("description"),
    stockItemId: integer("stock_item_id"),
    qtySold: decimal("qty_sold", { precision: 15, scale: 4 }).notNull().default("0"),
    salePricePerUnit: decimal("sale_price_per_unit", { precision: 20, scale: 4 }).notNull().default("0"),
    baseUnitCostUsd: decimal("base_unit_cost_usd", { precision: 20, scale: 6 }).notNull().default("0"),
    landedUnitCostUsd: decimal("landed_unit_cost_usd", { precision: 20, scale: 6 }).notNull().default("0"),
    finalUnitCostUsd: decimal("final_unit_cost_usd", { precision: 20, scale: 6 }).notNull().default("0"),
  },
  (t) => ({
    saleIdx: index("sp_sale_lines_sale_idx").on(t.saleId),
  })
);

export const insertSpSaleLineSchema = createInsertSchema(spSaleLines).omit({ id: true });
export type InsertSpSaleLine = z.infer<typeof insertSpSaleLineSchema>;
export type SpSaleLine = typeof spSaleLines.$inferSelect;

export const spProfitSplits = pgTable(
  "sp_profit_splits",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    periodMonth: varchar("period_month", { length: 7 }).notNull(),
    totalRevenue: decimal("total_revenue", { precision: 20, scale: 4 }).notNull().default("0"),
    totalCogs: decimal("total_cogs", { precision: 20, scale: 4 }).notNull().default("0"),
    totalSharedCharges: decimal("total_shared_charges", { precision: 20, scale: 4 }).notNull().default("0"),
    grossProfit: decimal("gross_profit", { precision: 20, scale: 4 }).notNull().default("0"),
    splitPct: decimal("split_pct", { precision: 8, scale: 4 }).notNull().default("50"),
    ourShare: decimal("our_share", { precision: 20, scale: 4 }).notNull().default("0"),
    supplierShare: decimal("supplier_share", { precision: 20, scale: 4 }).notNull().default("0"),
    finalizedAt: timestamp("finalized_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyMonthIdx: uniqueIndex("sp_profit_splits_company_month_unique").on(t.companyId, t.periodMonth),
  })
);

export const insertSpProfitSplitSchema = createInsertSchema(spProfitSplits).omit({ id: true, createdAt: true });
export type InsertSpProfitSplit = z.infer<typeof insertSpProfitSplitSchema>;
export type SpProfitSplit = typeof spProfitSplits.$inferSelect;
