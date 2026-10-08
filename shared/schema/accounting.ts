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

const openingBalanceCurrencySchema = z.enum(["USD", "CFA"]).nullable().optional();
const nullableDecimalString = z.string().nullable().optional();

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    code: varchar("code", { length: 50 }).notNull(),
    name: text("name").notNull(),
    accountType: text("account_type").notNull(),
    subType: text("sub_type"),
    parentId: integer("parent_id"),
    // Backward-compatible historical company-base amount.
    openingBalance: decimal("opening_balance", { precision: 20, scale: 2 }).default("0"),
    openingBalanceSide: text("opening_balance_side"),
    openingBalanceNativeAmount: decimal("opening_balance_native_amount", { precision: 20, scale: 6 }),
    openingBalanceCurrency: varchar("opening_balance_currency", { length: 10 }),
    openingBalanceHistoricalRate: decimal("opening_balance_historical_rate", { precision: 20, scale: 10 }),
    openingBalanceBaseAmount: decimal("opening_balance_base_amount", { precision: 20, scale: 6 }),
    active: boolean("active").notNull().default(true),
    isHidden: boolean("is_hidden").notNull().default(false),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyCode: uniqueIndex("ledger_accounts_company_code_unique").on(t.companyId, t.code),
    companyDeletedCodeIdx: index("ledger_accounts_company_deleted_code_idx").on(t.companyId, t.deletedAt, t.code),
    companyTypeIdx: index("ledger_accounts_company_type_idx").on(t.companyId, t.accountType),
  })
);

export const insertLedgerAccountSchema = createInsertSchema(ledgerAccounts)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    code: z.string().optional(),
    name: z
      .string()
      .min(1, "Name is required")
      .refine((val) => val.trim().length > 0, "Name cannot be only whitespace"),
    accountType: z.enum([
      "Asset",
      "Liability",
      "Equity",
      "Income",
      "Expense",
      "Bank",
      "Cash",
      "Indirect Expense",
      "Direct Expense",
      "Government Taxes",
      "Loans",
      "Duty Agent",
      "Transporter Agent",
      "Accounts Payable",
      "Profit",
      // Stored by bulk payroll (deduction recoveries) and read as income by
      // every report (accountClassification.ts). "Intercompany" is left out on
      // purpose: those accounts are created only by the Golden Coast / SP setup,
      // which resolves them by subType and refuses a duplicate, so letting the
      // generic ledger route create one would break those postings.
      "Indirect Income",
    ]),
    subType: z.string().nullable().optional(),
    openingBalance: z.string().optional(),
    openingBalanceSide: z.enum(["Dr", "Cr"]).optional().or(z.literal("")),
    openingBalanceNativeAmount: nullableDecimalString,
    openingBalanceCurrency: openingBalanceCurrencySchema,
    openingBalanceHistoricalRate: nullableDecimalString,
    openingBalanceBaseAmount: nullableDecimalString,
    parentId: z.number().nullable().optional(),
  });

export const updateLedgerAccountSchema = insertLedgerAccountSchema
  .partial()
  .extend({
    id: z.number().min(1, "Account ID is required"),
  })
  .required({ id: true });

export type InsertLedgerAccount = z.infer<typeof insertLedgerAccountSchema>;
export type UpdateLedgerAccount = z.infer<typeof updateLedgerAccountSchema>;
export type LedgerAccount = typeof ledgerAccounts.$inferSelect;

export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    code: varchar("code", { length: 50 }).notNull().unique(),
    name: text("name").notNull(),
    bankName: text("bank_name").notNull(),
    accountNumber: text("account_number").notNull(),
    routingCode: text("routing_code"),
    linkedLedgerId: integer("linked_ledger_id"),
    // Backward-compatible historical company-base amount.
    openingBalance: decimal("opening_balance", { precision: 15, scale: 2 }).default("0"),
    openingBalanceSide: text("opening_balance_side"),
    openingBalanceNativeAmount: decimal("opening_balance_native_amount", { precision: 20, scale: 6 }),
    openingBalanceCurrency: varchar("opening_balance_currency", { length: 10 }),
    openingBalanceHistoricalRate: decimal("opening_balance_historical_rate", { precision: 20, scale: 10 }),
    openingBalanceBaseAmount: decimal("opening_balance_base_amount", { precision: 20, scale: 6 }),
    active: boolean("active").notNull().default(true),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("bank_accounts_company_idx").on(t.companyId),
  })
);

export const insertBankAccountSchema = createInsertSchema(bankAccounts)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    code: z.string().min(1, "Code is required"),
    name: z.string().min(1, "Name is required"),
    bankName: z.string().min(1, "Bank name is required"),
    accountNumber: z.string().min(1, "Account number is required"),
    openingBalanceSide: z.enum(["Dr", "Cr"]).optional().or(z.literal("")),
    openingBalanceNativeAmount: nullableDecimalString,
    openingBalanceCurrency: openingBalanceCurrencySchema,
    openingBalanceHistoricalRate: nullableDecimalString,
    openingBalanceBaseAmount: nullableDecimalString,
  });

export type InsertBankAccount = z.infer<typeof insertBankAccountSchema>;
export type BankAccount = typeof bankAccounts.$inferSelect;

export const fixedAssets = pgTable(
  "fixed_assets",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    code: varchar("code", { length: 50 }).notNull().unique(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    purchaseDate: date("purchase_date").notNull(),
    // Backward-compatible historical company-base acquisition amount.
    purchaseAmount: decimal("purchase_amount", { precision: 15, scale: 2 }).notNull(),
    purchaseNativeAmount: decimal("purchase_native_amount", { precision: 20, scale: 6 }),
    purchaseCurrency: varchar("purchase_currency", { length: 10 }),
    purchaseHistoricalRate: decimal("purchase_historical_rate", { precision: 20, scale: 10 }),
    purchaseBaseAmount: decimal("purchase_base_amount", { precision: 20, scale: 6 }),
    depreciationMethod: text("depreciation_method").notNull().default("None"),
    usefulLife: integer("useful_life"),
    openingBalance: decimal("opening_balance", { precision: 15, scale: 2 }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("fixed_assets_company_idx").on(t.companyId),
  })
);

export const insertFixedAssetSchema = createInsertSchema(fixedAssets)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    code: z.string().min(1, "Code is required"),
    name: z.string().min(1, "Name is required"),
    category: z.string().min(1, "Category is required"),
    purchaseDate: z.string().min(1, "Purchase date is required"),
    purchaseAmount: z.string().min(1, "Purchase amount is required"),
    purchaseNativeAmount: nullableDecimalString,
    purchaseCurrency: openingBalanceCurrencySchema,
    purchaseHistoricalRate: nullableDecimalString,
    purchaseBaseAmount: nullableDecimalString,
    depreciationMethod: z.enum(["None", "StraightLine", "Declining"]),
  });

export type InsertFixedAsset = z.infer<typeof insertFixedAssetSchema>;
export type FixedAsset = typeof fixedAssets.$inferSelect;
