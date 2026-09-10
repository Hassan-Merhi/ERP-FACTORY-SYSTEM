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
import { ledgerAccounts } from "../accounting";
import { factoryContainers, factorySuppliers } from "./suppliers-containers";

// ─── Factory Raw Stock ────────────────────────────────────────────────────────
export const factoryRawStock = pgTable(
  "factory_raw_stock",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id")
      .notNull()
      .references(() => factoryContainers.id, { onDelete: "restrict" }),
    receivedKg: decimal("received_kg", { precision: 15, scale: 3 }).notNull(),
    usedKg: decimal("used_kg", { precision: 15, scale: 3 }).notNull().default("0"),
    // scale 7 — at typical container volumes (20k+ kg) rounding on cost/kg compounds into
    // a multi-dollar swing on the total landed cost, and disagrees with suppliers' own
    // Excel reconciliations computed at full precision. Every cost-per-KG column in the
    // Factory module is 7dp; rates and prices that a user types in stay at 6.
    costPerKg: decimal("cost_per_kg", { precision: 20, scale: 7 }).notNull(),
    costPerKgUsd: decimal("cost_per_kg_usd", { precision: 20, scale: 7 }),
    commissionPersonName: text("commission_person_name"),
    commissionAmount: decimal("commission_amount", { precision: 20, scale: 4 }),
    commissionCurrencyCode: varchar("commission_currency_code", { length: 10 }),
    commissionFxRateToUsd: decimal("commission_fx_rate_to_usd", { precision: 20, scale: 8 }),
    commissionAmountUsd: decimal("commission_amount_usd", { precision: 20, scale: 4 }),
    commissionLedgerAccountId: integer("commission_ledger_account_id"),
    commissionSupplierId: integer("commission_supplier_id").references(() => factorySuppliers.id, {
      onDelete: "restrict",
    }),
    offloadedAt: timestamp("offloaded_at").notNull().defaultNow(),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyContainer: uniqueIndex("factory_raw_stock_company_container_unique").on(t.companyId, t.containerId),
  })
);

export const insertFactoryRawStockSchema = createInsertSchema(factoryRawStock)
  .omit({
    id: true,
    createdAt: true,
    deletedAt: true,
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
    costPerKgUsd: z.string().optional().nullable(),
    commissionPersonName: z.string().optional().nullable(),
    commissionAmount: z.string().optional().nullable(),
    commissionCurrencyCode: z.string().optional().nullable(),
    commissionFxRateToUsd: z.string().optional().nullable(),
    commissionAmountUsd: z.string().optional().nullable(),
    commissionLedgerAccountId: z.number().optional().nullable(),
    commissionSupplierId: z.number().optional().nullable(),
  });

export type InsertFactoryRawStock = z.infer<typeof insertFactoryRawStockSchema>;
export type FactoryRawStock = typeof factoryRawStock.$inferSelect;

// ─── Factory Raw Material Adjustments ────────────────────────────────────────
export const factoryRawMaterialAdjustments = pgTable(
  "factory_raw_material_adjustments",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    date: varchar("date", { length: 20 }).notNull(),
    type: varchar("type", { length: 10 }).notNull(),
    kg: decimal("kg", { precision: 15, scale: 3 }).notNull(),
    costPerKg: decimal("cost_per_kg", { precision: 20, scale: 7 }).default("0"),
    currencyCode: varchar("currency_code", { length: 10 }).default("USD"),
    supplierId: integer("supplier_id").references(() => factorySuppliers.id, { onDelete: "restrict" }),
    materialLabel: varchar("material_label", { length: 200 }),
    notes: text("notes"),
    reference: varchar("reference", { length: 200 }),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    /** Explicit valuation basis for ADD adjustments used by Historical Replay.
     *  QUANTITY_ONLY: adds kg without shifting rate.
     *  VALUED_TRANSFER: adds both kg and USD value to moving average.
     *  OPENING_BALANCE: establishes opening stock quantity and value.
     *  NULL on historical rows with cost → surfaces as ADJUSTMENT_VALUATION_UNCLASSIFIED. */
    valuationBasis: varchar("valuation_basis", { length: 30 }),
  },
  (t) => ({
    companyIdx: index("factory_raw_material_adjustments_company_idx").on(t.companyId),
  })
);

export type FactoryRawMaterialAdjustment = typeof factoryRawMaterialAdjustments.$inferSelect;

// ─── Factory Supplier Payments ────────────────────────────────────────────────
export const factorySupplierPayments = pgTable(
  "factory_supplier_payments",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => factorySuppliers.id, { onDelete: "restrict" }),
    date: varchar("date", { length: 20 }).notNull(),
    amount: decimal("amount", { precision: 20, scale: 4 }).notNull(),
    currencyCode: varchar("currency_code", { length: 10 }).notNull().default("USD"),
    fxRateToUsd: decimal("fx_rate_to_usd", { precision: 20, scale: 8 }).notNull().default("1"),
    amountUsd: decimal("amount_usd", { precision: 20, scale: 4 }).notNull(),
    paidFromAccountId: integer("paid_from_account_id").references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_supplier_payments_company_idx").on(t.companyId),
  })
);

export const insertFactorySupplierPaymentSchema = createInsertSchema(factorySupplierPayments).omit({
  id: true,
  createdAt: true,
});

export type InsertFactorySupplierPayment = z.infer<typeof insertFactorySupplierPaymentSchema>;
export type FactorySupplierPayment = typeof factorySupplierPayments.$inferSelect;

// ─── Factory Supplier FX Transfers ───────────────────────────────────────────
export const factorySupplierFxTransfers = pgTable(
  "factory_supplier_fx_transfers",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    fromSupplierId: integer("from_supplier_id").notNull(),
    toSupplierId: integer("to_supplier_id").notNull(),
    date: varchar("date", { length: 20 }).notNull(),
    fromCurrencyCode: varchar("from_currency_code", { length: 10 }).notNull(),
    fromAmount: decimal("from_amount", { precision: 20, scale: 4 }).notNull(),
    fxRateToUsd: decimal("fx_rate_to_usd", { precision: 20, scale: 8 }).notNull(),
    toAmountUsd: decimal("to_amount_usd", { precision: 20, scale: 4 }).notNull(),
    notes: text("notes"),
    sourceType: text("source_type"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_supplier_fx_transfers_company_idx").on(t.companyId),
  })
);

export const insertFactorySupplierFxTransferSchema = createInsertSchema(factorySupplierFxTransfers).omit({
  id: true,
  createdAt: true,
});

export type InsertFactorySupplierFxTransfer = z.infer<typeof insertFactorySupplierFxTransferSchema>;
export type FactorySupplierFxTransfer = typeof factorySupplierFxTransfers.$inferSelect;

// ─── Factory FX Allocations ───────────────────────────────────────────────────
export const factoryFxAllocations = pgTable(
  "factory_fx_allocations",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    fxTransferId: integer("fx_transfer_id").notNull(),
    containerId: integer("container_id")
      .notNull()
      .references(() => factoryContainers.id, { onDelete: "restrict" }),
    sourceType: varchar("source_type", { length: 20 }).notNull().default("supplier"),
    allocatedAmount: decimal("allocated_amount", { precision: 20, scale: 4 }).notNull(),
    currencyCode: varchar("currency_code", { length: 10 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    fxTransferIdx: index("factory_fx_alloc_transfer_idx").on(t.fxTransferId),
    containerIdx: index("factory_fx_alloc_container_idx").on(t.containerId),
    companyIdx: index("factory_fx_alloc_company_idx").on(t.companyId),
  })
);

export type FactoryFxAllocation = typeof factoryFxAllocations.$inferSelect;

// ─── Factory Mix Batches ──────────────────────────────────────────────────────
export const factoryMixBatches = pgTable(
  "factory_mix_batches",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    batchCode: varchar("batch_code", { length: 50 }).notNull(),
    batchNumber: text("batch_number"),
    name: text("name"),
    totalWeightKg: decimal("total_weight_kg", { precision: 15, scale: 3 }).notNull(),
    usedKg: decimal("used_kg", { precision: 15, scale: 3 }).notNull().default("0"),
    // 7dp, matching factory_mix_batch_sources and factory_bales. The July 2026
    // precision migration ALTERs all three tables to NUMERIC(20,7), but this
    // table's declaration was left at 6dp / 2dp - so whichever ran last decided
    // the column, and `drizzle-kit push` and application boot disagreed about
    // the same database. The migration is the intended value; this now agrees
    // with it. Widening only, so no existing value can be truncated.
    costPerKg: decimal("cost_per_kg", { precision: 20, scale: 7 }).notNull(),
    totalCost: decimal("total_cost", { precision: 20, scale: 7 }).notNull(),
    notes: text("notes"),
    status: text("status").notNull().default("ACTIVE"),
    operatorUser: text("operator_user"),
    batchDate: date("batch_date"),
    carryForwardFromId: integer("carry_forward_from_id"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_mix_batches_company_idx").on(t.companyId),
  })
);

export const insertFactoryMixBatchSchema = createInsertSchema(factoryMixBatches)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
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
    status: z.enum(["ACTIVE", "COMPLETED", "OPEN", "CLOSED", "CARRY_FORWARD"]).optional(),
    operatorUser: z.string().optional().nullable(),
    batchDate: z.string().optional().nullable(),
    carryForwardFromId: z.number().optional().nullable(),
  });

export type InsertFactoryMixBatch = z.infer<typeof insertFactoryMixBatchSchema>;
export type FactoryMixBatch = typeof factoryMixBatches.$inferSelect;

// ─── Factory Mix Batch Sources ────────────────────────────────────────────────
export const factoryMixBatchSources = pgTable("factory_mix_batch_sources", {
  id: serial("id").primaryKey(),
  mixBatchId: integer("mix_batch_id").notNull(),
  containerId: integer("container_id").references(() => factoryContainers.id, { onDelete: "restrict" }),
  supplierId: integer("supplier_id").references(() => factorySuppliers.id, { onDelete: "restrict" }),
  sourceBatchId: integer("source_batch_id"),
  sourceType: text("source_type"),
  sourceId: integer("source_id"),
  weightKg: decimal("weight_kg", { precision: 15, scale: 3 }).notNull(),
  quantityKg: decimal("quantity_kg", { precision: 15, scale: 3 }),
  costPerKg: decimal("cost_per_kg", { precision: 20, scale: 7 }).notNull(),
  totalCost: decimal("total_cost", { precision: 20, scale: 7 }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  /** Explicit inventory ownership: which supplier's raw-material kg were consumed.
   *  NULL for BATCH sources (upstream batch already deducted quantities).
   *  NULL when no supplier can be resolved (reported as INVENTORY_SUPPLIER_UNRESOLVED). */
  inventorySupplierId: integer("inventory_supplier_id").references(() => factorySuppliers.id, { onDelete: "restrict" }),
});

export const insertFactoryMixBatchSourceSchema = createInsertSchema(factoryMixBatchSources)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    mixBatchId: z.number().min(1, "Mix batch is required"),
    containerId: z.number().optional().nullable(),
    supplierId: z.number().optional().nullable(),
    sourceBatchId: z.number().optional().nullable(),
    weightKg: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, "Weight must be positive"),
    costPerKg: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Cost per kg must be non-negative"),
    totalCost: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Total cost must be non-negative"),
  });

export type InsertFactoryMixBatchSource = z.infer<typeof insertFactoryMixBatchSourceSchema>;
export type FactoryMixBatchSource = typeof factoryMixBatchSources.$inferSelect;

// ─── Factory Daily Usages ─────────────────────────────────────────────────────
export const factoryDailyUsages = pgTable(
  "factory_daily_usages",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    mixBatchId: integer("mix_batch_id").notNull(),
    kgUsed: decimal("kg_used", { precision: 15, scale: 3 }).notNull(),
    operatorUser: text("operator_user"),
    usedDate: date("used_date").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_daily_usages_company_idx").on(t.companyId),
  })
);

export const insertFactoryDailyUsageSchema = createInsertSchema(factoryDailyUsages).omit({
  id: true,
  createdAt: true,
});

export type InsertFactoryDailyUsage = z.infer<typeof insertFactoryDailyUsageSchema>;
export type FactoryDailyUsage = typeof factoryDailyUsages.$inferSelect;

// ─── Factory Pressing Batches ─────────────────────────────────────────────────
export const factoryPressingBatches = pgTable(
  "factory_pressing_batches",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    mixBatchId: integer("mix_batch_id"),
    productId: integer("product_id"),
    expectedCount: integer("expected_count").notNull(),
    status: text("status").notNull().default("PENDING"),
    notes: text("notes"),
    // users.id is a varchar, and startup migration 002 converts this column to
    // character varying. Declaring it as integer made `drizzle-kit push` fail
    // against any database where that migration had already run.
    createdBy: varchar("created_by"),
    finalizedAt: timestamp("finalized_at"),
    finalizedLocationId: integer("finalized_location_id").references(() => locations.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_pressing_batches_company_idx").on(t.companyId),
  })
);

export const insertFactoryPressingBatchSchema = createInsertSchema(factoryPressingBatches).omit({
  id: true,
  createdAt: true,
});

export type InsertFactoryPressingBatch = z.infer<typeof insertFactoryPressingBatchSchema>;
export type FactoryPressingBatch = typeof factoryPressingBatches.$inferSelect;

// ─── Factory Bales ────────────────────────────────────────────────────────────
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
    category: text("category"),
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
    category: z.string().optional().nullable(),
    grade: z.string().optional().nullable(),
    weightKg: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, "Weight must be positive"),
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

// ─── Factory Bale Sequences ───────────────────────────────────────────────────
export const factoryBaleSequences = pgTable(
  "factory_bale_sequences",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    nextNumber: integer("next_number").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyId: uniqueIndex("factory_bale_sequences_company_unique").on(t.companyId),
  })
);

export type FactoryBaleSequence = typeof factoryBaleSequences.$inferSelect;

// ─── Factory Bale Import Batches ──────────────────────────────────────────────
export const factoryBaleImportBatches = pgTable(
  "factory_bale_import_batches",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    fileName: text("file_name").notNull(),
    baleCount: integer("bale_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    totalWeightKg: decimal("total_weight_kg", { precision: 15, scale: 3 }).notNull().default("0"),
    importedByUserId: varchar("imported_by_user_id", { length: 100 }),
    importedByName: text("imported_by_name"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_bale_import_batches_company_idx").on(t.companyId),
  })
);

export const insertFactoryBaleImportBatchSchema = createInsertSchema(factoryBaleImportBatches).omit({
  id: true,
  createdAt: true,
});

export type InsertFactoryBaleImportBatch = z.infer<typeof insertFactoryBaleImportBatchSchema>;
export type FactoryBaleImportBatch = typeof factoryBaleImportBatches.$inferSelect;

// ─── Factory Container Commissions ───────────────────────────────────────────
export const factoryContainerCommissions = pgTable(
  "factory_container_commissions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id")
      .notNull()
      .references(() => factoryContainers.id, { onDelete: "restrict" }),
    personName: text("person_name").notNull(),
    commissionType: text("commission_type").notNull().default("PER_KG"),
    commissionRate: decimal("commission_rate", { precision: 20, scale: 6 }).notNull(),
    commissionTotal: decimal("commission_total", { precision: 20, scale: 4 }).notNull(),
    currencyCode: varchar("currency_code", { length: 10 }).notNull().default("USD"),
    fxRateToUsd: decimal("fx_rate_to_usd", { precision: 20, scale: 8 }).notNull().default("1"),
    fxRateConfirmed: boolean("fx_rate_confirmed").notNull().default(false),
    commissionTotalUsd: decimal("commission_total_usd", { precision: 20, scale: 4 }),
    ledgerAccountId: integer("ledger_account_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    containerIdx: index("factory_container_commissions_container_idx").on(t.containerId),
    companyIdx: index("factory_container_commissions_company_idx").on(t.companyId),
  })
);

export type FactoryContainerCommission = typeof factoryContainerCommissions.$inferSelect;

// ─── Factory Duty Audit Log ───────────────────────────────────────────────────
export const factoryDutyAuditLog = pgTable(
  "factory_duty_audit_log",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id")
      .notNull()
      .references(() => factoryContainers.id, { onDelete: "restrict" }),
    oldDutyAmount: decimal("old_duty_amount", { precision: 20, scale: 2 }),
    newDutyAmount: decimal("new_duty_amount", { precision: 20, scale: 2 }).notNull(),
    oldDutyStatus: text("old_duty_status"),
    newDutyStatus: text("new_duty_status").notNull(),
    notes: text("notes"),
    updatedByUserId: text("updated_by_user_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_duty_audit_log_company_idx").on(t.companyId),
  })
);

export type FactoryDutyAuditLog = typeof factoryDutyAuditLog.$inferSelect;
