/**
 * Retail financial-core schema: tender records, cashier drawer events,
 * account mapping, and append-only accounting references.
 */
import {
  index,
  integer,
  decimal,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { companies, locations } from "./common";
import { ledgerAccounts } from "./accounting";
import { retailCashierShifts, retailPosReturns, retailPosSales } from "./retailPos";
import { users } from "./users";
import { vouchers } from "./erp/vouchers";

export const RETAIL_PAYMENT_METHODS = ["cash", "card", "bank_transfer", "mobile_other", "store_credit"] as const;
export type RetailPaymentMethod = (typeof RETAIL_PAYMENT_METHODS)[number];

export const RETAIL_ACCOUNT_KEYS = [
  "cash",
  "card_clearing",
  "bank",
  "sales_revenue",
  "inventory_asset",
  "cogs",
  "discounts",
  "tax_payable",
  "store_credit_liability",
] as const;
export type RetailAccountKey = (typeof RETAIL_ACCOUNT_KEYS)[number];

export const retailPosPayments = pgTable(
  "retail_pos_payments",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    saleId: integer("sale_id")
      .notNull()
      .references(() => retailPosSales.id, { onDelete: "restrict" }),
    returnId: integer("return_id").references(() => retailPosReturns.id, { onDelete: "set null" }),
    shiftId: integer("shift_id").references(() => retailCashierShifts.id, { onDelete: "set null" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    operationType: varchar("operation_type", { length: 24 }).notNull(),
    method: varchar("method", { length: 32 }).notNull(),
    /** Signed: sales are positive and refunds/reversals are negative. */
    amount: decimal("amount", { precision: 20, scale: 6 }).notNull(),
    amountTendered: decimal("amount_tendered", { precision: 20, scale: 6 }),
    changeDue: decimal("change_due", { precision: 20, scale: 6 }).notNull().default("0"),
    reference: varchar("reference", { length: 191 }),
    cashierId: varchar("cashier_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    lineNumber: integer("line_number").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    saleIdx: index("retail_pos_payments_company_sale_created_idx").on(t.companyId, t.saleId, t.createdAt),
    shiftIdx: index("retail_pos_payments_shift_method_created_idx").on(t.shiftId, t.method, t.createdAt),
    locationIdx: index("retail_pos_payments_company_location_created_idx").on(t.companyId, t.locationId, t.createdAt),
    idempotencyLineUnique: uniqueIndex("retail_pos_payments_company_idempotency_line_unique").on(
      t.companyId,
      t.idempotencyKey,
      t.lineNumber
    ),
  })
);

export const retailCashMovements = pgTable(
  "retail_cash_movements",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    shiftId: integer("shift_id")
      .notNull()
      .references(() => retailCashierShifts.id, { onDelete: "restrict" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    direction: varchar("direction", { length: 16 }).notNull(),
    amount: decimal("amount", { precision: 20, scale: 6 }).notNull(),
    reason: text("reason").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    createdBy: varchar("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    shiftCreatedIdx: index("retail_cash_movements_shift_created_idx").on(t.shiftId, t.createdAt),
    companyIdempotencyUnique: uniqueIndex("retail_cash_movements_company_idempotency_unique").on(
      t.companyId,
      t.idempotencyKey
    ),
  })
);

export const retailAccountMappings = pgTable(
  "retail_account_mappings",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    accountKey: varchar("account_key", { length: 40 }).notNull(),
    ledgerAccountId: integer("ledger_account_id")
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    updatedBy: varchar("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyAccountKeyUnique: uniqueIndex("retail_account_mappings_company_key_unique").on(t.companyId, t.accountKey),
    ledgerAccountIdx: index("retail_account_mappings_ledger_account_idx").on(t.ledgerAccountId),
  })
);

export const retailAccountingPostings = pgTable(
  "retail_accounting_postings",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    saleId: integer("sale_id")
      .notNull()
      .references(() => retailPosSales.id, { onDelete: "restrict" }),
    referenceKey: varchar("reference_key", { length: 191 }).notNull(),
    postingType: varchar("posting_type", { length: 24 }).notNull(),
    accountSnapshot: jsonb("account_snapshot").$type<Partial<Record<RetailAccountKey, number>>>().notNull().default({}),
    voucherId: integer("voucher_id")
      .notNull()
      .references(() => vouchers.id, { onDelete: "restrict" }),
    subtotalAmount: decimal("subtotal_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    discountAmount: decimal("discount_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    taxAmount: decimal("tax_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    totalAmount: decimal("total_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    cogsAmount: decimal("cogs_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyReferenceUnique: uniqueIndex("retail_accounting_postings_company_reference_unique").on(
      t.companyId,
      t.referenceKey
    ),
    voucherUnique: uniqueIndex("retail_accounting_postings_voucher_unique").on(t.voucherId),
    companySaleCreatedIdx: index("retail_accounting_postings_company_sale_created_idx").on(
      t.companyId,
      t.saleId,
      t.createdAt
    ),
  })
);

export type RetailPosPayment = typeof retailPosPayments.$inferSelect;
export type RetailCashMovement = typeof retailCashMovements.$inferSelect;
export type RetailAccountMapping = typeof retailAccountMappings.$inferSelect;
export type RetailAccountingPosting = typeof retailAccountingPostings.$inferSelect;
