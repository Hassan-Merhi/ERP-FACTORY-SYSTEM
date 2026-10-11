import { pgTable, text, varchar, serial, integer, decimal, date, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { companies, locations } from "../common";
import { stockGroups } from "../inventory";

export const employees = pgTable(
  "employees",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    code: varchar("code", { length: 50 }).notNull().unique(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    joinDate: date("join_date").notNull(),
    department: text("department"),
    employeeType: text("employee_type").notNull().default("Employee"),
    monthlySalary: decimal("monthly_salary", { precision: 15, scale: 2 }).notNull().default("0"),
    openingBalance: decimal("opening_balance", { precision: 15, scale: 2 }).default("0"),
    currentBalance: decimal("current_balance", { precision: 15, scale: 2 }).notNull().default("0"),
    totalDeposits: decimal("total_deposits", { precision: 15, scale: 2 }).notNull().default("0"),
    totalWithdrawals: decimal("total_withdrawals", { precision: 15, scale: 2 }).notNull().default("0"),
    active: boolean("active").notNull().default(true),
    salesBonusPct: decimal("sales_bonus_pct", { precision: 10, scale: 4 }),
    salesBonusPctSourceCompanyId: integer("sales_bonus_pct_source_company_id").references(() => companies.id),
    salesBonusPctLocationId: integer("sales_bonus_pct_location_id").references(() => locations.id, {
      onDelete: "restrict",
    }),
    balesBonusRate: decimal("bales_bonus_rate", { precision: 10, scale: 4 }),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("employees_company_idx").on(t.companyId),
  })
);

export const insertEmployeeSchema = createInsertSchema(employees)
  .omit({
    id: true,
    createdAt: true,
    currentBalance: true,
    totalDeposits: true,
    totalWithdrawals: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    code: z.string().optional(),
    firstName: z
      .string()
      .min(1, "First name is required")
      .refine((val) => val.trim().length > 0, "First name cannot be only whitespace"),
    lastName: z
      .string()
      .min(1, "Last name is required")
      .refine((val) => val.trim().length > 0, "Last name cannot be only whitespace"),
    email: z.string().email("Invalid email format").optional().or(z.literal("")),
    joinDate: z
      .string()
      .min(1, "Starting date is required")
      .refine((val) => {
        const regex = /^\d{4}-\d{2}-\d{2}$/;
        if (!regex.test(val)) return false;
        const d = new Date(val);
        return !isNaN(d.getTime()) && val === d.toISOString().split("T")[0];
      }, "Date must be a valid date in YYYY-MM-DD format"),
    employeeType: z.enum(["Employee", "Worker"]),
  });

export type InsertEmployee = z.infer<typeof insertEmployeeSchema>;
export type Employee = typeof employees.$inferSelect;

export const employeeGroups = pgTable(
  "employee_groups",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    groupType: text("group_type").notNull().default("Employee"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("employee_groups_company_idx").on(t.companyId),
  })
);

export const insertEmployeeGroupSchema = createInsertSchema(employeeGroups)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    name: z
      .string()
      .min(1, "Group name is required")
      .refine((val) => val.trim().length > 0, "Group name cannot be only whitespace"),
    description: z.string().optional(),
    groupType: z.enum(["Employee", "Worker"]).default("Employee"),
  });

export type InsertEmployeeGroup = z.infer<typeof insertEmployeeGroupSchema>;
export type EmployeeGroup = typeof employeeGroups.$inferSelect;

export const employeeGroupMembers = pgTable("employee_group_members", {
  id: serial("id").primaryKey(),
  employeeGroupId: integer("employee_group_id").notNull(),
  employeeId: integer("employee_id")
    .notNull()
    .references(() => employees.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertEmployeeGroupMemberSchema = createInsertSchema(employeeGroupMembers)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    employeeGroupId: z.number().min(1, "Employee group is required"),
    employeeId: z.number().min(1, "Employee is required"),
  });

export type InsertEmployeeGroupMember = z.infer<typeof insertEmployeeGroupMemberSchema>;
export type EmployeeGroupMember = typeof employeeGroupMembers.$inferSelect;

export const suppliers = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  legalName: text("legal_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  address: text("address"),
  taxId: text("tax_id"),
  paymentTerms: text("payment_terms"),
  // Phase 25 (AR-4): days from an invoice's booked date to its due date; NULL = 30.
  paymentTermsDays: integer("payment_terms_days"),
  openingBalance: decimal("opening_balance", { precision: 15, scale: 2 }).default("0"),
  active: boolean("active").notNull().default(true),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  stockGroupId: integer("stock_group_id").references(() => stockGroups.id, { onDelete: "set null" }),
});

export const insertSupplierSchema = createInsertSchema(suppliers)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    code: z.string().optional(),
    legalName: z.string().min(1, "Legal name is required"),
    email: z.string().email("Invalid email format").optional().or(z.literal("")),
    phone: z.string().optional(),
    address: z.string().optional(),
    taxId: z.string().optional(),
    paymentTerms: z.string().optional(),
    paymentTermsDays: z.number().int().positive().optional().nullable(),
    openingBalance: z.string().optional(),
  });

export type InsertSupplier = z.infer<typeof insertSupplierSchema>;
export type Supplier = typeof suppliers.$inferSelect;
