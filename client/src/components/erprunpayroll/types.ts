/**
 * Types for the ERPRunPayroll page.
 *
 * Extracted from ERPRunPayroll.tsx during the Phase 4 god-file split.
 */

export interface Employee {
  id: number;
  code: string;
  firstName: string;
  lastName: string;
  department: string | null;
  employeeType: string;
  monthlySalary: string | null;
  active: boolean;
}

export interface WorkerGroup {
  id: number;
  name: string;
  groupType?: string | null;
  group_type?: string | null;
  members: { id: number }[];
}

export interface LedgerAccount {
  id: number;
  name: string;
  code: string;
  accountType: string;
}

export interface SalaryAdvance {
  id: number;
  employeeId: number;
  amount: string;
  remainingBalance: string;
  fullyPaid: boolean;
}

export interface PreviewItem {
  employeeId: number;
  employeeName: string;
  groupName: string;
  baseSalary: number;
  deduction: number;
  pendingDeductions: number;
  netPay: number;
}

export interface WorkerDeductionRow {
  workerId: number;
  amount: string;
  applied: boolean;
}

export interface PayrollRun {
  id: number;
  status: string;
  date: string;
  notes: string | null;
  paymentAccountId: number | null;
  paidAt: string | null;
  createdAt: string;
  itemCount: number;
  totalNet: string;
  totalBase: string;
  items: PayrollRunItem[];
}

export interface PayrollRunItem {
  id: number;
  runId: number;
  employeeId: number;
  employeeName: string;
  groupName: string | null;
  baseSalary: string;
  deduction: string;
  payrollDeduction: string;
  netPay: string;
}
