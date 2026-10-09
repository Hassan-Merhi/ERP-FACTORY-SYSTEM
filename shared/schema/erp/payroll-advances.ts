import { pgTable, text, serial, integer, decimal, date, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { employees } from "./parties";
import { vouchers } from "./vouchers";
import { isNonNegativeNumeric, isPositiveNumeric } from "../../numericString";

export const salaryAdvances = pgTable(
  "salary_advances",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    advanceDate: date("advance_date").notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    remainingBalance: decimal("remaining_balance", { precision: 15, scale: 2 }).notNull(),
    voucherId: integer("voucher_id").references(() => vouchers.id, { onDelete: "restrict" }),
    notes: text("notes"),
    fullyPaid: boolean("fully_paid").notNull().default(false),
    isOpeningBalance: boolean("is_opening_balance").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("salary_advances_company_idx").on(t.companyId),
  })
);

export const insertSalaryAdvanceSchema = createInsertSchema(salaryAdvances)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    employeeId: z.number().min(1, "Employee is required"),
    advanceDate: z.string().min(1, "Advance date is required"),
    amount: z.string().refine(isPositiveNumeric, "Amount must be positive"),
    remainingBalance: z.string().refine(isNonNegativeNumeric, "Remaining balance must be non-negative"),
    isOpeningBalance: z.boolean().optional().default(false),
  });

export type InsertSalaryAdvance = z.infer<typeof insertSalaryAdvanceSchema>;
export type SalaryAdvance = typeof salaryAdvances.$inferSelect;

export const salaryAdvanceDeductions = pgTable("salary_advance_deductions", {
  id: serial("id").primaryKey(),
  salaryAdvanceId: integer("salary_advance_id")
    .notNull()
    .references(() => salaryAdvances.id, { onDelete: "cascade" }),
  payrollMonth: text("payroll_month").notNull(),
  deductionAmount: decimal("deduction_amount", { precision: 15, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertSalaryAdvanceDeductionSchema = createInsertSchema(salaryAdvanceDeductions)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    salaryAdvanceId: z.number().min(1, "Salary advance is required"),
    payrollMonth: z.string().min(1, "Payroll month is required"),
    deductionAmount: z.string().refine(isPositiveNumeric, "Deduction amount must be positive"),
  });

export type InsertSalaryAdvanceDeduction = z.infer<typeof insertSalaryAdvanceDeductionSchema>;
export type SalaryAdvanceDeduction = typeof salaryAdvanceDeductions.$inferSelect;

// These legacy ERP employee cash-movement tables are still used by the
// factory employee advances/bonus routes. They must live in the Drizzle schema
// as well as the boot-time catch-up migrations so a clean database created by
// `drizzle-kit push` has the same runtime-authoritative tables as production.
export const employeeAdvances = pgTable(
  "employee_advances",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    advanceDate: date("advance_date").notNull(),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
    remainingBalance: decimal("remaining_balance", { precision: 20, scale: 2 }).notNull().default("0"),
    cashAccountId: integer("cash_account_id"),
    notes: text("notes"),
    fullyPaid: boolean("fully_paid").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("employee_advances_company_idx").on(t.companyId),
    employeeIdx: index("employee_advances_employee_idx").on(t.employeeId),
  })
);

export const employeeAdvanceRepayments = pgTable(
  "employee_advance_repayments",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    advanceId: integer("advance_id")
      .notNull()
      .references(() => employeeAdvances.id, { onDelete: "cascade" }),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    repaymentDate: date("repayment_date").notNull(),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
    cashAccountId: integer("cash_account_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("employee_advance_repayments_company_idx").on(t.companyId),
    advanceIdx: index("employee_advance_repayments_advance_idx").on(t.advanceId),
  })
);

export const employeeBonuses = pgTable(
  "employee_bonuses",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    bonusDate: date("bonus_date").notNull(),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
    notes: text("notes"),
    voucherId: integer("voucher_id").references(() => vouchers.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("employee_bonuses_company_idx").on(t.companyId),
    employeeIdx: index("employee_bonuses_employee_idx").on(t.employeeId),
  })
);
