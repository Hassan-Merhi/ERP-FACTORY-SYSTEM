/**
 * Phase 1 analytical cost centers shared by ERP and Factory Mode.
 * Neither table posts journals or changes ledger balances.
 * Apply migrations/20261021_001_cost_centers_phase1.sql before use.
 */
import { sql } from "drizzle-orm";
import {
  pgTable, serial, bigserial, bigint, integer, varchar, text, decimal, boolean,
  timestamp, index, uniqueIndex, foreignKey, check,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { companies } from "./common";
import { voucherEntries } from "./erp/vouchers";
import { ledgerAccounts } from "./accounting";
import { factoryDaybookEntries } from "./factory/daybook-fx";

export const costCenters = pgTable("cost_centers", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  code: varchar("code", { length: 50 }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  parentId: integer("parent_id"),
  active: boolean("active").notNull().default(true),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  companyCodeUnique: uniqueIndex("cost_centers_company_code_unique").on(t.companyId, t.code),
  companyIdUnique: uniqueIndex("cost_centers_company_id_unique").on(t.companyId, t.id),
  parentIdx: index("cost_centers_company_parent_idx").on(t.companyId, t.parentId),
  activeIdx: index("cost_centers_company_active_idx").on(t.companyId, t.active),
  parentCompanyFk: foreignKey({
    name: "cost_centers_company_parent_fk",
    columns: [t.companyId, t.parentId],
    foreignColumns: [t.companyId, t.id],
  }).onDelete("restrict"),
  codeNotBlank: check("cost_centers_code_nonblank", sql`length(btrim(${t.code})) > 0`),
  nameNotBlank: check("cost_centers_name_nonblank", sql`length(btrim(${t.name})) > 0`),
  notOwnParent: check("cost_centers_not_self_parent", sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
}));

export const costCenterAllocations = pgTable("cost_center_allocations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  costCenterId: integer("cost_center_id").notNull(),
  voucherEntryId: integer("voucher_entry_id").references(() => voucherEntries.id, { onDelete: "cascade" }),
  factoryDaybookEntryId: integer("factory_daybook_entry_id").references(() => factoryDaybookEntries.id, { onDelete: "cascade" }),
  amountNative: decimal("amount_native", { precision: 20, scale: 6 }).notNull(),
  currency: varchar("currency", { length: 10 }).notNull(),
  amountBase: decimal("amount_base", { precision: 20, scale: 6 }).notNull(),
  baseCurrency: varchar("base_currency", { length: 10 }).notNull().default("USD"),
  historicalRate: decimal("historical_rate", { precision: 20, scale: 10 }),
  rateConvention: varchar("rate_convention", { length: 30 }),
  costTreatment: varchar("cost_treatment", { length: 24 }).notNull().default("EXPENSE"),
  allocationOrigin: varchar("allocation_origin", { length: 12 }).notNull().default("MANUAL"),
  autoRuleId: bigint("auto_rule_id", { mode: "number" }),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  centerCompanyFk: foreignKey({
    name: "cost_center_allocations_cost_center_company_fk",
    columns: [t.companyId, t.costCenterId],
    foreignColumns: [costCenters.companyId, costCenters.id],
  }).onDelete("restrict"),
  companyCenterIdx: index("cost_center_allocations_company_center_idx").on(t.companyId, t.costCenterId),
  voucherEntryIdx: index("cost_center_allocations_voucher_entry_idx").on(t.voucherEntryId)
    .where(sql`${t.voucherEntryId} IS NOT NULL`),
  factoryDaybookIdx: index("cost_center_allocations_factory_daybook_idx").on(t.factoryDaybookEntryId)
    .where(sql`${t.factoryDaybookEntryId} IS NOT NULL`),
  uniqueVoucherCenter: uniqueIndex("cost_center_allocations_voucher_center_unique")
    .on(t.companyId, t.voucherEntryId, t.costCenterId)
    .where(sql`${t.voucherEntryId} IS NOT NULL`),
  uniqueDaybookCenter: uniqueIndex("cost_center_allocations_daybook_center_unique")
    .on(t.companyId, t.factoryDaybookEntryId, t.costCenterId)
    .where(sql`${t.factoryDaybookEntryId} IS NOT NULL`),
  oneSource: check("cost_center_allocations_one_source_check",
    sql`(${t.voucherEntryId} IS NOT NULL AND ${t.factoryDaybookEntryId} IS NULL)
      OR (${t.voucherEntryId} IS NULL AND ${t.factoryDaybookEntryId} IS NOT NULL)`),
  positiveNative: check("cost_center_allocations_native_positive_check", sql`${t.amountNative} > 0`),
  nonnegativeBase: check("cost_center_allocations_base_nonnegative_check", sql`${t.amountBase} >= 0`),
  currenciesNotBlank: check("cost_center_allocations_currency_nonblank_check",
    sql`length(btrim(${t.currency})) > 0 AND length(btrim(${t.baseCurrency})) > 0`),
  positiveRate: check("cost_center_allocations_rate_positive_check",
    sql`${t.historicalRate} IS NULL OR ${t.historicalRate} > 0`),
  treatment: check("cost_center_allocations_treatment_check",
    sql`${t.costTreatment} IN ('EXPENSE', 'INVENTORY_COST', 'OTHER')`),
}));

export const insertCostCenterSchema = createInsertSchema(costCenters)
  .omit({ id: true, createdBy: true, updatedBy: true, createdAt: true, updatedAt: true })
  .extend({
    companyId: z.number().int().positive(),
    code: z.string().trim().min(1).max(50),
    name: z.string().trim().min(1),
    parentId: z.number().int().positive().nullable().optional(),
  });

export const insertCostCenterAllocationSchema = createInsertSchema(costCenterAllocations)
  .omit({ id: true, createdBy: true, updatedBy: true, createdAt: true, updatedAt: true })
  .extend({
    companyId: z.number().int().positive(),
    costCenterId: z.number().int().positive(),
    voucherEntryId: z.number().int().positive().nullable().optional(),
    factoryDaybookEntryId: z.number().int().positive().nullable().optional(),
    amountNative: z.string().refine((v) => Number.isFinite(Number(v)) && Number(v) > 0),
    amountBase: z.string().refine((v) => Number.isFinite(Number(v)) && Number(v) >= 0),
    currency: z.string().trim().min(1).max(10),
    baseCurrency: z.literal("USD").default("USD"),
    historicalRate: z.string().refine((v) => Number.isFinite(Number(v)) && Number(v) > 0).nullable().optional(),
    costTreatment: z.enum(["EXPENSE", "INVENTORY_COST", "OTHER"]).default("EXPENSE"),
  })
  .refine((v) => (v.voucherEntryId != null) !== (v.factoryDaybookEntryId != null),
    "Exactly one source entry is required");

export type CostCenter = typeof costCenters.$inferSelect;
export type InsertCostCenter = z.infer<typeof insertCostCenterSchema>;
export type CostCenterAllocation = typeof costCenterAllocations.$inferSelect;
export type InsertCostCenterAllocation = z.infer<typeof insertCostCenterAllocationSchema>;

/** Phase 5: opt-in, per-company automatic expense rules. */
export const costCenterAutoRules = pgTable("cost_center_auto_rules", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  sourceKind: varchar("source_kind", { length: 24 }).notNull(),
  ledgerAccountId: integer("ledger_account_id").references(() => ledgerAccounts.id, { onDelete: "restrict" }),
  sourceModule: varchar("source_module", { length: 40 }),
  factoryTxType: varchar("factory_tx_type", { length: 40 }),
  costCenterId: integer("cost_center_id").notNull(),
  allocationPercent: decimal("allocation_percent", { precision: 7, scale: 4 }).notNull().default("100"),
  active: boolean("active").notNull().default(true),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  companyCostCenterFk: foreignKey({
    name: "cost_center_auto_rules_center_company_fk",
    columns: [t.companyId, t.costCenterId],
    foreignColumns: [costCenters.companyId, costCenters.id],
  }).onDelete("restrict"),
  lookupIdx: index("cost_center_auto_rules_lookup_idx").on(t.companyId, t.sourceKind, t.ledgerAccountId, t.active),
}));

/** A saved user allocation, including an empty split, permanently wins over automation. */
export const costCenterSourceOverrides = pgTable("cost_center_source_overrides", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  voucherEntryId: integer("voucher_entry_id").references(() => voucherEntries.id, { onDelete: "cascade" }),
  factoryDaybookEntryId: integer("factory_daybook_entry_id").references(() => factoryDaybookEntries.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  overriddenBy: text("overridden_by"),
  overriddenAt: timestamp("overridden_at").notNull().defaultNow(),
}));

export type CostCenterAutoRule = typeof costCenterAutoRules.$inferSelect;
export type CostCenterSourceOverride = typeof costCenterSourceOverrides.$inferSelect;

/** Nonblocking automatic allocation diagnostics; company-scoped by RLS. */
export const costCenterAutoFailures = pgTable("cost_center_auto_failures", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  sourceKind: varchar("source_kind", { length: 24 }).notNull(),
  sourceId: integer("source_id").notNull(),
  lastError: text("last_error").notNull(),
  failureCount: integer("failure_count").notNull().default(1),
  lastSeen: timestamp("last_seen").notNull().defaultNow(),
}, t => ({
  companySourceUnique: uniqueIndex("cost_center_auto_failures_company_source_unique")
    .on(t.companyId,t.sourceKind,t.sourceId),
}));

export type CostCenterAutoFailure = typeof costCenterAutoFailures.$inferSelect;

/** Phase 6: fixed historical USD monthly budgets, never GL postings. */
export const costCenterMonthlyBudgets = pgTable("cost_center_monthly_budgets", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  costCenterId: integer("cost_center_id").notNull(),
  budgetMonth: date("budget_month").notNull(),
  amountUsd: decimal("amount_usd", { precision: 20, scale: 6 }).notNull().default("0"),
  notes: text("notes"),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  companyFk: foreignKey({
    name: "cost_center_monthly_budgets_company_fk",
    columns: [t.companyId,t.costCenterId],
    foreignColumns: [costCenters.companyId,costCenters.id],
  }).onDelete("restrict"),
  uniqueMonth: uniqueIndex("cost_center_monthly_budgets_unique")
    .on(t.companyId,t.costCenterId,t.budgetMonth),
  periodIdx: index("cost_center_monthly_budgets_period_idx").on(t.companyId,t.budgetMonth,t.costCenterId),
  amountCheck: check("cost_center_monthly_budgets_amount_check",sql`${t.amountUsd}>=0`),
}));
export type CostCenterMonthlyBudget = typeof costCenterMonthlyBudgets.$inferSelect;
