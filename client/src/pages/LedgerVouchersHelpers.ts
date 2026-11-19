// Extracted from ./LedgerVouchers.tsx
import { format, startOfMonth, endOfMonth } from "date-fns";
import { PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";

interface VoucherEntry {
  id: number;
  voucherId: number;
  date: string;
  particulars: string;
  voucherType: string;
  voucherNumber: string;
  voucherDescription?: string | null;
  createdAt?: string | Date | null;
  companyId?: number;
  debit: number;
  credit: number;
}

export interface LedgerVouchersData {
  account: {
    id: number;
    code: string;
    name: string;
  };
  month: number;
  monthName: string;
  year: number;
  openingBalance: number;
  vouchers: VoucherEntry[];
  totals: {
    debit: number;
    credit: number;
  };
  closingBalance: number;
}

export const voucherTypeColors: Record<string, string> = {
  Payment: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  Receipt: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  Journal: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  "Stock Transfer": "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
  Production: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
  Consumption: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  "Purchase Import": "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-400",
};

export function getInitialPeriodValue(year: number | null, month: number | null): PeriodFilterValue {
  if (year && month) {
    const monthDate = new Date(year, month - 1, 1);
    return {
      fromDate: format(startOfMonth(monthDate), "yyyy-MM-dd"),
      toDate: format(endOfMonth(monthDate), "yyyy-MM-dd"),
      preset: "custom",
    };
  }
  return getDefaultPeriodValue("today");
}
