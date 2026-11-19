// Extracted from ./FactoryEmployeeDetail.tsx to keep that module under the source-size cap.
import { formatUsd } from "@/lib/moneyDisplay";

export interface Employee {
  id: number;
  code: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  department: string | null;
  monthlySalary: string;
  currentBalance: string;
  totalDeposits: string;
  totalWithdrawals: string;
  active: boolean;
  joinDate: string;
  employeeType: string;
}

export interface StatementRow {
  id: number;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  voucherType: string;
  description: string;
  narration: string;
  credit: number;
  debit: number;
  balance: number;
}

export interface LedgerAccount {
  id: number;
  name: string;
  code: string;
  accountType: string;
}

export function fmt(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  return isNaN(n) ? "$0.00" : formatUsd(n, 2);
}

export const EMPLOYEE_DETAIL_TABS = ["profile", "statement", "advances", "attendance"] as const;
export type EmployeeDetailTab = (typeof EMPLOYEE_DETAIL_TABS)[number];
