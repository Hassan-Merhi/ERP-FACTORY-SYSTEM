/**
 * Types for the FactoryPayrollTab page.
 */
import { type Dispatch, type SetStateAction } from "react";

export interface PayrollRecord {
  id: number;
  workerId: number;
  periodStart: string;
  periodEnd: string;
  baseSalary: string;
  bonuses: string;
  productionBonus: string;
  pendingProductionBonus: string;
  rejectedProductionBonus: string;
  suggestedProductionBonus: string;
  productionBonusPendingCount: number;
  productionBonusApprovedCount: number;
  productionBonusRejectedCount: number;
  otherBonuses: string;
  deductions: string;
  advances: string;
  netSalary: string;
  status: string;
  cashAccountId: number | null;
  paidAt: string | null;
  notes: string | null;
  totalWorkingDays?: number;
  presentDays?: string;
  absentDays?: string;
  worker?: { id: number; fullName: string; employeeCode: string | null; position: string | null };
}

export interface CashAccount {
  id: number;
  name: string;
  code: string;
}

export interface AttendanceEntry {
  date: string;
  status: string;
}

export interface PendingAdvance {
  id: number;
  advanceDate: string;
  amount: string;
  remainingBalance: string;
  notes: string | null;
}

export interface PreviewWorkerRow {
  id: number;
  employeeCode: string | null;
  name: string;
  position: string | null;
  base: number;
  bonus: number;
  transport: number;
  transportMonthly: number;
  advanceDeduction: number;
  totalAdvanceBalance: number;
  pendingAdvances: PendingAdvance[];
  pendingDeductions: number;
  pendingDeductionRecords: { id: number; amount: string; reason: string | null; deductionDate: string }[];
  outstandingLoans: PendingAdvance[];
  totalLoanBalance: number;
  net: number;
  totalWorkingDays: number;
  presentDays: number;
  absentDays: number;
  presentDates: AttendanceEntry[];
  absentDates: AttendanceEntry[];
  halfDayDates: AttendanceEntry[];
}

export interface PayrollGroup {
  key: string;
  periodStart: string;
  periodEnd: string;
  records: PayrollRecord[];
}

export interface BatchRowProps {
  group: PayrollGroup;
  expanded: Set<string>;
  toggleGroup: (key: string) => void;
  selectedIds: Set<number>;
  setSelectedIds: Dispatch<SetStateAction<Set<number>>>;
  setPayTargetId: (id: number) => void;
  setPayCashAccountId: (v: string) => void;
  setPayOpen: (v: boolean) => void;
  setFixAcctTargetId: (id: number) => void;
  setFixAcctCashId: (v: string) => void;
  setFixAcctOpen: (v: boolean) => void;
  setUndoTargetId: (id: number) => void;
  setDeleteTargetId: (id: number) => void;
  setDeleteBatchGroup: (g: PayrollGroup) => void;
  formatDisplayDate: (d: string | Date) => string;
  condensed?: boolean;
  isDeveloper?: boolean;
}
