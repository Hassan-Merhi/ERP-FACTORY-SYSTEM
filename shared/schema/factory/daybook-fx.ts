import { pgTable, text, varchar, serial, integer, decimal, date, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { isPositiveNumeric } from "../../numericString";

// ─── Factory FX Rates ─────────────────────────────────────────────────────────
export const factoryFxRates = pgTable(
  "factory_fx_rates",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    currencyCode: varchar("currency_code", { length: 10 }).notNull(),
    rateToUsd: decimal("rate_to_usd", { precision: 20, scale: 8 }).notNull(),
    effectiveDate: date("effective_date").notNull(),
    source: varchar("source", { length: 10 }).notNull().default("auto"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyDateIdx: index("factory_fx_rates_company_date_idx").on(t.companyId, t.effectiveDate),
    companyCurrencyIdx: index("factory_fx_rates_company_currency_idx").on(t.companyId, t.currencyCode),
  })
);

export const insertFactoryFxRateSchema = createInsertSchema(factoryFxRates)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    currencyCode: z.string().min(1, "Currency code is required"),
    rateToUsd: z.string().refine(isPositiveNumeric, "Rate must be positive"),
    effectiveDate: z.string().min(1, "Date is required"),
  });

export type InsertFactoryFxRate = z.infer<typeof insertFactoryFxRateSchema>;
export type FactoryFxRate = typeof factoryFxRates.$inferSelect;

// ─── Factory Daybook Entries ──────────────────────────────────────────────────
export const factoryDaybookEntries = pgTable(
  "factory_daybook_entries",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    txDate: date("tx_date").notNull(),
    txType: text("tx_type").notNull(),
    referenceId: integer("reference_id"),
    referenceTable: text("reference_table"),
    description: text("description").notNull(),
    metaJson: text("meta_json"),
    currencyCode: varchar("currency_code", { length: 10 }).notNull().default("USD"),
    amountCurrency: decimal("amount_currency", { precision: 20, scale: 2 }).notNull().default("0"),
    fxRateToUsd: decimal("fx_rate_to_usd", { precision: 20, scale: 8 }).notNull().default("1"),
    amountUsd: decimal("amount_usd", { precision: 20, scale: 2 }).notNull().default("0"),
    effectiveDate: date("effective_date"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: varchar("created_by"),
  },
  (t) => ({
    companyDateIdx: index("factory_daybook_company_date_idx").on(t.companyId, t.txDate),
    txTypeIdx: index("factory_daybook_tx_type_idx").on(t.txType),
  })
);

export const insertFactoryDaybookEntrySchema = createInsertSchema(factoryDaybookEntries)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1),
    txDate: z.string().min(1),
    txType: z.string().min(1),
    description: z.string().min(1),
    currencyCode: z.string().optional(),
    amountCurrency: z.string().optional(),
    fxRateToUsd: z.string().optional(),
    amountUsd: z.string().optional(),
    referenceId: z.number().optional().nullable(),
    referenceTable: z.string().optional().nullable(),
    metaJson: z.string().optional().nullable(),
    createdBy: z.string().optional().nullable(),
    effectiveDate: z.string().optional().nullable(),
  });

export type InsertFactoryDaybookEntry = z.infer<typeof insertFactoryDaybookEntrySchema>;
export type FactoryDaybookEntry = typeof factoryDaybookEntries.$inferSelect;

// ─── Factory Daybook Entry Edits ──────────────────────────────────────────────
export const factoryDaybookEntryEdits = pgTable(
  "factory_daybook_entry_edits",
  {
    id: serial("id").primaryKey(),
    daybookEntryId: integer("daybook_entry_id").notNull(),
    editedAt: timestamp("edited_at").notNull().defaultNow(),
    editedBy: varchar("edited_by"),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    reason: text("reason").notNull(),
  },
  (t) => ({
    entryIdx: index("daybook_edits_entry_idx").on(t.daybookEntryId),
  })
);

export type FactoryDaybookEntryEdit = typeof factoryDaybookEntryEdits.$inferSelect;
