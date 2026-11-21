// Extracted from ./phase5ReportCases2.ts
import { db, sql } from "./reportShardSupport";
import { toMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";

export async function runPhase5ProfitByLocation({
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
  const rows = await db.execute<{
    location: string;
    sales_count: string;
    total_revenue: string | null;
    total_cost: string | null;
    total_profit: string | null;
  }>(sql`
        SELECT COALESCE(l.name, v.location_name, 'Unassigned') AS location,
          COUNT(DISTINCT v.id) AS sales_count,
          SUM(CAST(sal.total_sales AS numeric)) AS total_revenue,
          SUM(CAST(sal.total_cost AS numeric)) AS total_cost,
          SUM(CAST(sal.profit AS numeric)) AS total_profit
        FROM sales_items sal
        JOIN vouchers v ON v.id = sal.voucher_id AND v.deleted_at IS NULL
        LEFT JOIN locations l ON l.id = v.location_id
        WHERE v.company_id = ${companyId}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY l.id, l.name, v.location_name
        ORDER BY total_profit DESC
        LIMIT ${rowLimit}
      `);
  let grandRev = 0,
    grandCost = 0,
    grandProfit = 0;
  const tableRows5 = rows.rows.map((r) => {
    const rev = toMoney(r.total_revenue).toNumber();
    const cost = toMoney(r.total_cost).toNumber();
    const profit5 = toMoney(r.total_profit).toNumber();
    const margin = rev > 0 ? ((profit5 / rev) * 100).toFixed(1) + "%" : "—";
    grandRev += rev;
    grandCost += cost;
    grandProfit += profit5;
    return [r.location, String(r.sales_count), fmt(rev), fmt(cost), fmt(profit5), margin];
  });
  if (tableRows5.length) {
    const totMargin = grandRev > 0 ? ((grandProfit / grandRev) * 100).toFixed(1) + "%" : "—";
    tableRows5.push(["TOTAL", "", fmt(grandRev), fmt(grandCost), fmt(grandProfit), totMargin]);
  }
  const best = tableRows5.length > 1 ? tableRows5[0] : null;
  const stats5 = [
    { label: "Total Revenue", value: fmt(grandRev) },
    { label: "Total Cost", value: fmt(grandCost) },
    { label: "Total Profit", value: fmt(grandProfit), highlight: "positive" },
    ...(best ? [{ label: "Best Location", value: best[0] as string }] : []),
  ];
  return {
    queryType: "profit_by_location",
    title: "Profit by Location",
    subtitle: `${dateFrom} → ${dateTo}`,
    stats: stats5,
    table: { headers: ["Location", "Sales", "Revenue", "Cost", "Profit", "Margin"], rows: tableRows5 },
    noData: tableRows5.length === 0,
  };
}

export async function runPhase5CashFlowSummary({
  dateFrom,
  dateTo,
  companyId,
  fmt,
}: {
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  companyId: DataQueryContext["companyId"];
  fmt: DataQueryContext["fmt"];
}) {
  const rows = await db.execute<{
    account_name: string;
    account_type: string;
    total_in: string;
    total_out: string;
    tx_count: string;
  }>(sql`
        SELECT la.name AS account_name, la.account_type,
          COALESCE(SUM(CAST(ve.debit_amount AS numeric)), 0) AS total_in,
          COALESCE(SUM(CAST(ve.credit_amount AS numeric)), 0) AS total_out,
          COUNT(DISTINCT v.id) AS tx_count
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
          AND v.deleted_at IS NULL AND v.optional = false
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id
          AND LOWER(TRIM(la.account_type)) IN ('bank', 'cash')
        WHERE la.company_id = ${companyId}
        GROUP BY la.id, la.name, la.account_type
        ORDER BY total_in DESC
      `);
  let grandIn = 0,
    grandOut = 0;
  const tableRows5 = rows.rows.map((r) => {
    const inflow = toMoney(r.total_in).toNumber();
    const outflow = toMoney(r.total_out).toNumber();
    const net = inflow - outflow;
    grandIn += inflow;
    grandOut += outflow;
    return [
      r.account_name,
      r.account_type,
      fmt(inflow),
      fmt(outflow),
      net >= 0 ? fmt(net) : `(${fmt(Math.abs(net))})`,
      String(r.tx_count),
    ];
  });
  tableRows5.push([
    "TOTAL",
    "",
    fmt(grandIn),
    fmt(grandOut),
    grandIn >= grandOut ? fmt(grandIn - grandOut) : `(${fmt(grandOut - grandIn)})`,
    "",
  ]);
  const stats5 = [
    { label: "Total Cash In", value: fmt(grandIn), highlight: "positive" },
    { label: "Total Cash Out", value: fmt(grandOut) },
    {
      label: "Net Position",
      value: grandIn >= grandOut ? fmt(grandIn - grandOut) : `(${fmt(grandOut - grandIn)})`,
      highlight: grandIn >= grandOut ? "positive" : "negative",
    },
  ];
  return {
    queryType: "cash_flow_summary",
    title: "Cash Flow Summary",
    subtitle: `${dateFrom} → ${dateTo} · Bank & Cash accounts`,
    stats: stats5,
    table: {
      headers: ["Account", "Type", "Inflow (Dr)", "Outflow (Cr)", "Net", "Transactions"],
      rows: tableRows5,
    },
    noData: tableRows5.length <= 1,
  };
}
