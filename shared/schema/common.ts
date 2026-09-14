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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  name: text("name").notNull(),
  companyType: text("company_type").notNull().default("erp"),
  parentCompanyId: integer("parent_company_id"),
  active: boolean("active").notNull().default(true),
  baseCurrency: varchar("base_currency", { length: 10 }).default("USD"),
  displayCurrency: varchar("display_currency", { length: 10 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  transferWaGroupChatId: text("transfer_wa_group_chat_id"),
});

export const insertCompanySchema = createInsertSchema(companies)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    code: z.string().min(1, "Code is required"),
    name: z.string().min(1, "Name is required"),
    companyType: z.enum(["erp", "factory", "factory_v2", "properties", "supplier_partner", "retail"]).default("erp"),
    parentCompanyId: z.number().nullable().optional(),
    baseCurrency: z.string().optional(),
    displayCurrency: z.string().optional(),
  });

export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companies.$inferSelect;

export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    fromCurrency: varchar("from_currency", { length: 10 }).notNull(),
    toCurrency: varchar("to_currency", { length: 10 }).notNull(),
    rate: decimal("rate", { precision: 20, scale: 6 }).notNull(),
    effectiveDate: date("effective_date").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("exchange_rates_company_idx").on(t.companyId),
    companyDatePairUnique: uniqueIndex("exchange_rates_company_date_pair_unique").on(
      t.companyId,
      t.effectiveDate,
      t.fromCurrency,
      t.toCurrency
    ),
  })
);

export const insertExchangeRateSchema = createInsertSchema(exchangeRates)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    fromCurrency: z.string().min(1, "From currency is required"),
    toCurrency: z.string().min(1, "To currency is required"),
    rate: z.string().min(1, "Rate is required"),
    effectiveDate: z.string().min(1, "Effective date is required"),
  });

export type InsertExchangeRate = z.infer<typeof insertExchangeRateSchema>;
export type ExchangeRate = typeof exchangeRates.$inferSelect;

export const locations = pgTable(
  "locations",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    code: varchar("code", { length: 50 }).notNull().unique(),
    name: text("name").notNull(),
    city: text("city"),
    state: text("state"),
    country: text("country"),
    active: boolean("active").notNull().default(true),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    whatsappGroupChatId: text("whatsapp_group_chat_id"),
    transferWaGroupChatId: text("transfer_wa_group_chat_id"),
    supplierPartnerPayableDeductionPerQty: decimal("supplier_partner_payable_deduction_per_qty", {
      precision: 20,
      scale: 4,
    })
      .notNull()
      .default("0"),
  },
  (t) => ({
    companyIdx: index("locations_company_idx").on(t.companyId),
  })
);

export const insertLocationSchema = createInsertSchema(locations)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    code: z.string().optional(),
    name: z.string().min(1, "Name is required"),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
  });

export type InsertLocation = z.infer<typeof insertLocationSchema>;
export type Location = typeof locations.$inferSelect;

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  username: text("username").notNull(),
  companyId: integer("company_id"),
  action: text("action").notNull(),
  tableName: text("table_name").notNull(),
  recordId: integer("record_id"),
  recordIdentifier: text("record_identifier"),
  changes: jsonb("changes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type AuditLog = typeof auditLog.$inferSelect;

export const companySettings = pgTable("company_settings", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().unique(),
  logoUrl: text("logo_url"),
  logoFileName: text("logo_file_name"),
  logoUpdatedAt: timestamp("logo_updated_at"),
  invoiceFooter: text("invoice_footer"),
  parentCreditAccountId: integer("parent_credit_account_id"),
  netPositionAdjustment: decimal("net_position_adjustment", { precision: 15, scale: 2 }).default("0"),
  posExcelImportEnabled: boolean("pos_excel_import_enabled").default(false),
  timezone: text("timezone"),
  spPosPayableAccountId: integer("sp_pos_payable_account_id"),
  spPosProfitAccountId: integer("sp_pos_profit_account_id"),
  spPosProfitBaselineDate: date("sp_pos_profit_baseline_date"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCompanySettingsSchema = createInsertSchema(companySettings)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    logoUrl: z.string().optional(),
    logoFileName: z.string().optional(),
    invoiceFooter: z.string().optional(),
    parentCreditAccountId: z.number().nullable().optional(),
    netPositionAdjustment: z.string().optional(),
    posExcelImportEnabled: z.boolean().optional(),
    timezone: z.string().optional(),
    spPosPayableAccountId: z.number().nullable().optional(),
    spPosProfitAccountId: z.number().nullable().optional(),
    spPosProfitBaselineDate: z.string().nullable().optional(),
  });

export type InsertCompanySettings = z.infer<typeof insertCompanySettingsSchema>;
export type CompanySettings = typeof companySettings.$inferSelect;

export const systemSettings = pgTable("system_settings", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 100 }).notNull().unique(),
  value: text("value"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSystemSettingSchema = createInsertSchema(systemSettings)
  .omit({
    id: true,
    updatedAt: true,
  })
  .extend({
    key: z.string().min(1, "Key is required"),
    value: z.string().optional(),
  });

export type InsertSystemSetting = z.infer<typeof insertSystemSettingSchema>;
export type SystemSetting = typeof systemSettings.$inferSelect;

export const FEATURE_KEYS = [
  "dashboard",
  "pos",
  "pos_daybook",
  "stock_items",
  "location_inventory",
  "containers",
  "stock_otw",
  "factory_production",
  "analytics",
  "accounts",
  "suppliers",
  "customers",
  "vouchers",
  "daybook",
  "payroll",
  "create",
  "stock_query",
  "location_summary",
  "sales_report",
  "settings",
  "optional_vouchers",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_PAGE_INFO: Record<FeatureKey, { label: string; group: string }> = {
  dashboard: { label: "Tracking / Overview", group: "Overview" },
  factory_production: { label: "Factory Production", group: "Overview" },
  pos: { label: "Point of Sale", group: "Sales & POS" },
  pos_daybook: { label: "POS Daybook", group: "Sales & POS" },
  location_inventory: { label: "Location Inventory", group: "Inventory" },
  stock_otw: { label: "Stock OTW", group: "Inventory" },
  containers: { label: "Containers", group: "Inventory" },
  stock_items: { label: "Stock Items", group: "Inventory" },
  stock_query: { label: "Stock Query", group: "Inventory" },
  location_summary: { label: "Location Summary", group: "Inventory" },
  optional_vouchers: { label: "Optional Vouchers", group: "Inventory" },
  accounts: { label: "Accounts", group: "Accounting" },
  suppliers: { label: "Suppliers", group: "Accounting" },
  customers: { label: "Customers", group: "Accounting" },
  payroll: { label: "Payroll", group: "Accounting" },
  daybook: { label: "Daybook", group: "Accounting" },
  vouchers: { label: "Vouchers", group: "Vouchers" },
  create: { label: "Create Voucher", group: "Vouchers" },
  sales_report: { label: "Sales Report", group: "Analytics" },
  analytics: { label: "Analytics", group: "Analytics" },
  settings: { label: "Settings", group: "System" },
};

export const FEATURE_ROUTES: Record<FeatureKey, string> = {
  dashboard: "/",
  pos: "/pos",
  pos_daybook: "/pos-daybook",
  stock_items: "/stock-items",
  location_inventory: "/location-inventory",
  containers: "/containers",
  stock_otw: "/stock-otw",
  factory_production: "/factory-production",
  analytics: "/analytics",
  accounts: "/accounts",
  suppliers: "/suppliers",
  customers: "/customers",
  vouchers: "/vouchers",
  daybook: "/daybook",
  payroll: "/payroll",
  create: "/create",
  stock_query: "/stock-query",
  location_summary: "/location-summary",
  sales_report: "/sales-report",
  settings: "/settings",
  optional_vouchers: "/optional-vouchers",
};

export const ROUTE_TO_FEATURE: Record<string, FeatureKey> = Object.fromEntries(
  Object.entries(FEATURE_ROUTES).map(([key, route]) => [route, key as FeatureKey])
) as Record<string, FeatureKey>;
