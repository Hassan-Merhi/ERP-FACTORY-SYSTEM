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
import { ledgerAccounts } from "../accounting";

// ─── Factory Workers ──────────────────────────────────────────────────────────
export const factoryWorkers = pgTable(
  "factory_workers",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    employeeCode: varchar("employee_code", { length: 50 }),
    fullName: varchar("full_name", { length: 200 }).notNull(),
    fatherName: varchar("father_name", { length: 200 }),
    motherName: varchar("mother_name", { length: 200 }),
    nationalId: varchar("national_id", { length: 100 }),
    passportNumber: varchar("passport_number", { length: 100 }),
    dateOfBirth: date("date_of_birth"),
    gender: varchar("gender", { length: 20 }),
    nationality: varchar("nationality", { length: 100 }),
    maritalStatus: varchar("marital_status", { length: 30 }),
    numberOfChildren: integer("number_of_children").default(0),
    phone1: varchar("phone1", { length: 50 }),
    phone2: varchar("phone2", { length: 50 }),
    emergencyContactName: varchar("emergency_contact_name", { length: 200 }),
    emergencyContactPhone: varchar("emergency_contact_phone", { length: 50 }),
    address: text("address"),
    city: varchar("city", { length: 100 }),
    country: varchar("country", { length: 100 }),
    position: varchar("position", { length: 100 }),
    department: varchar("department", { length: 100 }),
    dateJoined: date("date_joined"),
    contractStartDate: date("contract_start_date"),
    contractEndDate: date("contract_end_date"),
    salaryType: varchar("salary_type", { length: 30 }).notNull().default("Monthly"),
    baseSalary: decimal("base_salary", { precision: 20, scale: 2 }).default("0"),
    perBaleRate: decimal("per_bale_rate", { precision: 20, scale: 4 }).default("0"),
    perKgRate: decimal("per_kg_rate", { precision: 20, scale: 4 }).default("0"),
    overtimeRate: decimal("overtime_rate", { precision: 20, scale: 2 }).default("0"),
    shiftType: varchar("shift_type", { length: 50 }),
    active: boolean("active").notNull().default(true),
    bankName: varchar("bank_name", { length: 200 }),
    bankAccountNumber: varchar("bank_account_number", { length: 100 }),
    paymentMethod: varchar("payment_method", { length: 30 }).default("Cash"),
    photoUrl: text("photo_url"),
    notes: text("notes"),
    payFrequency: varchar("pay_frequency", { length: 20 }).default("Monthly"),
    hourlyRate: decimal("hourly_rate", { precision: 20, scale: 4 }).default("0"),
    weeklySalary: decimal("weekly_salary", { precision: 20, scale: 2 }).default("0"),
    biWeeklySalary: decimal("bi_weekly_salary", { precision: 20, scale: 2 }).default("0"),
    transportAllowance: decimal("transport_allowance", { precision: 20, scale: 2 }).default("0"),
    visaNumber: varchar("visa_number", { length: 100 }),
    visaExpiry: date("visa_expiry"),
    workPermitNumber: varchar("work_permit_number", { length: 100 }),
    workPermitExpiry: date("work_permit_expiry"),
    residentialPermit: varchar("residential_permit", { length: 100 }),
    residentialPermitExpiry: date("residential_permit_expiry"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_workers_company_idx").on(t.companyId),
    activeIdx: index("factory_workers_active_idx").on(t.active),
    codeIdx: index("factory_workers_code_idx").on(t.companyId, t.employeeCode),
  })
);

export const insertFactoryWorkerSchema = createInsertSchema(factoryWorkers)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    fullName: z.string().min(1, "Full name is required"),
    fatherName: z.string().optional().nullable(),
    motherName: z.string().optional().nullable(),
    nationalId: z.string().optional().nullable(),
    passportNumber: z.string().optional().nullable(),
    dateOfBirth: z.string().optional().nullable(),
    gender: z.string().optional().nullable(),
    nationality: z.string().optional().nullable(),
    maritalStatus: z.string().optional().nullable(),
    numberOfChildren: z.number().optional().nullable(),
    phone1: z.string().optional().nullable(),
    phone2: z.string().optional().nullable(),
    emergencyContactName: z.string().optional().nullable(),
    emergencyContactPhone: z.string().optional().nullable(),
    address: z.string().optional().nullable(),
    city: z.string().optional().nullable(),
    country: z.string().optional().nullable(),
    employeeCode: z.string().optional().nullable(),
    position: z.string().optional().nullable(),
    department: z.string().optional().nullable(),
    dateJoined: z.string().optional().nullable(),
    contractStartDate: z.string().optional().nullable(),
    contractEndDate: z.string().optional().nullable(),
    salaryType: z.enum(["Monthly", "Daily", "Per Bale", "Per KG"]).optional(),
    baseSalary: z.string().optional().nullable(),
    perBaleRate: z.string().optional().nullable(),
    perKgRate: z.string().optional().nullable(),
    overtimeRate: z.string().optional().nullable(),
    shiftType: z.string().optional().nullable(),
    active: z.boolean().optional(),
    bankName: z.string().optional().nullable(),
    bankAccountNumber: z.string().optional().nullable(),
    paymentMethod: z.enum(["Cash", "Bank", "Transfer"]).optional(),
    photoUrl: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    payFrequency: z.enum(["Monthly", "Hourly", "Weekly", "Bi-Weekly"]).optional(),
    hourlyRate: z.string().optional().nullable(),
    weeklySalary: z.string().optional().nullable(),
    biWeeklySalary: z.string().optional().nullable(),
    transportAllowance: z.string().optional().nullable(),
    visaNumber: z.string().optional().nullable(),
    visaExpiry: z.string().optional().nullable(),
    workPermitNumber: z.string().optional().nullable(),
    workPermitExpiry: z.string().optional().nullable(),
    residentialPermit: z.string().optional().nullable(),
    residentialPermitExpiry: z.string().optional().nullable(),
  });

export type InsertFactoryWorker = z.infer<typeof insertFactoryWorkerSchema>;
export type FactoryWorker = typeof factoryWorkers.$inferSelect;

// ─── Factory Payrolls ─────────────────────────────────────────────────────────
export const factoryPayrolls = pgTable(
  "factory_payrolls",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    workerId: integer("worker_id").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    baseSalary: decimal("base_salary", { precision: 20, scale: 2 }).default("0"),
    baleEarnings: decimal("bale_earnings", { precision: 20, scale: 2 }).default("0"),
    kgEarnings: decimal("kg_earnings", { precision: 20, scale: 2 }).default("0"),
    overtimePay: decimal("overtime_pay", { precision: 20, scale: 2 }).default("0"),
    bonuses: decimal("bonuses", { precision: 20, scale: 2 }).default("0"),
    transport: decimal("transport", { precision: 20, scale: 2 }).default("0"),
    deductions: decimal("deductions", { precision: 20, scale: 2 }).default("0"),
    advances: decimal("advances", { precision: 20, scale: 2 }).default("0"),
    netSalary: decimal("net_salary", { precision: 20, scale: 2 }).default("0"),
    balesCount: integer("bales_count").default(0),
    kgProcessed: decimal("kg_processed", { precision: 15, scale: 3 }).default("0"),
    overtimeHours: decimal("overtime_hours", { precision: 10, scale: 2 }).default("0"),
    totalWorkingDays: integer("total_working_days").default(0),
    presentDays: decimal("present_days", { precision: 10, scale: 1 }).default("0"),
    absentDays: decimal("absent_days", { precision: 10, scale: 1 }).default("0"),
    notes: text("notes"),
    status: varchar("status", { length: 30 }).notNull().default("DRAFT"),
    cashAccountId: integer("cash_account_id").references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    paidAt: timestamp("paid_at"),
    generatedAt: timestamp("generated_at").notNull().defaultNow(),
    approvedAt: timestamp("approved_at"),
    approvedBy: integer("approved_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_payrolls_company_idx").on(t.companyId),
    workerIdx: index("factory_payrolls_worker_idx").on(t.workerId),
    periodIdx: index("factory_payrolls_period_idx").on(t.periodStart, t.periodEnd),
  })
);

export const insertFactoryPayrollSchema = createInsertSchema(factoryPayrolls).omit({
  id: true,
  createdAt: true,
});

export type InsertFactoryPayroll = z.infer<typeof insertFactoryPayrollSchema>;
export type FactoryPayroll = typeof factoryPayrolls.$inferSelect;

// ─── Factory Attendance ───────────────────────────────────────────────────────
export const factoryAttendance = pgTable(
  "factory_attendance",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    workerId: integer("worker_id")
      .notNull()
      .references(() => factoryWorkers.id),
    attendanceDate: date("attendance_date").notNull(),
    shift: varchar("shift", { length: 50 }),
    status: varchar("status", { length: 20 }).notNull().default("Present"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyDateIdx: index("factory_attendance_company_date_idx").on(t.companyId, t.attendanceDate),
    uniqueWorkerDate: uniqueIndex("factory_attendance_worker_date_unique").on(t.workerId, t.attendanceDate),
  })
);

export const insertFactoryAttendanceSchema = createInsertSchema(factoryAttendance).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertFactoryAttendance = z.infer<typeof insertFactoryAttendanceSchema>;
export type FactoryAttendance = typeof factoryAttendance.$inferSelect;

// ─── Factory Worker Advances ──────────────────────────────────────────────────
export const factoryWorkerAdvances = pgTable(
  "factory_worker_advances",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    workerId: integer("worker_id")
      .notNull()
      .references(() => factoryWorkers.id),
    advanceDate: date("advance_date").notNull(),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
    remainingBalance: decimal("remaining_balance", { precision: 20, scale: 2 }).notNull().default("0"),
    cashAccountId: integer("cash_account_id").references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    notes: text("notes"),
    fullyPaid: boolean("fully_paid").notNull().default(false),
    repaymentType: varchar("repayment_type", { length: 30 }).notNull().default("salary_deduction"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_worker_advances_company_idx").on(t.companyId),
    workerIdx: index("factory_worker_advances_worker_idx").on(t.workerId),
  })
);

export const insertFactoryWorkerAdvanceSchema = createInsertSchema(factoryWorkerAdvances)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    workerId: z.number().min(1, "Worker is required"),
    advanceDate: z.string().min(1, "Advance date is required"),
    amount: z.string().min(1, "Amount is required"),
    notes: z.string().optional().nullable(),
    cashAccountId: z.number().optional().nullable(),
    repaymentType: z.enum(["salary_deduction", "manual_repayment"]).optional().default("salary_deduction"),
  });

export type InsertFactoryWorkerAdvance = z.infer<typeof insertFactoryWorkerAdvanceSchema>;
export type FactoryWorkerAdvance = typeof factoryWorkerAdvances.$inferSelect;

// ─── Factory Advance Repayments ───────────────────────────────────────────────
export const factoryAdvanceRepayments = pgTable(
  "factory_advance_repayments",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    advanceId: integer("advance_id")
      .notNull()
      .references(() => factoryWorkerAdvances.id, { onDelete: "cascade" }),
    workerId: integer("worker_id").notNull(),
    payrollId: integer("payroll_id"),
    repaymentDate: date("repayment_date").notNull(),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
    cashAccountId: integer("cash_account_id").references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    advanceIdx: index("factory_advance_repayments_advance_idx").on(t.advanceId),
    companyIdx: index("factory_advance_repayments_company_idx").on(t.companyId),
    payrollIdx: index("factory_advance_repayments_payroll_idx").on(t.payrollId),
  })
);

export const insertFactoryAdvanceRepaymentSchema = createInsertSchema(factoryAdvanceRepayments)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    advanceId: z.number().min(1, "Advance is required"),
    workerId: z.number().min(1, "Worker is required"),
    repaymentDate: z.string().min(1, "Repayment date is required"),
    amount: z.string().min(1, "Amount is required"),
    cashAccountId: z.number().optional().nullable(),
    notes: z.string().optional().nullable(),
  });

export type InsertFactoryAdvanceRepayment = z.infer<typeof insertFactoryAdvanceRepaymentSchema>;
export type FactoryAdvanceRepayment = typeof factoryAdvanceRepayments.$inferSelect;

// ─── Factory Worker Deductions ────────────────────────────────────────────────
export const factoryWorkerDeductions = pgTable(
  "factory_worker_deductions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    workerId: integer("worker_id")
      .notNull()
      .references(() => factoryWorkers.id),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
    reason: text("reason"),
    deductionDate: date("deduction_date").notNull(),
    applied: boolean("applied").notNull().default(false),
    payrollId: integer("payroll_id"),
    erpPayrollRunId: integer("erp_payroll_run_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_worker_deductions_company_idx").on(t.companyId),
    workerIdx: index("factory_worker_deductions_worker_idx").on(t.workerId),
  })
);

export const insertFactoryWorkerDeductionSchema = createInsertSchema(factoryWorkerDeductions)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    amount: z
      .string()
      .min(1, "Amount is required")
      .refine((v) => !isNaN(parseFloat(v)) && parseFloat(v) > 0, "Amount must be positive"),
    reason: z.string().optional().nullable(),
    deductionDate: z.string().min(1, "Date is required"),
  });

export type InsertFactoryWorkerDeduction = z.infer<typeof insertFactoryWorkerDeductionSchema>;
export type FactoryWorkerDeduction = typeof factoryWorkerDeductions.$inferSelect;

// ─── Factory Worker Documents ─────────────────────────────────────────────────
export const factoryWorkerDocuments = pgTable(
  "factory_worker_documents",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    workerId: integer("worker_id").notNull(),
    fileName: text("file_name").notNull(),
    originalName: text("original_name").notNull(),
    fileUrl: text("file_url").notNull(),
    fileType: text("file_type"),
    fileSize: integer("file_size"),
    fileData: text("file_data"),
    uploadedAt: timestamp("uploaded_at").defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_worker_documents_company_idx").on(t.companyId),
  })
);

export type FactoryWorkerDocument = typeof factoryWorkerDocuments.$inferSelect;
