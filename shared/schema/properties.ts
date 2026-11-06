import {
  pgTable,
  text,
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
import { ledgerAccounts } from "./accounting";

export const propertyUnits = pgTable(
  "property_units",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    module: text("module").notNull().default("PROPERTIES"),
    unitType: text("unit_type").notNull(),
    locationGroup: text("location_group").notNull(),
    unitNumber: text("unit_number").notNull(),
    size: text("size"),
    dimensions: text("dimensions"),
    notes: text("notes"),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqCompanyModuleUnit: uniqueIndex("property_units_company_module_unit_unique").on(
      t.companyId,
      t.module,
      t.unitNumber
    ),
    byCompany: index("property_units_company_idx").on(t.companyId, t.module, t.unitType),
  })
);

export const insertPropertyUnitSchema = createInsertSchema(propertyUnits)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    unitType: z.enum(["WAREHOUSE", "SHOP"]),
    unitNumber: z.string().min(1, "Unit number required"),
    locationGroup: z.string().min(1, "Location group required"),
  });

export type InsertPropertyUnit = z.infer<typeof insertPropertyUnitSchema>;
export type PropertyUnit = typeof propertyUnits.$inferSelect;

export const propertyContracts = pgTable(
  "property_contracts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    module: text("module").notNull().default("PROPERTIES"),
    unitId: integer("unit_id")
      .notNull()
      .references(() => propertyUnits.id, { onDelete: "restrict" }),
    tenantName: text("tenant_name").notNull(),
    guaranteePeriod: text("guarantee_period"),
    guaranteeAmount: decimal("guarantee_amount", { precision: 20, scale: 2 }).notNull().default("0"),
    rentalAmount: decimal("rental_amount", { precision: 20, scale: 2 }).notNull().default("0"),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    status: text("status").notNull().default("ACTIVE"),
    notes: text("notes"),
    statementNote: text("statement_note"),
    guaranteePostedToStatement: boolean("guarantee_posted_to_statement").notNull().default(false),
    guaranteePostedAmount: decimal("guarantee_posted_amount", { precision: 20, scale: 2 }).default("0"),
    isInternal: boolean("is_internal").notNull().default(false),
    linkedCompanyId: integer("linked_company_id"),
    currency: text("currency").notNull().default("USD"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    byUnit: index("property_contracts_unit_idx").on(t.unitId, t.status),
    byCompany: index("property_contracts_company_idx").on(t.companyId, t.status),
  })
);

export const insertPropertyContractSchema = createInsertSchema(propertyContracts)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    tenantName: z.string().min(1, "Tenant name required"),
    rentalAmount: z.union([z.string(), z.number()]).transform((v) => String(v)),
    // The contract form sends an empty string when no guarantee is required.
    // Normalize it before a numeric INSERT rather than passing '' to Postgres.
    guaranteeAmount: z
      .union([z.string(), z.number()])
      .transform((v) => String(v).trim() || "0")
      .refine((v) => /^\d+(?:\.\d{1,2})?$/.test(v), {
        message: "Guarantee amount must be a non-negative number with at most two decimals",
      })
      .optional(),
    startDate: z.string().min(1, "Start date required"),
    currency: z.string().optional(),
  });

export type InsertPropertyContract = z.infer<typeof insertPropertyContractSchema>;
export type PropertyContract = typeof propertyContracts.$inferSelect;

export const propertyMonthlyLedger = pgTable(
  "property_monthly_ledger",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    module: text("module").notNull().default("PROPERTIES"),
    contractId: integer("contract_id").notNull(),
    unitId: integer("unit_id")
      .notNull()
      .references(() => propertyUnits.id, { onDelete: "restrict" }),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    expectedAmount: decimal("expected_amount", { precision: 20, scale: 2 }).notNull().default("0"),
    paidAmount: decimal("paid_amount", { precision: 20, scale: 2 }).notNull().default("0"),
    notes: text("notes"),
    accrualVoucherId: integer("accrual_voucher_id"),
    usedPrepaidAccount: boolean("used_prepaid_account").notNull().default(false),
    usedAdvanceAccount: boolean("used_advance_account").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("property_monthly_ledger_company_idx").on(t.companyId),
    uniqContractPeriod: uniqueIndex("property_monthly_ledger_unique").on(t.contractId, t.year, t.month),
    byUnit: index("property_monthly_ledger_unit_idx").on(t.unitId),
  })
);

export const insertPropertyMonthlyLedgerSchema = createInsertSchema(propertyMonthlyLedger).omit({
  id: true,
  createdAt: true,
});

export type InsertPropertyMonthlyLedger = z.infer<typeof insertPropertyMonthlyLedgerSchema>;
export type PropertyMonthlyLedger = typeof propertyMonthlyLedger.$inferSelect;

export const propertyPayments = pgTable(
  "property_payments",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    module: text("module").notNull().default("PROPERTIES"),
    contractId: integer("contract_id").notNull(),
    unitId: integer("unit_id")
      .notNull()
      .references(() => propertyUnits.id, { onDelete: "restrict" }),
    ledgerRowId: integer("ledger_row_id"),
    cashAccountId: integer("cash_account_id").references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    voucherId: integer("voucher_id"),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
    paymentDate: date("payment_date").notNull(),
    forYear: integer("for_year").notNull(),
    forMonth: integer("for_month").notNull(),
    notes: text("notes"),
    currency: text("currency").notNull().default("USD"),
    exchangeRate: decimal("exchange_rate", { precision: 20, scale: 6 }).notNull().default("1"),
    /**
     * Lifecycle status for this payment split row.
     * SCHEDULED — created for a future paymentDate; no voucher/ledger impact yet.
     * POSTED     — voucher created, cash credited, monthly ledger paid_amount updated.
     * VOID       — reversed/deleted; no accounting effect.
     */
    postingStatus: text("posting_status").notNull().default("POSTED"),
    /** Groups all split rows that belong to the same payment transaction. */
    paymentGroupId: text("payment_group_id"),
    /** Timestamp when the row transitioned from SCHEDULED → POSTED. */
    postedAt: timestamp("posted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    byContract: index("property_payments_contract_idx").on(t.contractId),
    byCompany: index("property_payments_company_idx").on(t.companyId, t.paymentDate),
    byStatus: index("property_payments_status_idx").on(t.companyId, t.module, t.postingStatus, t.paymentDate),
  })
);

export const insertPropertyPaymentSchema = createInsertSchema(propertyPayments)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
    paymentDate: z.string().min(1, "Payment date required"),
    currency: z.string().optional(),
    exchangeRate: z
      .union([z.string(), z.number()])
      .transform((v) => String(v))
      .optional(),
  });

export type InsertPropertyPayment = z.infer<typeof insertPropertyPaymentSchema>;
export type PropertyPayment = typeof propertyPayments.$inferSelect;

export const rentalAutoTransferConfigs = pgTable(
  "rental_auto_transfer_configs",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    module: text("module").notNull(),
    destCompanyId: integer("dest_company_id").notNull(),
    destLedgerAccountId: integer("dest_ledger_account_id").notNull(),
    sourceCashAccountIds: integer("source_cash_account_ids").array().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  () => ({})
);

export const insertRentalAutoTransferConfigSchema = createInsertSchema(rentalAutoTransferConfigs)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1),
    destCompanyId: z.number().min(1),
    destLedgerAccountId: z.number().min(1),
    module: z.enum(["PROPERTIES", "ERP", "FACTORY"]),
  });

export type InsertRentalAutoTransferConfig = z.infer<typeof insertRentalAutoTransferConfigSchema>;
export type RentalAutoTransferConfig = typeof rentalAutoTransferConfigs.$inferSelect;
