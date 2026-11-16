// Extracted from ./FactoryEmployeeAdvancesTab.tsx to keep that module under the source-size cap.

export interface Employee {
  id: number;
  code: string;
  firstName: string;
  lastName: string;
}

export interface AdvanceRecord {
  id: number;
  employeeId: number;
  advanceDate: string;
  amount: string;
  remainingBalance: string;
  cashAccountId: number | null;
  cashAccountName: string | null;
  notes: string | null;
  fullyPaid: boolean;
  firstName: string;
  lastName: string;
  employeeCode: string;
}

export interface RepaymentRecord {
  id: number;
  advanceId: number;
  employeeId: number;
  repaymentDate: string;
  amount: string;
  notes: string | null;
  firstName: string;
  lastName: string;
}

export interface CashAccount {
  id: number;
  name: string;
  code: string;
}

export function fmt(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  return isNaN(n) ? "0.00" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const today = () => new Date().toLocaleDateString("en-CA");
