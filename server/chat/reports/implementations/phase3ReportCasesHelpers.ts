// Extracted from ./phase3ReportCases.ts
import { db, sql, accountTypesOfClassSql } from "./reportShardSupport";
import { toMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";
import { notFiscalClosingVoucher } from "../../../services/accounting/balances/periodReportRules";

export async function runPhase3CreditNotesSummary({
  companyId,
  dateFrom,
  dateTo,
  rowLimit,
  fmtDec,
  fmt,
}: {
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  rowLimit: DataQueryContext["rowLimit"];
  fmtDec: DataQueryContext["fmtDec"];
  fmt: DataQueryContext["fmt"];
}) {
  const rows = await db.execute<{
    voucher_date: string;
    description: string | null;
    item_name: string;
    uom: string;
    location: string;
    qty: string;
    rate: string;
    total_value: string;
  }>(sql`
        SELECT v.voucher_date, v.description,
          si.name AS item_name, si.uom,
          l.name AS location,
          CAST(cni.quantity AS numeric) AS qty,
          CAST(cni.rate AS numeric) AS rate,
          CAST(cni.total_value AS numeric) AS total_value
        FROM credit_note_items cni
        JOIN vouchers v ON v.id = cni.voucher_id AND v.deleted_at IS NULL
        JOIN stock_items si ON si.id = cni.stock_item_id
        JOIN locations l ON l.id = cni.location_id
        WHERE si.company_id = ${companyId}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY v.voucher_date DESC
        LIMIT ${rowLimit}
      `);
  let totValue = 0;
  const tableRows2 = rows.rows.map((r) => {
    const val = toMoney(r.total_value).toNumber();
    totValue += val;
    return [
      String(r.voucher_date).slice(0, 10),
      r.item_name,
      r.location,
      `${fmtDec(toMoney(r.qty).toNumber())} ${r.uom}`,
      fmtDec(toMoney(r.rate).toNumber()),
      fmt(val),
      (r.description || "").slice(0, 35),
    ];
  });
  return {
    queryType: "credit_notes_summary",
    title: "Credit Notes",
    subtitle: `${dateFrom} → ${dateTo} · Total returned: ${fmt(totValue)}`,
    table: {
      headers: ["Date", "Item", "Location", "Qty", "Rate", "Value", "Description"],
      rows: tableRows2,
    },
    noData: tableRows2.length === 0,
  };
}

export async function runPhase3ExpenseBreakdown({
  companyId,
  dateFrom,
  dateTo,
  rowLimit,
  fmt,
}: {
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
}) {
  const rows = await db.execute<{ name: string; account_type: string; net_spend: string | null }>(sql`
        SELECT la.name, la.account_type,
          SUM(CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric)) AS net_spend
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL AND v.optional = false
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE la.company_id = ${companyId}
          AND v.company_id = ${companyId}
          AND ${notFiscalClosingVoucher("v")}
          AND LOWER(TRIM(la.account_type)) IN (${accountTypesOfClassSql("expense")})
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY la.id, la.name, la.account_type
        HAVING SUM(CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric)) > 0
        ORDER BY net_spend DESC
        LIMIT ${rowLimit}
      `);
  let grandSpend = 0;
  const tableRows2 = rows.rows.map((r) => {
    const spend = toMoney(r.net_spend).toNumber();
    grandSpend += spend;
    return [r.name, r.account_type, fmt(spend)];
  });
  if (tableRows2.length) tableRows2.push(["TOTAL", "", fmt(grandSpend)]);
  return {
    queryType: "expense_breakdown",
    title: "Expense Breakdown",
    subtitle: `${dateFrom} → ${dateTo} · top ${tableRows2.length - 1} accounts`,
    table: { headers: ["Account", "Type", "Amount"], rows: tableRows2 },
    noData: tableRows2.length === 0,
  };
}

export async function runPhase3SalesAnalysis({
  params,
  companyId,
  dateFrom,
  dateTo,
  rowLimit,
  fmtDec,
  fmt,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  rowLimit: DataQueryContext["rowLimit"];
  fmtDec: DataQueryContext["fmtDec"];
  fmt: DataQueryContext["fmt"];
}) {
  const itemNameFilter = params.entityName;
  const rows = await db.execute<{
    item_name: string;
    code: string;
    uom: string;
    tx_count: string;
    total_qty: string;
    total_revenue: string;
    total_cost: string;
    total_profit: string;
  }>(sql`
        SELECT si.name AS item_name, si.code, si.uom,
          COUNT(sal.id) AS tx_count,
          SUM(CAST(sal.quantity AS numeric)) AS total_qty,
          SUM(CAST(sal.total_sales AS numeric)) AS total_revenue,
          SUM(CAST(sal.total_cost AS numeric)) AS total_cost,
          SUM(CAST(sal.profit AS numeric)) AS total_profit
        FROM sales_items sal
        JOIN stock_items si ON si.id = sal.stock_item_id
        JOIN vouchers v ON v.id = sal.voucher_id AND v.deleted_at IS NULL
        WHERE si.company_id = ${companyId}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
          ${itemNameFilter ? sql`AND si.name ILIKE ${"%" + itemNameFilter + "%"}` : sql``}
        GROUP BY si.id, si.name, si.code, si.uom
        ORDER BY total_revenue DESC
        LIMIT ${rowLimit}
      `);
  let totRev = 0,
    totCost = 0,
    totProfit = 0,
    totQty = 0;
  const tableRows2 = rows.rows.map((r) => {
    const rev = toMoney(r.total_revenue).toNumber();
    const cost = toMoney(r.total_cost).toNumber();
    const profit3 = toMoney(r.total_profit).toNumber();
    const qty = toMoney(r.total_qty).toNumber();
    const margin = rev > 0 ? ((profit3 / rev) * 100).toFixed(1) + "%" : "—";
    totRev += rev;
    totCost += cost;
    totProfit += profit3;
    totQty += qty;
    return [r.item_name, `${fmtDec(qty)} ${r.uom}`, fmt(rev), fmt(cost), fmt(profit3), margin];
  });
  if (tableRows2.length) {
    const totMargin = totRev > 0 ? ((totProfit / totRev) * 100).toFixed(1) + "%" : "—";
    tableRows2.push(["TOTAL", fmtDec(totQty), fmt(totRev), fmt(totCost), fmt(totProfit), totMargin]);
  }
  return {
    queryType: "sales_analysis",
    title: itemNameFilter ? `Sales Analysis: ${itemNameFilter}` : "Sales Analysis by Item",
    subtitle: `${dateFrom} → ${dateTo}`,
    table: { headers: ["Item", "Qty Sold", "Revenue", "Cost", "Profit", "Margin"], rows: tableRows2 },
    noData: tableRows2.length === 0,
  };
}
