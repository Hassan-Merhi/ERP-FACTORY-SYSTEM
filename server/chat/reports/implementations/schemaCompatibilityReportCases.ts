// Extracted from ./schemaCompatibilityReportShard.ts: report query handlers.
import { db, sql } from "./reportShardSupport";
import type { DataQueryContext } from "../types";
import { toMoney } from "../../../lib/money";

export async function runSchemaCompatibilityUpcomingArrivals({
  todayDate,
  companyId,
  rowLimit,
}: {
  todayDate: DataQueryContext["todayDate"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
}) {
  const daysAhead = 30;
  const futureDate = new Date(todayDate.getTime() + daysAhead * 86400000).toISOString().slice(0, 10);
  const rows = await db.execute<{
    container_number: string;
    status: string;
    eta: string | null;
    supplier: string | null;
    transporter: string | null;
    tracking_location: string | null;
    days_until_eta: number | null;
  }>(sql`
        SELECT c.container_number, c.status, c.eta,
          s.legal_name AS supplier,
          c.transporter, c.tracking_location,
          CAST(c.eta AS date) - CURRENT_DATE AS days_until_eta
        FROM containers c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.company_id = ${companyId}
          AND c.status NOT IN ('Offloaded', 'Arrived')
          AND c.eta IS NOT NULL
          AND CAST(c.eta AS date) <= ${futureDate}
        ORDER BY c.eta ASC
        LIMIT ${rowLimit}
      `);
  const tableRows = rows.rows.map((r) => {
    const days = r.days_until_eta ?? 0;
    return [
      r.container_number,
      r.status,
      r.eta ? String(r.eta).slice(0, 10) : "—",
      days <= 0 ? "TODAY/OVERDUE" : `${days}d`,
      r.supplier,
      r.transporter || "—",
      r.tracking_location || "—",
    ];
  });
  return {
    queryType: "upcoming_arrivals",
    title: "Upcoming Container Arrivals",
    subtitle: `Next ${daysAhead} days · ${tableRows.length} container(s) expected`,
    table: {
      headers: ["Container #", "Status", "ETA", "Days Away", "Supplier", "Transporter", "Last Location"],
      rows: tableRows,
    },
    noData: tableRows.length === 0,
  };
}

export async function runSchemaCompatibilityWorkerProductivity({
  companyId,
  dateFrom,
  dateTo,
  rowLimit,
  fmtDec,
}: {
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  rowLimit: DataQueryContext["rowLimit"];
  fmtDec: DataQueryContext["fmtDec"];
}) {
  const rows = await db.execute<{
    full_name: string;
    total_bales: string;
    total_kg: string;
    avg_kg_per_bale: string;
  }>(sql`
        SELECT COALESCE(NULLIF(fb.worker_name, ''), 'Unknown') AS full_name,
          COUNT(fb.id) AS total_bales,
          COALESCE(SUM(CAST(fb.weight_kg AS numeric)), 0) AS total_kg,
          COALESCE(AVG(CAST(fb.weight_kg AS numeric)), 0) AS avg_kg_per_bale
        FROM factory_bales fb
        WHERE fb.company_id = ${companyId}
          AND fb.deleted_at IS NULL
          AND fb.pressed_at IS NOT NULL
          AND CAST(fb.pressed_at AS text) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY COALESCE(NULLIF(fb.worker_name, ''), 'Unknown')
        ORDER BY total_bales DESC
        LIMIT ${rowLimit}
      `);
  const tableRows = rows.rows.map((r, index) => [
    String(index + 1),
    r.full_name,
    String(r.total_bales),
    fmtDec(toMoney(r.total_kg).toNumber()),
    fmtDec(toMoney(r.avg_kg_per_bale).toNumber()),
  ]);
  return {
    queryType: "worker_productivity",
    title: "Worker Productivity Ranking",
    subtitle: `${dateFrom} → ${dateTo} · by bales pressed`,
    table: { headers: ["Rank", "Worker", "Bales", "Total Kg", "Avg Kg/Bale"], rows: tableRows },
    noData: tableRows.length === 0,
  };
}

export async function runSchemaCompatibilityContainerProfitability({
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
    container_number: string;
    supplier: string | null;
    customer: string | null;
    currency: string;
    cost: string;
    sale_amount: string | null;
    commission: string | null;
    payment_status: string | null;
  }>(sql`
        SELECT c.container_number,
          s.legal_name AS supplier,
          cu.legal_name AS customer,
          cs.currency,
          CAST(c.grand_total AS numeric) AS cost,
          CAST(cs.total_amount AS numeric) AS sale_amount,
          CAST(cs.commission AS numeric) AS commission,
          cs.payment_status
        FROM container_sales cs
        JOIN containers c ON c.id = cs.container_id
        JOIN suppliers s ON s.id = c.supplier_id
        JOIN customers cu ON cu.id = cs.customer_id
        WHERE c.company_id = ${companyId}
          AND CAST(cs.sale_date AS text) BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY cs.sale_date DESC
        LIMIT ${rowLimit}
      `);
  let totalCost = 0;
  let totalSale = 0;
  let totalProfit = 0;
  const tableRows = rows.rows.map((r) => {
    const cost = toMoney(r.cost).toNumber();
    const sale = toMoney(r.sale_amount).toNumber();
    const commission = toMoney(r.commission).toNumber();
    const profit = sale - cost - commission;
    const margin = sale > 0 ? `${((profit / sale) * 100).toFixed(1)}%` : "—";
    totalCost += cost;
    totalSale += sale;
    totalProfit += profit;
    return [
      r.container_number,
      r.supplier,
      r.customer,
      r.currency,
      fmt(cost),
      fmt(sale),
      fmt(commission),
      fmt(profit),
      margin,
      r.payment_status,
    ];
  });
  if (tableRows.length) {
    const margin = totalSale > 0 ? `${((totalProfit / totalSale) * 100).toFixed(1)}%` : "—";
    tableRows.push(["TOTAL", "", "", "", fmt(totalCost), fmt(totalSale), "", fmt(totalProfit), margin, ""]);
  }
  return {
    queryType: "container_profitability",
    title: "Container Profitability",
    subtitle: `${dateFrom} → ${dateTo}`,
    table: {
      headers: ["Container #", "Supplier", "Customer", "Curr.", "Cost", "Sale", "Comm.", "Profit", "Margin", "Payment"],
      rows: tableRows,
    },
    noData: tableRows.length === 0,
  };
}

export async function runSchemaCompatibilityPayrollSummary({
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
    worker_name: string;
    period_start: string;
    period_end: string;
    status: string;
    net_salary: string;
    base_salary: string;
    bale_earnings: string;
    deductions: string;
    present_days: string | null;
    absent_days: string | null;
  }>(sql`
        SELECT fw.full_name AS worker_name,
          fp.period_start, fp.period_end, fp.status,
          CAST(fp.net_salary AS numeric) AS net_salary,
          CAST(fp.base_salary AS numeric) AS base_salary,
          CAST(fp.bale_earnings AS numeric) AS bale_earnings,
          CAST(fp.deductions AS numeric) AS deductions,
          fp.present_days, fp.absent_days
        FROM factory_payrolls fp
        JOIN factory_workers fw ON fw.id = fp.worker_id
        WHERE fp.company_id = ${companyId}
          AND fp.period_start >= ${dateFrom}
          AND fp.period_end <= ${dateTo}
        ORDER BY fp.period_start DESC, fw.full_name
        LIMIT ${rowLimit}
      `);
  let totalNet = 0;
  let totalBase = 0;
  let totalBale = 0;
  let totalDeductions = 0;
  const tableRows = rows.rows.map((r) => {
    const net = toMoney(r.net_salary).toNumber();
    const base = toMoney(r.base_salary).toNumber();
    const bale = toMoney(r.bale_earnings).toNumber();
    const deductions = toMoney(r.deductions).toNumber();
    totalNet += net;
    totalBase += base;
    totalBale += bale;
    totalDeductions += deductions;
    return [
      r.worker_name,
      `${String(r.period_start).slice(0, 10)} → ${String(r.period_end).slice(0, 10)}`,
      r.status,
      fmt(base),
      fmt(bale),
      fmt(deductions),
      fmt(net),
      `${r.present_days ?? 0}/${r.absent_days ?? 0}`,
    ];
  });
  return {
    queryType: "payroll_summary",
    title: "Factory Payroll Summary",
    subtitle: `${dateFrom} → ${dateTo}`,
    stats: [
      { label: "Workers / Payroll Rows", value: String(tableRows.length) },
      { label: "Base Salary", value: fmt(totalBase) },
      { label: "Bale Earnings", value: fmt(totalBale) },
      { label: "Deductions", value: fmt(totalDeductions) },
      { label: "Net Payroll", value: fmt(totalNet), highlight: "positive" },
    ],
    table: {
      headers: ["Worker", "Period", "Status", "Base", "Bale Earnings", "Deductions", "Net", "Present/Absent"],
      rows: tableRows,
    },
    noData: tableRows.length === 0,
  };
}

export async function runSchemaCompatibilityContainerList({
  params,
  companyId,
  dateFrom,
  dateTo,
  rowLimit,
  fmtDec,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  rowLimit: DataQueryContext["rowLimit"];
  fmtDec: DataQueryContext["fmtDec"];
}) {
  const statusFilter = params.containerStatus;
  const rows = await db.execute<{
    container_number: string;
    status: string;
    import_date: string | null;
    eta: string | null;
    supplier: string | null;
    transporter: string | null;
    grand_total: string;
  }>(sql`
        SELECT c.container_number, c.status, c.import_date, c.eta,
          s.legal_name AS supplier,
          c.transporter,
          CAST(c.grand_total AS numeric) AS grand_total
        FROM containers c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.company_id = ${companyId}
          ${statusFilter ? sql`AND c.status ILIKE ${"%" + statusFilter + "%"}` : sql``}
          AND c.import_date BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY c.import_date DESC
        LIMIT ${rowLimit}
      `);
  const tableRows = rows.rows.map((r) => [
    r.container_number,
    r.status,
    r.import_date ? String(r.import_date).slice(0, 10) : "—",
    r.eta ? String(r.eta).slice(0, 10) : "—",
    r.supplier,
    r.transporter || "—",
    fmtDec(toMoney(r.grand_total).toNumber()),
  ]);
  return {
    queryType: "container_list",
    title: statusFilter ? `Containers — ${statusFilter}` : "Container List",
    subtitle: `${dateFrom} → ${dateTo} · ${tableRows.length} container(s)`,
    table: {
      headers: ["Container #", "Status", "Import Date", "ETA", "Supplier", "Transporter", "Grand Total"],
      rows: tableRows,
    },
    noData: tableRows.length === 0,
  };
}
