import { z } from "zod";
import { insertEmployeeSchema } from "@shared/schema";

export const depositSchema = z.object({
  amount: z.string().min(1, "Amount is required"),
  date: z.string().min(1, "Date is required"),
  notes: z.string().optional(),
});

export const withdrawalSchema = z.object({
  amount: z.string().min(1, "Amount is required"),
  paymentAccountType: z.enum(["bank", "cash"]),
  paymentAccountId: z.string().min(1, "Payment account is required"),
  date: z.string().min(1, "Date is required"),
  notes: z.string().optional(),
});

export const bulkPaymentSchema = z.object({
  paymentAccountType: z.enum(["bank", "cash"]),
  paymentAccountId: z.string().min(1, "Payment account is required"),
  date: z.string().min(1, "Date is required"),
  notes: z.string().optional(),
});

export const salaryAdvanceSchema = z
  .object({
    employeeId: z.string().min(1, "Employee is required"),
    amount: z
      .string()
      .min(1, "Amount is required")
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, "Amount must be positive"),
    advanceDate: z.date({
      error: "Advance date is required",
    }),
    cashAccountId: z.string().optional(),
    notes: z.string().optional(),
    isOpeningBalance: z.boolean().default(false),
  })
  .refine(
    (data) => {
      // Cash account is required only if NOT an opening balance
      if (!data.isOpeningBalance && !data.cashAccountId) {
        return false;
      }
      return true;
    },
    { message: "Cash account is required", path: ["cashAccountId"] }
  );

export const deductionSchema = z.object({
  deductionAmount: z
    .string()
    .min(1, "Deduction amount is required")
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, "Deduction amount must be positive"),
  payrollMonth: z
    .string()
    .min(1, "Payroll month is required")
    .regex(/^\d{4}-\d{2}$/, "Payroll month must be in format YYYY-MM (e.g., 2024-01)"),
});

export type DepositFormData = z.infer<typeof depositSchema>;
export type WithdrawalFormData = z.infer<typeof withdrawalSchema>;
export type BulkPaymentFormData = z.infer<typeof bulkPaymentSchema>;
export type SalaryAdvanceFormData = z.infer<typeof salaryAdvanceSchema>;
export type DeductionFormData = z.infer<typeof deductionSchema>;

export const workerFormSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().optional().default(""),
  code: z.string().optional(),
  monthlySalary: z
    .string()
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Monthly salary must be >= 0"),
  department: z.string().optional(),
  active: z.boolean().default(true),
});

export type WorkerFormData = z.infer<typeof workerFormSchema>;

// Employee form schema - omit companyId and employeeType since they're set in the mutation
export const employeeFormSchema = insertEmployeeSchema.omit({ companyId: true, employeeType: true }).extend({
  monthlySalary: z
    .string()
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Monthly salary must be >= 0"),
  openingBalance: z.string().optional(),
  employeeGroupId: z.string().optional(),
  salesBonusPct: z.string().optional(),
  salesBonusPctSourceCompanyId: z.string().optional(),
  salesBonusPctLocationId: z.string().optional(),
  balesBonusRate: z.string().optional(),
});

export type EmployeeFormData = z.infer<typeof employeeFormSchema>;

export interface SalaryAdvance {
  id: number;
  companyId: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  advanceDate: string;
  amount: string;
  remainingBalance: string;
  fullyPaid: boolean;
  isOpeningBalance?: boolean;
  voucherId?: number;
  notes?: string;
  createdAt: string;
}

export function getThisMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString("en-CA");
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toLocaleDateString("en-CA");
  return { start, end };
}

export const EMP_AVATAR_COLORS = [
  "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-900 dark:text-rose-300",
  "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300",
];
export function getEmpAvatarColor(name: string) {
  let hash = 0;
  for (const c of name) hash = c.charCodeAt(0) + ((hash << 5) - hash);
  return EMP_AVATAR_COLORS[Math.abs(hash) % EMP_AVATAR_COLORS.length];
}
export function getEmpInitials(firstName: string, lastName: string) {
  return `${firstName?.[0] || ""}${lastName?.[0] || ""}`.toUpperCase();
}
