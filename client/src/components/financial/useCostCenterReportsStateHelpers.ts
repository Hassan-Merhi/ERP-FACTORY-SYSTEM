// Extracted from ./useCostCenterReportsState.tsx

type AmountRow = { expense: string; inventoryCost: string; budget: string; variance: string; entries?: number };

type TotalRow = AmountRow & { unallocated: string; recognizedExpense: string; unallocatedApplicable: boolean };

type CenterRow = AmountRow & {
  companyId: number;
  companyName: string;
  costCenterId: number;
  code: string;
  name: string;
  active: boolean;
  utilization: string | null;
};

type AccountRow = {
  companyId: number;
  accountId: number | null;
  accountName: string;
  expense: string;
  inventoryCost: string;
  entries: number;
};

type MonthRow = {
  month: string;
  expense: string;
  unallocated: string;
  inventoryCost: string;
  budget: string;
  variance: string;
};

export type Summary = {
  currency: string;
  scope: string;
  companyIds: number[];
  period: { from: string; to: string; budgetBasis: string };
  totals: TotalRow;
  centers: CenterRow[];
  departments: Array<CenterRow & { members: number }>;
  accounts: AccountRow[];
  months: MonthRow[];
};

export type Activity = {
  id: number;
  companyId: number;
  costCenterId: number;
  costCenterName: string;
  costCenterCode: string;
  accountId: number | null;
  accountName: string;
  voucherId: number | null;
  voucherNumber: string | null;
  voucherEntryId: number | null;
  factoryDaybookEntryId: number | null;
  sourceModule: string;
  sourceDate: string;
  treatment: string;
  allocationOrigin: string;
  currency: string;
  amountNative: string;
  amountUsd: string;
};

export type ExpenseAccount = { id: number; code: string; name: string };

export type BudgetRow = { id: number; costCenterId: number; month: string; amountUsd: string; notes: string | null };

export function dateStart(): string {
  const now = new Date();
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-01";
}

export const strictMoney = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/;
