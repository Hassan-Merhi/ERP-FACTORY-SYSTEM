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
import { companies, locations } from "../common";
import { ledgerAccounts } from "../accounting";
import { stockItems } from "../inventory";
import { users } from "../users";

import { employees, suppliers } from "./parties";

export const vouchers = pgTable(
  "vouchers",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    locationId: integer("location_id").references(() => locations.id, { onDelete: "restrict" }),
    locationName: text("location_name"),
    voucherNumber: varchar("voucher_number", { length: 100 }).notNull().unique(),
    voucherType: text("voucher_type").notNull(),
    voucherDate: date("voucher_date").notNull(),
    description: text("description"),
    totalAmount: decimal("total_amount", { precision: 20, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    optional: boolean("optional").notNull().default(false),
    shiftId: integer("shift_id"),
    exchangeRate: decimal("exchange_rate", { precision: 20, scale: 6 }),
    sourceModule: text("source_module").default("ERP"),
    isCreditSale: boolean("is_credit_sale").default(false),
    clientSaleId: varchar("client_sale_id", { length: 36 }),
    deletedAt: timestamp("deleted_at"),
    effectiveDate: date("effective_date"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("vouchers_company_idx").on(t.companyId),
    companyDateIdx: index("vouchers_company_date_idx").on(t.companyId, t.voucherDate),
  })
);

export const insertVoucherSchema = createInsertSchema(vouchers)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    locationId: z.number().optional(),
    locationName: z.string().optional(),
    voucherNumber: z.string().min(1, "Voucher number is required"),
    voucherType: z.enum([
      "Payment",
      "Receipt",
      "Journal",
      "Sales",
      "Purchase",
      "Contra",
      "Stock Transfer",
      "Consumption",
      "Credit Note",
      "Debit Note",
    ]),
    voucherDate: z.string().min(1, "Voucher date is required"),
    totalAmount: z.string().min(1, "Total amount is required"),
    currency: z.enum(["USD", "CFA"]).default("USD"),
    optional: z.boolean().optional().default(false),
    shiftId: z.number().optional(),
    exchangeRate: z.string().optional(),
    sourceModule: z.enum(["ERP", "FACTORY"]).optional().default("ERP"),
    isCreditSale: z.boolean().optional(),
    effectiveDate: z.string().optional().nullable(),
  });

export type InsertVoucher = z.infer<typeof insertVoucherSchema>;
export type Voucher = typeof vouchers.$inferSelect;

export const customers = pgTable(
  "customers",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    ledgerAccountId: integer("ledger_account_id"),
    code: varchar("code", { length: 50 }).notNull(),
    legalName: text("legal_name").notNull(),
    phone: text("phone"),
    openingBalance: decimal("opening_balance", { precision: 15, scale: 2 }).default("0"),
    openingBalanceSide: varchar("opening_balance_side", { length: 2 }).default("Dr"),
    active: boolean("active").notNull().default(true),
    statementNote: text("statement_note"),
    paymentTermsDays: integer("payment_terms_days"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyCode: uniqueIndex("customers_company_code_unique").on(t.companyId, t.code),
  })
);

export const insertCustomerSchema = createInsertSchema(customers)
  .omit({
    id: true,
    createdAt: true,
    code: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    legalName: z.string().min(1, "Legal name is required"),
    openingBalance: z.string().optional(),
    openingBalanceSide: z.enum(["Dr", "Cr"]).optional().or(z.literal("")),
    ledgerAccountId: z.number().optional(),
    paymentTermsDays: z.number().int().positive().optional().nullable(),
  });

export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type Customer = typeof customers.$inferSelect;

export const voucherEntries = pgTable(
  "voucher_entries",
  {
    id: serial("id").primaryKey(),
    voucherId: integer("voucher_id")
      .notNull()
      .references(() => vouchers.id, { onDelete: "cascade" }),
    // DB-managed tenant key. The BEFORE trigger in migration 0016 always
    // overwrites the fail-closed sentinel from the canonical parent voucher.
    companyId: integer("company_id").notNull().default(0),
    ledgerAccountId: integer("ledger_account_id"),
    bankAccountId: integer("bank_account_id"),
    fixedAssetId: integer("fixed_asset_id"),
    supplierId: integer("supplier_id").references(() => suppliers.id, { onDelete: "restrict" }),
    employeeId: integer("employee_id").references(() => employees.id, { onDelete: "restrict" }),
    customerId: integer("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    factorySupplierId: integer("factory_supplier_id"),
    debitAmount: decimal("debit_amount", { precision: 20, scale: 2 }).default("0"),
    creditAmount: decimal("credit_amount", { precision: 20, scale: 2 }).default("0"),
    narration: text("narration"),
    // ── Dual-currency fields (Phase 1 multi-currency accounting) ─────────────
    // Added as nullable so all existing rows remain valid without a data migration.
    // New writes fill all 7 fields via normalizeVoucherEntryAmounts().
    // Existing rows are backfilled via scripts/backfill-voucher-entry-currency-amounts.mjs.
    //
    // debitAmount / creditAmount (above) are redefined as backward-compatible
    // historical BASE-CURRENCY (USD) amounts for all newly posted vouchers.
    // Legacy rows that stored CFA directly must be repaired by the backfill script.
    /** ISO-4217 code of the original transaction currency (e.g. "XOF", "USD"). */
    transactionCurrency: varchar("transaction_currency", { length: 3 }),
    /** Transaction-currency debit amount at time of posting (6 dp). */
    transactionDebitAmount: decimal("transaction_debit_amount", { precision: 20, scale: 6 }),
    /** Transaction-currency credit amount at time of posting (6 dp). */
    transactionCreditAmount: decimal("transaction_credit_amount", { precision: 20, scale: 6 }),
    /** Historical base-currency (USD) debit amount (6 dp). Equals debitAmount for new rows. */
    baseDebitAmount: decimal("base_debit_amount", { precision: 20, scale: 6 }),
    /** Historical base-currency (USD) credit amount (6 dp). Equals creditAmount for new rows. */
    baseCreditAmount: decimal("base_credit_amount", { precision: 20, scale: 6 }),
    /** Exchange rate used at posting time (10 dp). Semantics depend on rateConvention. */
    historicalExchangeRate: decimal("historical_exchange_rate", { precision: 20, scale: 10 }),
    /**
     * Rate convention:
     *  IDENTITY             – transaction currency IS the base currency
     *  TRANSACTION_PER_BASE – rate = transaction-currency units per 1 base unit (CFA per USD)
     *  BASE_PER_TRANSACTION – rate = base units per 1 transaction unit (reserved)
     */
    rateConvention: varchar("rate_convention", { length: 30 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    voucherIdx: index("voucher_entries_voucher_idx").on(t.voucherId),
    companyIdx: index("voucher_entries_company_idx").on(t.companyId),
    customerIdx: index("voucher_entries_customer_idx").on(t.customerId),
    ledgerAccountIdx: index("voucher_entries_ledger_account_idx").on(t.ledgerAccountId),
    ledgerVoucherIdx: index("voucher_entries_ledger_voucher_idx").on(t.ledgerAccountId, t.voucherId),
  })
);

export const insertVoucherEntrySchema = createInsertSchema(voucherEntries)
  .omit({
    id: true,
    companyId: true,
    createdAt: true,
  })
  .extend({
    voucherId: z.number().min(1, "Voucher is required"),
    ledgerAccountId: z.number().optional(),
    bankAccountId: z.number().optional(),
    fixedAssetId: z.number().optional(),
    supplierId: z.number().optional(),
    employeeId: z.number().optional(),
    customerId: z.number().optional(),
    factorySupplierId: z.number().optional(),
    debitAmount: z.string().optional(),
    creditAmount: z.string().optional(),
  });

export type InsertVoucherEntry = z.infer<typeof insertVoucherEntrySchema>;
export type VoucherEntry = typeof voucherEntries.$inferSelect;

export const creditNoteItems = pgTable("credit_note_items", {
  id: serial("id").primaryKey(),
  voucherId: integer("voucher_id")
    .notNull()
    .references(() => vouchers.id, { onDelete: "cascade" }),
  stockItemId: integer("stock_item_id")
    .notNull()
    .references(() => stockItems.id, { onDelete: "restrict" }),
  locationId: integer("location_id")
    .notNull()
    .references(() => locations.id, { onDelete: "restrict" }),
  quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
  rate: decimal("rate", { precision: 20, scale: 2 }).notNull(),
  inventoryCost: decimal("inventory_cost", { precision: 20, scale: 2 }).notNull().default("0"),
  totalValue: decimal("total_value", { precision: 20, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCreditNoteItemSchema = createInsertSchema(creditNoteItems)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    voucherId: z.number().min(1, "Voucher is required"),
    stockItemId: z.number().min(1, "Stock item is required"),
    locationId: z.number().min(1, "Location is required"),
    quantity: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, "Quantity must be positive"),
    rate: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Rate must be non-negative"),
    totalValue: z.string(),
  });

export type InsertCreditNoteItem = z.infer<typeof insertCreditNoteItemSchema>;
export type CreditNoteItem = typeof creditNoteItems.$inferSelect;

export const fiscalPeriodClosures = pgTable(
  "fiscal_period_closures",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    periodStartDate: date("period_start_date").notNull(),
    periodEndDate: date("period_end_date").notNull(),
    closureDate: timestamp("closure_date").notNull().defaultNow(),
    closedByUserId: varchar("closed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    closingVoucherId: integer("closing_voucher_id")
      .notNull()
      .unique()
      .references(() => vouchers.id, { onDelete: "restrict" }),
    retainedEarningsAccountId: integer("retained_earnings_account_id")
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    totalIncome: decimal("total_income", { precision: 15, scale: 2 }).notNull(),
    totalExpense: decimal("total_expense", { precision: 15, scale: 2 }).notNull(),
    netIncome: decimal("net_income", { precision: 15, scale: 2 }).notNull(),
    status: text("status").notNull().default("CLOSED"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyPeriod: uniqueIndex("fiscal_closures_company_period_unique").on(t.companyId, t.periodEndDate),
  })
);

export const insertFiscalPeriodClosureSchema = createInsertSchema(fiscalPeriodClosures)
  .omit({
    id: true,
    createdAt: true,
    closureDate: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    periodStartDate: z.string().min(1, "Period start date is required"),
    periodEndDate: z.string().min(1, "Period end date is required"),
    closedByUserId: z.string().min(1, "User is required"),
    closingVoucherId: z.number().min(1, "Closing voucher is required"),
    retainedEarningsAccountId: z.number().min(1, "Retained earnings account is required"),
    totalIncome: z.string(),
    totalExpense: z.string(),
    netIncome: z.string(),
    status: z.enum(["CLOSED", "REOPENED"]).optional(),
    notes: z.string().optional(),
  });

export type InsertFiscalPeriodClosure = z.infer<typeof insertFiscalPeriodClosureSchema>;
export type FiscalPeriodClosure = typeof fiscalPeriodClosures.$inferSelect;
