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
import { employees } from "./parties";
import { customers, vouchers } from "./vouchers";
import { isNonNegativeNumeric, isPositiveNumeric } from "../../numericString";

export const employeeBaleRates = pgTable(
  "employee_bale_rates",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    rate: decimal("rate", { precision: 10, scale: 4 }).notNull(),
    sourceCompanyId: integer("source_company_id"),
  },
  (t) => ({
    companyIdx: index("employee_bale_rates_company_idx").on(t.companyId),
  })
);
export type EmployeeBaleRate = typeof employeeBaleRates.$inferSelect;

export const employeeBalePctRates = pgTable(
  "employee_bale_pct_rates",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    pct: decimal("pct", { precision: 10, scale: 4 }).notNull(),
    sourceCompanyId: integer("source_company_id"),
  },
  (t) => ({
    companyIdx: index("employee_bale_pct_rates_company_idx").on(t.companyId),
  })
);
export type EmployeeBalePctRate = typeof employeeBalePctRates.$inferSelect;

export const containerSales = pgTable(
  "container_sales",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id").notNull(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    saleDate: date("sale_date").notNull(),
    containerCost: decimal("container_cost", { precision: 15, scale: 2 }).notNull(),
    commission: decimal("commission", { precision: 15, scale: 2 }).notNull(),
    commissionAccountId: integer("commission_account_id"),
    totalAmount: decimal("total_amount", { precision: 15, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    invoiceNumber: varchar("invoice_number", { length: 100 }),
    paymentStatus: text("payment_status").notNull().default("PENDING"),
    paidAmount: decimal("paid_amount", { precision: 20, scale: 2 }).notNull().default("0"),
    voucherId: integer("voucher_id").references(() => vouchers.id, { onDelete: "restrict" }),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyContainer: uniqueIndex("container_sales_company_container_unique").on(t.companyId, t.containerId),
  })
);

export const insertContainerSaleSchema = createInsertSchema(containerSales)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    containerId: z.number().min(1, "Container is required"),
    customerId: z.number().min(1, "Customer is required"),
    saleDate: z.string().min(1, "Sale date is required"),
    containerCost: z.string().refine(isNonNegativeNumeric, "Container cost must be non-negative"),
    commission: z.string().refine(isNonNegativeNumeric, "Commission must be non-negative"),
    commissionAccountId: z.number().optional(),
    totalAmount: z.string().refine(isPositiveNumeric, "Total amount must be positive"),
    currency: z.string().min(1).default("USD"),
    invoiceNumber: z.string().optional(),
    paymentStatus: z.enum(["PENDING", "PARTIAL", "PAID"]).optional(),
    paidAmount: z.string().optional(),
    voucherId: z.number().optional(),
  });

export type InsertContainerSale = z.infer<typeof insertContainerSaleSchema>;
export type ContainerSale = typeof containerSales.$inferSelect;

export const interCompanyTransfers = pgTable("inter_company_transfers", {
  id: serial("id").primaryKey(),
  transferType: text("transfer_type").notNull(),
  fromCompanyId: integer("from_company_id").notNull(),
  toCompanyId: integer("to_company_id").notNull(),
  transferDate: date("transfer_date").notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  fromLedgerAccountId: integer("from_ledger_account_id").notNull(),
  toLedgerAccountId: integer("to_ledger_account_id").notNull(),
  fromVoucherId: integer("from_voucher_id").references(() => vouchers.id, { onDelete: "restrict" }),
  toVoucherId: integer("to_voucher_id").references(() => vouchers.id, { onDelete: "restrict" }),
  description: text("description"),
  sourcePaymentId: integer("source_payment_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertInterCompanyTransferSchema = createInsertSchema(interCompanyTransfers)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    transferType: z.enum(["Cash", "Loan"]),
    fromCompanyId: z.number().min(1, "From company is required"),
    toCompanyId: z.number().min(1, "To company is required"),
    transferDate: z.string().min(1, "Transfer date is required"),
    amount: z.string().refine(isPositiveNumeric, "Amount must be positive"),
    fromLedgerAccountId: z.number().min(1, "From account is required"),
    toLedgerAccountId: z.number().min(1, "To account is required"),
  });

export type InsertInterCompanyTransfer = z.infer<typeof insertInterCompanyTransferSchema>;
export type InterCompanyTransfer = typeof interCompanyTransfers.$inferSelect;

export const intercompanyPosConfigs = pgTable("intercompany_pos_configs", {
  id: serial("id").primaryKey(),
  sourceCompanyId: integer("source_company_id").notNull().unique(),
  destCompanyId: integer("dest_company_id").notNull(),
  sourceIntercoAccountId: integer("source_interco_account_id").notNull(),
  destIntercoAccountId: integer("dest_interco_account_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  skipSourceVoucher: boolean("skip_source_voucher").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type IntercompanyPosConfig = typeof intercompanyPosConfigs.$inferSelect;

export const intercompanyAccountLinks = pgTable("intercompany_account_links", {
  id: serial("id").primaryKey(),
  label: text("label"),
  sourceCompanyId: integer("source_company_id").notNull(),
  sourceLedgerAccountId: integer("source_ledger_account_id").notNull(),
  destCompanyId: integer("dest_company_id").notNull(),
  destLedgerAccountId: integer("dest_ledger_account_id").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type IntercompanyAccountLink = typeof intercompanyAccountLinks.$inferSelect;
export const insertIntercompanyAccountLinkSchema = createInsertSchema(intercompanyAccountLinks).omit({
  id: true,
  createdAt: true,
});
export type InsertIntercompanyAccountLink = z.infer<typeof insertIntercompanyAccountLinkSchema>;

export const intercompanyLinkRecipients = pgTable("intercompany_link_recipients", {
  id: serial("id").primaryKey(),
  linkId: integer("link_id").notNull(),
  userId: varchar("user_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type IntercompanyLinkRecipient = typeof intercompanyLinkRecipients.$inferSelect;

export const intercompanyPaymentRequests = pgTable("intercompany_payment_requests", {
  id: serial("id").primaryKey(),
  linkId: integer("link_id").notNull(),
  fromCompanyId: integer("from_company_id").notNull(),
  fromVoucherId: integer("from_voucher_id").notNull(),
  fromVoucherNumber: text("from_voucher_number").notNull(),
  fromVoucherDate: date("from_voucher_date").notNull(),
  amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
  description: text("description"),
  status: text("status").notNull().default("pending"),
  destLedgerAccountId: integer("dest_ledger_account_id"),
  destVoucherId: integer("dest_voucher_id"),
  approvedByUserId: varchar("approved_by_user_id"),
  approvedAt: timestamp("approved_at"),
  dismissNote: text("dismiss_note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type IntercompanyPaymentRequest = typeof intercompanyPaymentRequests.$inferSelect;
