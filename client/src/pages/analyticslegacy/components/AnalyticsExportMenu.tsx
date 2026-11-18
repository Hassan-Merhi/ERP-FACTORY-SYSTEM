import { RowsExportMenu } from "@/components/export/RowsExportMenu";

import { calculateNetAccountTotal } from "../accountMath";
import { hierarchicalAccountRows, netProfitAccountRows, type AnalyticsExportRow } from "../analyticsExportRows";
import type { AnalyticsLegacyState } from "../useAnalyticsLegacy";

const BALANCE_SECTIONS = {
  assets: { title: "Asset Accounts", list: "assetAccounts" },
  liabilities: { title: "Liability Accounts", list: "liabilityAccounts" },
  cash: { title: "Cash Accounts", list: "cashAccounts" },
  "loans-banks": { title: "Loans and Banks", list: "loansBanksAccounts" },
} as const;

const EXPENSE_TITLES: Record<string, string> = {
  expenses: "All Expense Accounts",
  "direct-expenses": "Direct Expense Accounts",
  "indirect-expenses": "Indirect Expense Accounts",
};

/**
 * Excel export of the open Analytics account table (balance and expense
 * sections): the rows on screen, including only the groups that are expanded,
 * and the table's total. Other sections have no export here.
 */
export function AnalyticsExportMenu({ analytics }: { analytics: AnalyticsLegacyState }) {
  const { activeSection, expandedAccounts, periodFilter, periodExpenses } = analytics;
  let title: string | null = null;
  let rows: AnalyticsExportRow[] = [];
  let total = 0;
  let amountHeader = "Balance";

  if (activeSection in BALANCE_SECTIONS) {
    const section = BALANCE_SECTIONS[activeSection as keyof typeof BALANCE_SECTIONS];
    const accounts = analytics[section.list];
    title = section.title;
    rows = hierarchicalAccountRows(accounts, expandedAccounts);
    total = calculateNetAccountTotal(accounts);
  } else if (activeSection in EXPENSE_TITLES && periodExpenses) {
    const report =
      activeSection === "expenses"
        ? {
            accounts: [...periodExpenses.direct.accounts, ...periodExpenses.indirect.accounts],
            total: periodExpenses.direct.total + periodExpenses.indirect.total,
          }
        : activeSection === "direct-expenses"
          ? periodExpenses.direct
          : periodExpenses.indirect;
    title = EXPENSE_TITLES[activeSection];
    rows = netProfitAccountRows(report.accounts, expandedAccounts);
    total = report.total;
    amountHeader = "Net Expense";
  }
  if (!title) return null;

  return (
    <RowsExportMenu
      title={title}
      period={{ from: periodFilter.fromDate, to: periodFilter.toDate }}
      rows={rows}
      columns={[
        { header: "Account Name", value: (row) => `${"    ".repeat(row.depth)}${row.name}` },
        { header: amountHeader, value: (row) => row.balance, type: "number" },
      ]}
      footer={["Total", total]}
      resource="erp.analytics"
      data-testid="button-export-analytics"
    />
  );
}
