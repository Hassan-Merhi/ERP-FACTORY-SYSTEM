/**
 * Types for the FactoryWorkerDetail page.
 *
 * Extracted from FactoryWorkerDetail.tsx during the Phase 4 god-file split.
 */
import type { FactoryWorker, FactoryWorkerAdvance } from "@shared/schema";

export interface WorkerWithStats extends FactoryWorker {
  stats?: {
    totalBales: number;
    totalKg: string;
    totalEarnings: string;
    payrollCount: number;
  };
}

export interface WorkerStats {
  workerId: number;
  workerName: string;
  salaryType: string;
  totalBales: number;
  totalKg: string;
  estimatedEarnings: string;
  totalPaid: string;
  payrollCount: number;
  recentPayrolls: unknown[];
}

export interface PayrollRecord {
  id: number;
  workerId: number;
  periodStart: string;
  periodEnd: string;
  baseSalary: string;
  bonuses: string;
  deductions: string;
  advances: string;
  netSalary: string;
  status: string;
  cashAccountId: number | null;
  paidAt: string | null;
  notes: string | null;
  transport?: string | null;
}

export interface CashAccount {
  id: number;
  name: string;
  code: string;
}

export interface AdvanceRowProps {
  adv: FactoryWorkerAdvance;
  isLoan: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  /** Omitted for roles that cannot change existing records. */
  onRepay?: () => void;
  formatDate: (d: string | null | undefined) => string;
  fmt: (v: string | number | null | undefined) => string;
}
