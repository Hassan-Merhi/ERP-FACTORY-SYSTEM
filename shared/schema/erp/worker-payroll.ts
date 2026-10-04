import { pgTable, text, serial, integer, decimal, date, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { locations } from "../common";
import { stockItems } from "../inventory";
import { employees } from "./parties";
import { vouchers } from "./vouchers";

export const erpWorkerDocs = pgTable(
  "erp_worker_docs",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    fileName: text("file_name").notNull(),
    fileType: text("file_type").notNull(),
    fileSize: integer("file_size").notNull(),
    fileData: text("file_data").notNull(),
    description: text("description"),
    uploadedBy: text("uploaded_by"),
    uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("erp_worker_docs_company_idx").on(t.companyId),
  })
);

export const insertErpWorkerDocSchema = createInsertSchema(erpWorkerDocs)
  .omit({ id: true, uploadedAt: true })
  .extend({
    companyId: z.number().min(1),
    employeeId: z.number().min(1),
    fileName: z.string().min(1),
    fileType: z.string().min(1),
    fileSize: z.number().min(0),
    fileData: z.string().min(1),
    description: z.string().optional(),
    uploadedBy: z.string().optional(),
  });

export type InsertErpWorkerDoc = z.infer<typeof insertErpWorkerDocSchema>;
export type ErpWorkerDoc = typeof erpWorkerDocs.$inferSelect;

export const erpPayrollRuns = pgTable(
  "erp_payroll_runs",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    status: text("status").notNull().default("DRAFT"),
    date: text("date").notNull(),
    notes: text("notes"),
    paymentAccountId: integer("payment_account_id"),
    paidAt: text("paid_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    companyIdx: index("erp_payroll_runs_company_idx").on(t.companyId),
  })
);

export const insertErpPayrollRunSchema = createInsertSchema(erpPayrollRuns).omit({ id: true });
export type InsertErpPayrollRun = z.infer<typeof insertErpPayrollRunSchema>;
export type ErpPayrollRun = typeof erpPayrollRuns.$inferSelect;

export const erpPayrollRunItems = pgTable("erp_payroll_run_items", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull(),
  employeeId: integer("employee_id")
    .notNull()
    .references(() => employees.id, { onDelete: "restrict" }),
  employeeName: text("employee_name").notNull(),
  groupName: text("group_name"),
  baseSalary: decimal("base_salary", { precision: 18, scale: 2 }).notNull(),
  deduction: decimal("deduction", { precision: 18, scale: 2 }).notNull().default("0"),
  payrollDeduction: decimal("payroll_deduction", { precision: 18, scale: 2 }).notNull().default("0"),
  netPay: decimal("net_pay", { precision: 18, scale: 2 }).notNull(),
});

export const insertErpPayrollRunItemSchema = createInsertSchema(erpPayrollRunItems).omit({ id: true });
export type InsertErpPayrollRunItem = z.infer<typeof insertErpPayrollRunItemSchema>;
export type ErpPayrollRunItem = typeof erpPayrollRunItems.$inferSelect;

export const wasteDispatches = pgTable(
  "waste_dispatches",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    voucherId: integer("voucher_id").references(() => vouchers.id, { onDelete: "restrict" }),
    dispatchNumber: text("dispatch_number").notNull(),
    dispatchDate: date("dispatch_date").notNull(),
    notes: text("notes"),
    totalAmount: decimal("total_amount", { precision: 15, scale: 2 }).notNull().default("0"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("waste_dispatches_company_idx").on(t.companyId),
  })
);

export const insertWasteDispatchSchema = createInsertSchema(wasteDispatches).omit({ id: true, createdAt: true });
export type InsertWasteDispatch = z.infer<typeof insertWasteDispatchSchema>;
export type WasteDispatch = typeof wasteDispatches.$inferSelect;

export const wasteDispatchItems = pgTable("waste_dispatch_items", {
  id: serial("id").primaryKey(),
  dispatchId: integer("dispatch_id").notNull(),
  stockItemId: integer("stock_item_id")
    .notNull()
    .references(() => stockItems.id, { onDelete: "restrict" }),
  quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
  rate: decimal("rate", { precision: 15, scale: 2 }).notNull(),
  totalAmount: decimal("total_amount", { precision: 15, scale: 2 }).notNull(),
});

export const insertWasteDispatchItemSchema = createInsertSchema(wasteDispatchItems).omit({ id: true });
export type InsertWasteDispatchItem = z.infer<typeof insertWasteDispatchItemSchema>;
export type WasteDispatchItem = typeof wasteDispatchItems.$inferSelect;
