// Extracted from ./AgentStatementPanel.tsx to keep that module under the source-size cap.
import type { PeriodFilterValue } from "@/components/ui/period-filter";
import type { Account, GroupedVoucher } from "./agentStatementMath";

const VOUCHER_TYPE_COLORS: Record<string, string> = {
  Payment: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  Receipt: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  Journal: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  Invoice: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  Purchase: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
};

export function voucherBadgeClass(type: string) {
  return VOUCHER_TYPE_COLORS[type] ?? "bg-muted text-muted-foreground";
}

export interface AgentStatementPanelProps {
  companyName: string | undefined;
  selectedAccount: Account;
  fxWallet?: {
    state: { usd: string; eur: string; eurBookUsd: string };
    currentUsd: string | null;
    synchronized: boolean;
  };
  periodFilter: PeriodFilterValue;
  onPeriodChange: (value: PeriodFilterValue) => void;
  transactionsLoading: boolean;
  vouchersWithBalance: GroupedVoucher[];
  openingBalance: number;
  periodDebit: number;
  periodCredit: number;
  closingBalance: number;
  onExportExcel: () => void;
  onClearAccount: () => void;
  formatAmount: (value: number) => string;
  formatDisplayDate: (date: Date | string) => string;
  /** Phone layout: the statement is its own screen with Back to the agent list. */
  phone?: boolean;
}
