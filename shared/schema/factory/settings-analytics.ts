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
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { factoryBales } from "./raw-stock-mix";
import { factoryContainers, factorySuppliers } from "./suppliers-containers";

// ─── Factory Settings ─────────────────────────────────────────────────────────
export const factorySettings = pgTable(
  "factory_settings",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    dashboardEnabled: boolean("dashboard_enabled").notNull().default(false),
    kpisEnabled: boolean("kpis_enabled").notNull().default(false),
    profitabilityEnabled: boolean("profitability_enabled").notNull().default(false),
    alertsEnabled: boolean("alerts_enabled").notNull().default(false),
    supplierScoringEnabled: boolean("supplier_scoring_enabled").notNull().default(false),
    mixOptimizerEnabled: boolean("mix_optimizer_enabled").notNull().default(false),
    traceabilityEnabled: boolean("traceability_enabled").notNull().default(false),
    balePhotosEnabled: boolean("bale_photos_enabled").notNull().default(false),
    wasteTrackingEnabled: boolean("waste_tracking_enabled").notNull().default(false),
    cashflowEnabled: boolean("cashflow_enabled").notNull().default(false),
    rolesEnabled: boolean("roles_enabled").notNull().default(false),
    netProfitEnabled: boolean("net_profit_enabled").notNull().default(false),
    productionSummaryEnabled: boolean("production_summary_enabled").notNull().default(false),
    supplierReportEnabled: boolean("supplier_report_enabled").notNull().default(false),
    supplierStatementEnabled: boolean("supplier_statement_enabled").notNull().default(false),
    laborCostPerKg: decimal("labor_cost_per_kg", { precision: 10, scale: 6 }).default("0"),
    overheadPerKg: decimal("overhead_per_kg", { precision: 10, scale: 6 }).default("0"),
    hideSellingPrice: boolean("hide_selling_price").notNull().default(false),
    hideAvgCost: boolean("hide_avg_cost").notNull().default(false),
    extraSettings: jsonb("extra_settings").default({}),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyUnique: uniqueIndex("factory_settings_company_unique").on(t.companyId),
  })
);

export const insertFactorySettingsSchema = createInsertSchema(factorySettings).omit({
  id: true,
  updatedAt: true,
});

export type InsertFactorySettings = z.infer<typeof insertFactorySettingsSchema>;
export type FactorySettings = typeof factorySettings.$inferSelect;

// ─── Factory Alerts ───────────────────────────────────────────────────────────
export const factoryAlerts = pgTable(
  "factory_alerts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    type: varchar("type", { length: 50 }).notNull(),
    severity: varchar("severity", { length: 20 }).notNull().default("info"),
    title: varchar("title", { length: 255 }).notNull(),
    message: text("message"),
    entityType: varchar("entity_type", { length: 50 }),
    entityId: integer("entity_id"),
    isRead: boolean("is_read").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_alerts_company_idx").on(t.companyId),
    readIdx: index("factory_alerts_read_idx").on(t.companyId, t.isRead),
  })
);

export const insertFactoryAlertSchema = createInsertSchema(factoryAlerts).omit({
  id: true,
  createdAt: true,
});

export type InsertFactoryAlert = z.infer<typeof insertFactoryAlertSchema>;
export type FactoryAlert = typeof factoryAlerts.$inferSelect;

// ─── Factory Waste Entries ────────────────────────────────────────────────────
export const factoryWasteEntries = pgTable(
  "factory_waste_entries",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    date: date("date").notNull(),
    mixBatchId: integer("mix_batch_id"),
    supplierId: integer("supplier_id").references(() => factorySuppliers.id, { onDelete: "restrict" }),
    containerId: integer("container_id").references(() => factoryContainers.id, { onDelete: "restrict" }),
    wasteType: varchar("waste_type", { length: 50 }),
    kgWaste: decimal("kg_waste", { precision: 15, scale: 3 }).notNull(),
    reason: text("reason"),
    // users.id is a varchar, and startup migration 002 converts this column to
    // character varying. Declaring it as integer made `drizzle-kit push` fail
    // against any database where that migration had already run.
    createdBy: varchar("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_waste_company_idx").on(t.companyId),
    dateIdx: index("factory_waste_date_idx").on(t.companyId, t.date),
  })
);

export const insertFactoryWasteEntrySchema = createInsertSchema(factoryWasteEntries).omit({
  id: true,
  createdAt: true,
});

export type InsertFactoryWasteEntry = z.infer<typeof insertFactoryWasteEntrySchema>;
export type FactoryWasteEntry = typeof factoryWasteEntries.$inferSelect;

// ─── Factory Bale Photos ──────────────────────────────────────────────────────
export const factoryBalePhotos = pgTable(
  "factory_bale_photos",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    baleId: integer("bale_id")
      .notNull()
      .references(() => factoryBales.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    fileName: varchar("file_name", { length: 255 }),
    uploadedBy: varchar("uploaded_by"),
    uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  },
  (t) => ({
    baleIdx: index("factory_bale_photos_bale_idx").on(t.baleId),
    companyIdx: index("factory_bale_photos_company_idx").on(t.companyId),
  })
);

export const insertFactoryBalePhotoSchema = createInsertSchema(factoryBalePhotos).omit({
  id: true,
  uploadedAt: true,
});

export type InsertFactoryBalePhoto = z.infer<typeof insertFactoryBalePhotoSchema>;
export type FactoryBalePhoto = typeof factoryBalePhotos.$inferSelect;

// ─── Factory Bale Product Images ──────────────────────────────────────────────
export const factoryBaleProductImages = pgTable(
  "factory_bale_product_images",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    articleCode: varchar("article_code", { length: 50 }).notNull(),
    productId: integer("product_id"),
    url: text("url").notNull(),
    fileName: varchar("file_name", { length: 255 }),
    sortOrder: integer("sort_order").default(0),
    uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_bale_product_images_company_idx").on(t.companyId),
    articleCodeIdx: index("factory_bale_product_images_article_code_idx").on(t.articleCode),
  })
);

export type FactoryBaleProductImage = typeof factoryBaleProductImages.$inferSelect;

// ─── Factory Daily KPI Snapshots ──────────────────────────────────────────────
export const factoryDailyKpiSnapshots = pgTable(
  "factory_daily_kpi_snapshots",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    date: date("date").notNull(),
    totalKgIn: decimal("total_kg_in", { precision: 15, scale: 3 }).default("0"),
    totalKgPressed: decimal("total_kg_pressed", { precision: 15, scale: 3 }).default("0"),
    totalBalesProduced: integer("total_bales_produced").default(0),
    totalWasteKg: decimal("total_waste_kg", { precision: 15, scale: 3 }).default("0"),
    topWorkerId: integer("top_worker_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyDateUnique: uniqueIndex("factory_kpi_company_date_unique").on(t.companyId, t.date),
  })
);

export const insertFactoryDailyKpiSnapshotSchema = createInsertSchema(factoryDailyKpiSnapshots).omit({
  id: true,
  createdAt: true,
});

export type InsertFactoryDailyKpiSnapshot = z.infer<typeof insertFactoryDailyKpiSnapshotSchema>;
export type FactoryDailyKpiSnapshot = typeof factoryDailyKpiSnapshots.$inferSelect;

// ─── Factory Supplier Score Snapshots ────────────────────────────────────────
export const factorySupplierScoreSnapshots = pgTable(
  "factory_supplier_score_snapshots",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => factorySuppliers.id, { onDelete: "restrict" }),
    fromDate: date("from_date").notNull(),
    toDate: date("to_date").notNull(),
    totalKg: decimal("total_kg", { precision: 15, scale: 3 }).default("0"),
    wasteKg: decimal("waste_kg", { precision: 15, scale: 3 }).default("0"),
    wastePct: decimal("waste_pct", { precision: 8, scale: 2 }).default("0"),
    avgCostPerKg: decimal("avg_cost_per_kg", { precision: 12, scale: 4 }).default("0"),
    outputBales: integer("output_bales").default(0),
    score0to100: integer("score_0_to_100").default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companySupplierIdx: index("factory_supplier_score_company_idx").on(t.companyId, t.supplierId),
  })
);

export const insertFactorySupplierScoreSnapshotSchema = createInsertSchema(factorySupplierScoreSnapshots).omit({
  id: true,
  createdAt: true,
});

export type InsertFactorySupplierScoreSnapshot = z.infer<typeof insertFactorySupplierScoreSnapshotSchema>;
export type FactorySupplierScoreSnapshot = typeof factorySupplierScoreSnapshots.$inferSelect;

// ─── Factory Bale Cost Snapshots ──────────────────────────────────────────────
export const factoryBaleCostSnapshots = pgTable(
  "factory_bale_cost_snapshots",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    baleId: integer("bale_id")
      .notNull()
      .references(() => factoryBales.id, { onDelete: "cascade" }),
    materialCost: decimal("material_cost", { precision: 15, scale: 4 }).default("0"),
    laborCost: decimal("labor_cost", { precision: 15, scale: 4 }).default("0"),
    overheadCost: decimal("overhead_cost", { precision: 15, scale: 4 }).default("0"),
    freightAllocated: decimal("freight_allocated", { precision: 15, scale: 4 }).default("0"),
    totalCost: decimal("total_cost", { precision: 15, scale: 4 }).default("0"),
    salePrice: decimal("sale_price", { precision: 15, scale: 4 }),
    profit: decimal("profit", { precision: 15, scale: 4 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    baleIdx: index("factory_bale_cost_bale_idx").on(t.baleId),
    companyIdx: index("factory_bale_cost_company_idx").on(t.companyId),
  })
);

export const insertFactoryBaleCostSnapshotSchema = createInsertSchema(factoryBaleCostSnapshots).omit({
  id: true,
  createdAt: true,
});

export type InsertFactoryBaleCostSnapshot = z.infer<typeof insertFactoryBaleCostSnapshotSchema>;
export type FactoryBaleCostSnapshot = typeof factoryBaleCostSnapshots.$inferSelect;

// ─── Factory Container Profit Snapshots ───────────────────────────────────────
export const factoryContainerProfitSnapshots = pgTable(
  "factory_container_profit_snapshots",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id")
      .notNull()
      .references(() => factoryContainers.id, { onDelete: "cascade" }),
    totalRevenue: decimal("total_revenue", { precision: 20, scale: 4 }).default("0"),
    totalCost: decimal("total_cost", { precision: 20, scale: 4 }).default("0"),
    profit: decimal("profit", { precision: 20, scale: 4 }).default("0"),
    marginPct: decimal("margin_pct", { precision: 8, scale: 2 }).default("0"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    containerIdx: index("factory_container_profit_container_idx").on(t.containerId),
    companyIdx: index("factory_container_profit_company_idx").on(t.companyId),
  })
);

export const insertFactoryContainerProfitSnapshotSchema = createInsertSchema(factoryContainerProfitSnapshots).omit({
  id: true,
  createdAt: true,
});

export type InsertFactoryContainerProfitSnapshot = z.infer<typeof insertFactoryContainerProfitSnapshotSchema>;
export type FactoryContainerProfitSnapshot = typeof factoryContainerProfitSnapshots.$inferSelect;

// ─── Factory User Profiles ────────────────────────────────────────────────────
export const factoryUserProfiles = pgTable(
  "factory_user_profiles",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    userId: varchar("user_id").notNull(),
    displayName: text("display_name").notNull(),
    hasErpAccess: boolean("has_erp_access").notNull().default(true),
    hasFactoryAccess: boolean("has_factory_access").notNull().default(true),
    hiddenCostFields: text("hidden_cost_fields").array().notNull().default([]),
    hideAllCosts: boolean("hide_all_costs").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyUser: uniqueIndex("factory_user_profiles_unique").on(t.companyId, t.userId),
  })
);

export const insertFactoryUserProfileSchema = createInsertSchema(factoryUserProfiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertFactoryUserProfile = z.infer<typeof insertFactoryUserProfileSchema>;
export type FactoryUserProfile = typeof factoryUserProfiles.$inferSelect;

// ─── Factory User Page Access ─────────────────────────────────────────────────
export const factoryUserPageAccess = pgTable(
  "factory_user_page_access",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    userId: varchar("user_id").notNull(),
    pageKey: text("page_key").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyUserPage: uniqueIndex("factory_user_page_access_unique").on(t.companyId, t.userId, t.pageKey),
  })
);

export const insertFactoryUserPageAccessSchema = createInsertSchema(factoryUserPageAccess).omit({
  id: true,
  createdAt: true,
});

export type InsertFactoryUserPageAccess = z.infer<typeof insertFactoryUserPageAccessSchema>;
export type FactoryUserPageAccess = typeof factoryUserPageAccess.$inferSelect;

// ─── Factory Bale Waste Dispatches ───────────────────────────────────────────
export const factoryBaleWasteDispatches = pgTable(
  "factory_bale_waste_dispatches",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    dispatchNumber: text("dispatch_number").notNull(),
    dispatchDate: date("dispatch_date").notNull(),
    notes: text("notes"),
    totalBales: integer("total_bales").notNull().default(0),
    totalWeightKg: decimal("total_weight_kg", { precision: 15, scale: 3 }).notNull().default("0"),
    totalCostWrittenOff: decimal("total_cost_written_off", { precision: 15, scale: 2 }).notNull().default("0"),
    // users.id is a varchar, and startup migration 002 converts this column to
    // character varying on any database that still has the original integer.
    // Declaring it as integer contradicted both, so a `drizzle-kit push` could
    // try to convert a live varchar column back to integer.
    createdBy: varchar("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_bale_waste_dispatches_company_idx").on(t.companyId),
  })
);

export const insertFactoryBaleWasteDispatchSchema = createInsertSchema(factoryBaleWasteDispatches).omit({
  id: true,
  createdAt: true,
});
export type InsertFactoryBaleWasteDispatch = z.infer<typeof insertFactoryBaleWasteDispatchSchema>;
export type FactoryBaleWasteDispatch = typeof factoryBaleWasteDispatches.$inferSelect;
