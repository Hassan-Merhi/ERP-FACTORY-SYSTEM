/**
 * Chat report cases on the report services (accounting audit phase 27, RP-13).
 *
 * The chat's P&L summary, cash position, trial balance, cash flow summary and
 * ledger account balance kept their own SQL and float sums, so the chat could
 * answer with a figure no statement showed. They now call the services the
 * statement pages use (getProfitLoss, the classified balance sheet, the period
 * trial balance, the cash flow statement and the engine's ledger rows) and
 * only format the exact results.
 */
import { sql } from "drizzle-orm";

import { db } from "../../../db";
import { toMoney } from "../../../lib/money";
import { getProfitLoss } from "../../../services/reports/financialReportsService";
import { buildClassifiedBalanceSheet } from "../../../services/accounting/reporting/classifiedBalanceSheet";
import { buildPeriodTrialBalance } from "../../../services/accounting/reporting/periodTrialBalance";
import { buildCashFlowStatement } from "../../../services/accounting/reporting/cashFlowStatement";
import { engineOpeningAt, ledgerOwnership } from "../../../services/accounting/reporting/ledgerMonthlySummary";
import type { DataQueryContext, DataQueryResult } from "../types";

const amount = (ctx: DataQueryContext, value: string) => ctx.fmt(toMoney(value).toNumber());
const tone = (value: string) => (toMoney(value).isNegative() ? "negative" : "positive");

export async function profitLossSummaryReport(ctx: DataQueryContext): Promise<DataQueryResult> {
  const { sections } = await getProfitLoss(ctx.companyId, ctx.dateFrom, ctx.dateTo);
  return {
    queryType: "pl_summary",
    title: "Profit & Loss Summary",
    subtitle: `${ctx.dateFrom} to ${ctx.dateTo}`,
    stats: [
      { label: "Revenue", value: amount(ctx, sections.revenue), highlight: tone(sections.revenue) },
      { label: "Cost of Goods Sold", value: amount(ctx, sections.costOfSales), highlight: "muted" },
      { label: "Gross Profit", value: amount(ctx, sections.grossProfit), highlight: tone(sections.grossProfit) },
      { label: "Other Income", value: amount(ctx, sections.otherIncome), highlight: "muted" },
      { label: "Operating Expenses", value: amount(ctx, sections.operatingExpenses), highlight: "muted" },
      { label: "Net Profit / (Loss)", value: amount(ctx, sections.netProfit), highlight: tone(sections.netProfit) },
    ],
  };
}

export async function cashPositionReport(ctx: DataQueryContext): Promise<DataQueryResult> {
  const sheet = await buildClassifiedBalanceSheet(ctx.companyId, ctx.todayStr);
  const lines = [...sheet.currentAssets.lines, ...sheet.currentLiabilities.lines].filter((line) => line.cash);
  const stats = lines.map((line) => {
    // Debit positive: an overdrawn account (a liability line) is negative cash.
    const balance = line.section === "currentAssets" ? line.balance : toMoney(line.balance).negated().toFixed(2);
    return {
      label: `${line.name} (${line.accountType ?? line.kind})`,
      value: amount(ctx, balance),
      highlight: tone(balance),
    };
  });
  stats.push({ label: "TOTAL CASH & BANK", value: amount(ctx, sheet.totals.cash), highlight: tone(sheet.totals.cash) });
  return { queryType: "cash_position", title: "Cash & Bank Positions", subtitle: `As of ${ctx.todayStr}`, stats };
}

export async function trialBalanceReport(ctx: DataQueryContext): Promise<DataQueryResult> {
  const report = await buildPeriodTrialBalance({ companyId: ctx.companyId, from: ctx.dateFrom, to: ctx.dateTo });
  const rows = report.rows.map((row) => [
    row.code || "—",
    row.name,
    row.accountType ?? row.kind,
    amount(ctx, row.periodDebit),
    amount(ctx, row.periodCredit),
    toMoney(row.closingDebit).isZero() ? "—" : amount(ctx, row.closingDebit),
    toMoney(row.closingCredit).isZero() ? "—" : amount(ctx, row.closingCredit),
  ]);
  const t = report.totals;
  rows.push([
    "",
    "GRAND TOTAL",
    "",
    amount(ctx, t.periodDebit),
    amount(ctx, t.periodCredit),
    amount(ctx, t.closingDebit),
    amount(ctx, t.closingCredit),
  ]);
  return {
    queryType: "trial_balance",
    title: "Trial Balance",
    subtitle: `${report.from} → ${report.to}`,
    stats: [
      { label: "Total Accounts", value: String(report.rows.length) },
      { label: "Total Debits", value: amount(ctx, t.periodDebit) },
      { label: "Total Credits", value: amount(ctx, t.periodCredit) },
      {
        label: "Unexplained Difference",
        value: amount(ctx, report.unexplainedDifference),
        highlight: report.balanced ? "positive" : "negative",
      },
    ],
    table: { headers: ["Code", "Account", "Type", "Debit", "Credit", "Dr Balance", "Cr Balance"], rows },
    noData: report.rows.length === 0,
  };
}

export async function cashFlowSummaryReport(ctx: DataQueryContext): Promise<DataQueryResult> {
  const report = await buildCashFlowStatement({ companyId: ctx.companyId, from: ctx.dateFrom, to: ctx.dateTo });
  const rows = report.cash.accounts.map((line) => [line.name, line.accountType ?? line.kind, amount(ctx, line.amount)]);
  return {
    queryType: "cash_flow_summary",
    title: "Cash Flow Summary",
    subtitle: `${report.from} → ${report.to} · indirect method`,
    stats: [
      { label: "Cash at Start", value: amount(ctx, report.cash.opening) },
      {
        label: "Operating Activities",
        value: amount(ctx, report.operating.total),
        highlight: tone(report.operating.total),
      },
      {
        label: "Investing Activities",
        value: amount(ctx, report.investing.total),
        highlight: tone(report.investing.total),
      },
      {
        label: "Financing Activities",
        value: amount(ctx, report.financing.total),
        highlight: tone(report.financing.total),
      },
      {
        label: "Net Change in Cash",
        value: amount(ctx, report.cash.netChange),
        highlight: tone(report.cash.netChange),
      },
      { label: "Cash at End", value: amount(ctx, report.cash.closing) },
    ],
    table: { headers: ["Account", "Type", "Closing"], rows },
    noData: rows.length === 0,
  };
}

export async function ledgerAccountBalanceReport(ctx: DataQueryContext): Promise<DataQueryResult> {
  const name = ctx.params.entityName || ctx.params.locationName;
  if (!name) {
    return {
      queryType: "ledger_account_balance",
      title: "Ledger Account Balance",
      summary: "Please specify an account name.",
    };
  }
  const found = await db.execute<{ id: number; name: string; account_type: string; code: string | null }>(sql`
    SELECT id, name, account_type, code FROM ledger_accounts
     WHERE company_id = ${ctx.companyId} AND deleted_at IS NULL AND name ILIKE ${"%" + name + "%"}
     ORDER BY name LIMIT 1
  `);
  const account = found.rows[0];
  if (!account) {
    return {
      queryType: "ledger_account_balance",
      title: "Ledger Account Balance",
      summary: `No account found matching "${name}".`,
    };
  }
  const owner = await ledgerOwnership(ctx.companyId, account.id);
  const opening = await engineOpeningAt(ctx.companyId, owner, ctx.dateFrom);
  const lines = await db.execute<{
    booked_on: string;
    voucher_type: string;
    voucher_number: string;
    description: string | null;
    dr: string | null;
    cr: string | null;
  }>(sql`
    SELECT COALESCE(v.effective_date, v.voucher_date)::text AS booked_on, v.voucher_type, v.voucher_number,
           v.description, ve.debit_amount::text AS dr, ve.credit_amount::text AS cr
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.company_id = ${ctx.companyId} AND v.deleted_at IS NULL AND v.optional = false
       AND COALESCE(v.effective_date, v.voucher_date) BETWEEN ${ctx.dateFrom}::date AND ${ctx.dateTo}::date
       AND ${owner.lines}
     ORDER BY 1, v.id, ve.id
     LIMIT ${ctx.rowLimit}
  `);
  let running = opening;
  let totalDebit = toMoney(0);
  let totalCredit = toMoney(0);
  const side = (value: typeof running) => `${ctx.fmt(value.abs().toNumber())} ${value.isNegative() ? "Cr" : "Dr"}`;
  const rows = lines.rows.map((line) => {
    const dr = toMoney(line.dr);
    const cr = toMoney(line.cr);
    running = running.plus(dr).minus(cr);
    totalDebit = totalDebit.plus(dr);
    totalCredit = totalCredit.plus(cr);
    return [
      line.booked_on.slice(0, 10),
      line.voucher_number,
      line.voucher_type,
      (line.description || "").slice(0, 35),
      dr.isZero() ? "—" : ctx.fmt(dr.toNumber()),
      cr.isZero() ? "—" : ctx.fmt(cr.toNumber()),
      side(running),
    ];
  });
  return {
    queryType: "ledger_account_balance",
    title: `Ledger: ${account.name}`,
    subtitle: `${ctx.dateFrom} → ${ctx.dateTo}`,
    stats: [
      { label: "Account", value: `${account.code ? account.code + " — " : ""}${account.name}` },
      { label: "Type", value: account.account_type },
      { label: "Opening Balance", value: side(opening) },
      { label: "Total Debit", value: ctx.fmt(totalDebit.toNumber()) },
      { label: "Total Credit", value: ctx.fmt(totalCredit.toNumber()) },
      { label: "Closing Balance", value: side(running), highlight: "positive" },
    ],
    table: { headers: ["Date", "Voucher #", "Type", "Description", "Dr", "Cr", "Balance"], rows },
    noData: rows.length === 0,
  };
}
