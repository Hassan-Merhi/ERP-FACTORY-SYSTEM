import type { Employee } from "@shared/schema";

export interface AccountOption {
  id: number;
  name?: string;
  accountName?: string;
  bankName?: string;
  accountType?: string;
  code?: string;
  accountNumber?: string | null;
}

export interface EmployeeGroup {
  id: number;
  name: string;
  description?: string | null;
  groupType?: string | null;
}

export interface WorkerGroup {
  id: number;
  name: string;
  members: Employee[];
}

export interface EmployeeTransaction {
  id?: number;
  voucherId?: number;
  voucherDescription?: string | null;
  voucherType?: string | null;
  narration?: string | null;
  debitAmount?: string | number | null;
  debit?: string | number | null;
  creditAmount?: string | number | null;
  credit?: string | number | null;
  voucherDate?: string | null;
  date?: string | null;
  description?: string | null;
  amount: number;
  isDebit: boolean;
}

export interface BaleRateResponse {
  locationId: number;
  sourceCompanyId?: number | null;
  rate?: number | string;
  pct?: number | string;
}

export interface SalesPreview {
  totalSalesAmount: string;
  totalQuantity: string;
  locationName: string;
}

export interface BaleBonusRow {
  locationId: string;
  sourceCompanyId: string;
  qty: string;
  rate: string;
  preview: string | null;
  loading: boolean;
}

export interface EmployeeDeleteConflict {
  employee: Employee;
  employeeBalance: number;
  ledgerBalance: number;
}
