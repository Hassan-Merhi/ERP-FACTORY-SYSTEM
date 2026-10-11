/**
 * Tabular forms of the financial statements for the Excel/PDF exports
 * (accounting audit phase 27, RP-1). Each mapper takes the service result the
 * page shows and lays it out as rows; it computes nothing new.
 */
import type { BalanceSheet, FinancialRatios, ProfitLossSections } from "../../reports/financialReportsService";
import { AGING_BUCKETS, type AgingReport } from "../../reports/agingReport";
import type { CashFlowSection, CashFlowStatement } from "./cashFlowStatement";
import type { PeriodTrialBalance } from "./periodTrialBalance";
import type { ReportTable, ReportTableRow } from "./reportExport";

const heading = (label: string): ReportTableRow => ({ cells: { name: label }, emphasis: "heading" });
const total = (label: string, amount: string, extra: Record<string, string> = {}): ReportTableRow => ({
  cells: { name: label, amount, ...extra },
  emphasis: "total",
});

export function trialBalanceTable(report: PeriodTrialBalance, companyName: string): ReportTable {
  const compare = report.comparativePeriod;
  const columns = [
    { key: "code", label: "Code" },
    { key: "name", label: "Account" },
    { key: "openingDebit", label: "Opening Dr", numeric: true },
    { key: "openingCredit", label: "Opening Cr", numeric: true },
    { key: "periodDebit", label: "Period Dr", numeric: true },
    { key: "periodCredit", label: "Period Cr", numeric: true },
    { key: "closingDebit", label: "Closing Dr", numeric: true },
    { key: "closingCredit", label: "Closing Cr", numeric: true },
    ...(compare
      ? [
          { key: "compareDebit", label: "Comparative Dr", numeric: true },
          { key: "compareCredit", label: "Comparative Cr", numeric: true },
        ]
      : []),
  ];
  const rows: ReportTableRow[] = report.rows.map((row) => ({
    cells: {
      code: row.code,
      name: row.name,
      openingDebit: row.openingDebit,
      openingCredit: row.openingCredit,
      periodDebit: row.periodDebit,
      periodCredit: row.periodCredit,
      closingDebit: row.closingDebit,
      closingCredit: row.closingCredit,
      compareDebit: row.comparative?.closingDebit ?? null,
      compareCredit: row.comparative?.closingCredit ?? null,
    },
  }));
  rows.push({
    cells: {
      name: "Total",
      ...report.totals,
      compareDebit: report.comparativeTotals?.closingDebit ?? null,
      compareCredit: report.comparativeTotals?.closingCredit ?? null,
    },
    emphasis: "total",
  });
  const notes = [`Unexplained difference: ${report.unexplainedDifference}`];
  if (report.futureDated.count > 0) {
    notes.push(
      `Vouchers dated after the business date ${report.futureDated.businessDate}: ${report.futureDated.count}`
    );
  }
  return {
    title: "Trial Balance",
    subtitle: `${companyName} · ${report.from} – ${report.to}${compare ? ` · comparative ${compare.from} – ${compare.to}` : ""}`,
    columns,
    rows,
    notes,
  };
}

export function balanceSheetTable(sheet: BalanceSheet, asOf: string, companyName: string): ReportTable {
  const rows: ReportTableRow[] = [];
  const sectionRows = (
    label: string,
    section: { lines: Array<{ code: string | null; name: string; balance: string }>; total: string }
  ) => {
    rows.push(heading(label));
    for (const line of section.lines) rows.push({ cells: { code: line.code, name: line.name, amount: line.balance } });
    rows.push(total(`Total ${label.toLowerCase()}`, section.total));
  };
  const classified = sheet.classified;
  sectionRows("Current assets", classified.currentAssets);
  sectionRows("Non-current assets", classified.nonCurrentAssets);
  rows.push(total("Total assets", classified.totals.assets));
  sectionRows("Current liabilities", classified.currentLiabilities);
  sectionRows("Non-current liabilities", classified.nonCurrentLiabilities);
  rows.push(total("Total liabilities", classified.totals.liabilities));
  rows.push(heading("Equity"));
  for (const line of sheet.equity.lines)
    rows.push({ cells: { code: line.code, name: line.name, amount: line.balance } });
  rows.push({ cells: { name: "Retained earnings (not yet closed)", amount: sheet.equity.retainedEarnings } });
  rows.push({ cells: { name: "Current year earnings", amount: sheet.equity.currentEarnings } });
  rows.push(total("Total equity", sheet.equity.total));
  if (sheet.unclassified.lines.length > 0) sectionRows("Unclassified", sheet.unclassified);
  rows.push(total("Net assets", classified.totals.netAssets));
  return {
    title: "Balance Sheet",
    subtitle: `${companyName} · as of ${asOf}`,
    columns: [
      { key: "code", label: "Code" },
      { key: "name", label: "Line" },
      { key: "amount", label: "Amount", numeric: true },
    ],
    rows,
    notes: [`Difference: ${sheet.difference}`],
  };
}

interface ProfitLossLike {
  incomeItems: Array<{ code: string; name: string; balance: number }>;
  expenseItems: Array<{ code: string; name: string; balance: number }>;
  sections: ProfitLossSections;
}

export function profitLossTable(report: ProfitLossLike, period: string, companyName: string): ReportTable {
  const amount = (value: number) => value.toFixed(2);
  const rows: ReportTableRow[] = [heading("Income")];
  for (const item of report.incomeItems)
    rows.push({ cells: { code: item.code, name: item.name, amount: amount(item.balance) } });
  rows.push(heading("Expenses"));
  for (const item of report.expenseItems)
    rows.push({ cells: { code: item.code, name: item.name, amount: amount(item.balance) } });
  const s = report.sections;
  rows.push(total("Revenue", s.revenue));
  rows.push(total("Cost of sales", s.costOfSales));
  rows.push(total("Gross profit", s.grossProfit));
  rows.push(total("Other income", s.otherIncome));
  rows.push(total("Operating expenses", s.operatingExpenses));
  rows.push(total("Net profit", s.netProfit));
  return {
    title: "Profit and Loss",
    subtitle: `${companyName} · ${period}`,
    columns: [
      { key: "code", label: "Code" },
      { key: "name", label: "Account" },
      { key: "amount", label: "Amount", numeric: true },
    ],
    rows,
  };
}

export function agingTable(report: AgingReport, companyName: string): ReportTable {
  const buckets = AGING_BUCKETS.filter((bucket) => bucket in report.totals.buckets);
  const columns = [
    { key: "code", label: "Code" },
    { key: "name", label: "Party" },
    { key: "balance", label: "Balance", numeric: true },
    ...buckets.map((bucket) => ({ key: bucket, label: bucket, numeric: true })),
  ];
  const rows: ReportTableRow[] = report.parties.map((party) => ({
    cells: { code: party.code, name: party.name, balance: party.balance, ...party.buckets },
  }));
  rows.push({ cells: { name: "Total", balance: report.totals.balance, ...report.totals.buckets }, emphasis: "total" });
  return {
    title: `Aging (${report.kind})`,
    subtitle: `${companyName} · reference date ${report.referenceDate}`,
    columns,
    rows,
  };
}

export function ratiosTable(report: FinancialRatios, period: string, companyName: string): ReportTable {
  const r = (value: number) => value.toFixed(2);
  const rows: ReportTableRow[] = [
    { cells: { name: "Gross profit margin %", amount: r(report.ratios.grossProfitMargin) } },
    { cells: { name: "Net profit margin %", amount: r(report.ratios.netProfitMargin) } },
    { cells: { name: "Current ratio", amount: r(report.ratios.currentRatio) } },
    { cells: { name: "Debt to equity", amount: r(report.ratios.debtToEquity) } },
    heading("Underlying figures"),
    { cells: { name: "Revenue", amount: report.exact.revenue } },
    { cells: { name: "Cost of sales", amount: report.exact.costOfSales } },
    { cells: { name: "Gross profit", amount: report.exact.grossProfit } },
    { cells: { name: "Net profit", amount: report.exact.netProfit } },
    { cells: { name: "Current assets", amount: report.exact.currentAssets } },
    { cells: { name: "Current liabilities", amount: report.exact.currentLiabilities } },
    { cells: { name: "Total assets", amount: report.exact.totalAssets } },
    { cells: { name: "Total liabilities", amount: report.exact.totalLiabilities } },
    { cells: { name: "Net assets", amount: report.exact.netAssets } },
  ];
  return {
    title: "Financial Ratios",
    subtitle: `${companyName} · ${period}`,
    columns: [
      { key: "name", label: "Ratio" },
      { key: "amount", label: "Value", numeric: true },
    ],
    rows,
  };
}

export function cashFlowTable(report: CashFlowStatement, companyName: string): ReportTable {
  const rows: ReportTableRow[] = [];
  const lines = (section: CashFlowSection) => {
    for (const line of section.lines) rows.push({ cells: { code: line.code, name: line.name, amount: line.amount } });
  };
  rows.push(heading("Operating activities"));
  rows.push({ cells: { name: "Net profit", amount: report.operating.netProfit } });
  lines(report.operating.depreciation);
  lines(report.operating.workingCapital);
  rows.push(total("Net cash from operating activities", report.operating.total));
  rows.push(heading("Investing activities"));
  lines(report.investing);
  rows.push(total("Net cash from investing activities", report.investing.total));
  rows.push(heading("Financing activities"));
  lines(report.financing);
  rows.push(total("Net cash from financing activities", report.financing.total));
  if (report.unclassified.lines.length > 0) {
    rows.push(heading("Unclassified"));
    lines(report.unclassified);
    rows.push(total("Unclassified total", report.unclassified.total));
  }
  rows.push(total("Net change in cash (computed)", report.computedNetChange));
  rows.push(total("Cash at the start of the period", report.cash.opening));
  rows.push(total("Cash at the end of the period", report.cash.closing));
  return {
    title: "Cash Flow Statement",
    subtitle: `${companyName} · ${report.from} – ${report.to} · indirect method`,
    columns: [
      { key: "code", label: "Code" },
      { key: "name", label: "Line" },
      { key: "amount", label: "Amount", numeric: true },
    ],
    rows,
    notes: [`Cash: ${report.cashDefinition}`, `Difference (unbalanced lines): ${report.difference}`],
  };
}
