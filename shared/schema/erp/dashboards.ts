import { pgTable, text, serial, integer, decimal, date, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { customers } from "./vouchers";
import { isNumericString } from "../../numericString";

export const dashboardCashAccounts = pgTable(
  "dashboard_cash_accounts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    accountType: text("account_type").notNull(),
    accountId: integer("account_id").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("dashboard_cash_accounts_company_idx").on(t.companyId),
  })
);

export const insertDashboardCashAccountSchema = createInsertSchema(dashboardCashAccounts)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    accountType: z.string().min(1),
    accountId: z.number().min(1, "Account is required"),
    displayOrder: z.number().optional(),
  });

export type InsertDashboardCashAccount = z.infer<typeof insertDashboardCashAccountSchema>;
export type DashboardCashAccount = typeof dashboardCashAccounts.$inferSelect;

export const dashboardPayableAccounts = pgTable(
  "dashboard_payable_accounts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    accountId: integer("account_id").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("dashboard_payable_accounts_company_idx").on(t.companyId),
  })
);

export const insertDashboardPayableAccountSchema = createInsertSchema(dashboardPayableAccounts)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    accountId: z.number().min(1, "Account is required"),
    displayOrder: z.number().optional(),
  });

export type InsertDashboardPayableAccount = z.infer<typeof insertDashboardPayableAccountSchema>;
export type DashboardPayableAccount = typeof dashboardPayableAccounts.$inferSelect;

export const customerBalances = pgTable(
  "customer_balances",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    transactionDate: date("transaction_date").notNull(),
    transactionType: text("transaction_type").notNull(),
    referenceId: integer("reference_id"),
    referenceType: text("reference_type"),
    debitAmount: decimal("debit_amount", { precision: 20, scale: 2 }).notNull().default("0"),
    creditAmount: decimal("credit_amount", { precision: 20, scale: 2 }).notNull().default("0"),
    balance: decimal("balance", { precision: 20, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    description: text("description"),
    rowNote: text("row_note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("customer_balances_company_idx").on(t.companyId),
    customerCompanyIdx: index("customer_balances_customer_company_idx").on(t.customerId, t.companyId),
  })
);

export const insertCustomerBalanceSchema = createInsertSchema(customerBalances)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    customerId: z.number().min(1, "Customer is required"),
    transactionDate: z.string().min(1, "Transaction date is required"),
    transactionType: z.enum(["SALE", "PAYMENT", "ADJUSTMENT"]),
    referenceId: z.number().optional(),
    referenceType: z.string().optional(),
    debitAmount: z.string().optional(),
    creditAmount: z.string().optional(),
    balance: z.string().refine(isNumericString, "Balance must be a valid number"),
    currency: z.string().min(1).default("USD"),
    description: z.string().optional(),
  });

export type InsertCustomerBalance = z.infer<typeof insertCustomerBalanceSchema>;
export type CustomerBalance = typeof customerBalances.$inferSelect;
