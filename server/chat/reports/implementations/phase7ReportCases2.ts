// Extracted from ./phase7ReportShard.ts: report query handlers.
import { db, sql, accountTypesOfClassSql } from "./reportShardSupport";
import { toMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";
import { notFiscalClosingVoucher } from "../../../services/accounting/balances/periodReportRules";

export async function runPhase7QuarterlyComparison({
  params,
  todayStr,
  companyId,
  fmt,
}: {
  params: DataQueryContext["params"];
  todayStr: DataQueryContext["todayStr"];
  companyId: DataQueryContext["companyId"];
  fmt: DataQueryContext["fmt"];
}) {
  const yearStr = params.dateFrom ? params.dateFrom.slice(0, 4) : todayStr.slice(0, 4);
  const rows = await db.execute<{
    quarter: string;
    revenue: string | null;
    cost: string | null;
    profit: string | null;
    sales_count: string;
  }>(sql`
        SELECT EXTRACT(QUARTER FROM CAST(v.voucher_date AS date)) AS quarter,
          SUM(CAST(sal.total_sales AS numeric)) AS revenue,
          SUM(CAST(sal.total_cost AS numeric)) AS cost,
          SUM(CAST(sal.profit AS numeric)) AS profit,
          COUNT(DISTINCT v.id) AS sales_count
        FROM sales_items sal
        JOIN vouchers v ON v.id = sal.voucher_id AND v.deleted_at IS NULL
        WHERE v.company_id = ${companyId}
          AND EXTRACT(YEAR FROM CAST(v.voucher_date AS date)) = ${parseInt(yearStr)}
        GROUP BY quarter
        ORDER BY quarter
      `);
  let totRev = 0,
    totCost = 0,
    totProfit = 0;
  const qLabels = ["Q1 (Jan-Mar)", "Q2 (Apr-Jun)", "Q3 (Jul-Sep)", "Q4 (Oct-Dec)"];
  const tableRows7 = rows.rows.map((r) => {
    const q = parseInt(r.quarter || "1");
    const rev = toMoney(r.revenue).toNumber();
    const cost = toMoney(r.cost).toNumber();
    const profit7 = toMoney(r.profit).toNumber();
    const margin = rev > 0 ? ((profit7 / rev) * 100).toFixed(1) + "%" : "—";
    totRev += rev;
    totCost += cost;
    totProfit += profit7;
    return [qLabels[q - 1] || `Q${q}`, String(r.sales_count), fmt(rev), fmt(cost), fmt(profit7), margin];
  });
  if (tableRows7.length) {
    const totMargin = totRev > 0 ? ((totProfit / totRev) * 100).toFixed(1) + "%" : "—";
    tableRows7.push(["FULL YEAR", "", fmt(totRev), fmt(totCost), fmt(totProfit), totMargin]);
  }
  const stats7 = [
    { label: "Year", value: yearStr },
    { label: "Total Revenue", value: fmt(totRev) },
    { label: "Total Cost", value: fmt(totCost) },
    { label: "Total Profit", value: fmt(totProfit), highlight: "positive" },
    { label: "Overall Margin", value: totRev > 0 ? ((totProfit / totRev) * 100).toFixed(1) + "%" : "—" },
  ];
  return {
    queryType: "quarterly_comparison",
    title: `Quarterly Comparison — ${yearStr}`,
    subtitle: `Sales revenue and profit by quarter`,
    stats: stats7,
    table: { headers: ["Quarter", "Invoices", "Revenue", "Cost", "Profit", "Margin"], rows: tableRows7 },
    noData: tableRows7.length === 0,
  };
}

export async function runPhase7LocationList({
  companyId,
  fmt,
}: {
  companyId: DataQueryContext["companyId"];
  fmt: DataQueryContext["fmt"];
}) {
  const rows = await db.execute<{
    code: string;
    name: string;
    city: string | null;
    country: string | null;
    active: boolean;
    item_count: string;
    total_value: string;
  }>(sql`
        SELECT l.code, l.name, l.city, l.country, l.active,
          COUNT(DISTINCT inv.stock_item_id) AS item_count,
          COALESCE(SUM(CAST(inv.total_value AS numeric)), 0) AS total_value
        FROM locations l
        LEFT JOIN inventory inv ON inv.location_id = l.id AND inv.quantity > 0
        WHERE l.company_id = ${companyId}
          AND l.deleted_at IS NULL
        GROUP BY l.id, l.code, l.name, l.city, l.country, l.active
        ORDER BY l.name
      `);
  let grandValue = 0,
    grandItems = 0;
  const tableRows7 = rows.rows.map((r) => {
    const val = toMoney(r.total_value).toNumber();
    const items = parseInt(r.item_count || "0");
    grandValue += val;
    grandItems += items;
    return [
      r.code || "—",
      r.name,
      r.city || "—",
      r.country || "—",
      String(items),
      fmt(val),
      r.active ? "Active" : "Inactive",
    ];
  });
  const stats7 = [
    { label: "Total Locations", value: String(tableRows7.length) },
    { label: "Total Stock Items", value: String(grandItems) },
    { label: "Total Inventory Value", value: fmt(grandValue), highlight: "positive" },
  ];
  return {
    queryType: "location_list",
    title: "Warehouse / Location List",
    subtitle: `${tableRows7.length} location(s)`,
    stats: stats7,
    table: {
      headers: ["Code", "Name", "City", "Country", "Items", "Inv. Value", "Status"],
      rows: tableRows7,
    },
    noData: tableRows7.length === 0,
  };
}

export async function runPhase7FactoryWorkerProfile({
  params,
  companyId,
  dateFrom,
  dateTo,
  fmt,
  fmtDec,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  fmt: DataQueryContext["fmt"];
  fmtDec: DataQueryContext["fmtDec"];
}) {
  const workerName7 = params.entityName;
  if (!workerName7) {
    return {
      queryType: "factory_worker_profile",
      title: "Factory Worker Profile",
      summary: "Please specify a worker name.",
    };
  }
  const wRow = await db.execute<{
    full_name: string;
    employee_code: string | null;
    position: string | null;
    department: string | null;
    gender: string | null;
    nationality: string | null;
    date_of_birth: string | null;
    date_joined: string | null;
    salary_type: string;
    base_salary: string | null;
    per_bale_rate: string | null;
    per_kg_rate: string | null;
    phone1: string | null;
    phone2: string | null;
    active: boolean;
    bank_name: string | null;
    payment_method: string | null;
    visa_expiry: string | null;
    work_permit_expiry: string | null;
    shift_type: string | null;
    transport_allowance: string | null;
  }>(sql`
        SELECT fw.full_name, fw.employee_code, fw.position, fw.department,
          fw.gender, fw.nationality, fw.date_of_birth, fw.date_joined,
          fw.salary_type, fw.base_salary, fw.per_bale_rate, fw.per_kg_rate,
          fw.phone1, fw.phone2, fw.active, fw.bank_name, fw.payment_method,
          fw.visa_expiry, fw.work_permit_expiry, fw.shift_type,
          fw.transport_allowance
        FROM factory_workers fw
        WHERE fw.company_id = ${companyId}
          AND fw.full_name ILIKE ${"%" + workerName7 + "%"}
        ORDER BY fw.full_name LIMIT 1
      `);
  if (!wRow.rows.length) {
    return {
      queryType: "factory_worker_profile",
      title: "Factory Worker Profile",
      summary: `No worker found matching "${workerName7}".`,
    };
  }
  const w7 = wRow.rows[0];
  const baleStats7 = await db.execute<{ total_bales: string; total_kg: string }>(sql`
        SELECT COUNT(id) AS total_bales,
          COALESCE(SUM(CAST(weight_kg AS numeric)), 0) AS total_kg
        FROM factory_bales
        WHERE company_id = ${companyId}
          AND pressed_at IS NOT NULL
          AND CAST(pressed_at AS text) BETWEEN ${dateFrom} AND ${dateTo}
          AND worker_name ILIKE ${"%" + workerName7 + "%"}
      `);
  const bs7 = baleStats7.rows[0];
  const stats7 = [
    { label: "Name", value: w7.full_name },
    { label: "Code", value: w7.employee_code || "—" },
    { label: "Position", value: w7.position || "—" },
    { label: "Department", value: w7.department || "—" },
    { label: "Status", value: w7.active ? "Active" : "Inactive" },
    { label: "Salary Type", value: w7.salary_type },
    { label: "Base Salary", value: fmt(toMoney(w7.base_salary).toNumber()) },
    { label: "Per Bale Rate", value: fmtDec(toMoney(w7.per_bale_rate).toNumber()) },
    { label: "Bales This Period", value: String(bs7?.total_bales || 0) },
    { label: "Kg This Period", value: fmtDec(toMoney(bs7?.total_kg).toNumber()) },
  ];
  const profileRows = [
    ["Phone", w7.phone1 || "—"],
    ["Nationality", w7.nationality || "—"],
    ["Gender", w7.gender || "—"],
    ["Date of Birth", w7.date_of_birth ? String(w7.date_of_birth).slice(0, 10) : "—"],
    ["Date Joined", w7.date_joined ? String(w7.date_joined).slice(0, 10) : "—"],
    ["Shift Type", w7.shift_type || "—"],
    ["Bank", w7.bank_name || "—"],
    ["Payment Method", w7.payment_method || "—"],
    ["Visa Expiry", w7.visa_expiry ? String(w7.visa_expiry).slice(0, 10) : "—"],
    ["Work Permit Expiry", w7.work_permit_expiry ? String(w7.work_permit_expiry).slice(0, 10) : "—"],
    ["Transport Allowance", fmt(toMoney(w7.transport_allowance).toNumber())],
  ];
  return {
    queryType: "factory_worker_profile",
    title: `Worker Profile: ${w7.full_name}`,
    subtitle: `${dateFrom} → ${dateTo} performance`,
    stats: stats7,
    table: { headers: ["Field", "Value"], rows: profileRows },
    noData: false,
  };
}

export async function runPhase7IncomeBreakdown({
  dateFrom,
  dateTo,
  companyId,
  rowLimit,
  fmt,
}: {
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
}) {
  const rows = await db.execute<{ name: string; account_type: string; net_income: string }>(sql`
        SELECT la.name, la.account_type,
          COALESCE(SUM(CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric)), 0) AS net_income
        FROM ledger_accounts la
        JOIN voucher_entries ve ON ve.ledger_account_id = la.id
        JOIN vouchers v ON v.id = ve.voucher_id
          AND v.deleted_at IS NULL AND v.optional = false
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
          AND v.company_id = ${companyId}
          AND ${notFiscalClosingVoucher("v")}
        WHERE la.company_id = ${companyId}
          AND LOWER(TRIM(la.account_type)) IN (${accountTypesOfClassSql("income")})
          AND la.deleted_at IS NULL
        GROUP BY la.id, la.name, la.account_type
        HAVING COALESCE(SUM(CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric)), 0) > 0
        ORDER BY net_income DESC
        LIMIT ${rowLimit}
      `);
  let grandIncome = 0;
  const tableRows7 = rows.rows.map((r) => {
    const income = toMoney(r.net_income).toNumber();
    grandIncome += income;
    return [r.name, r.account_type, fmt(income)];
  });
  if (tableRows7.length) tableRows7.push(["TOTAL", "", fmt(grandIncome)]);
  return {
    queryType: "income_breakdown",
    title: "Income Breakdown by Account",
    subtitle: `${dateFrom} → ${dateTo} · Total: ${fmt(grandIncome)}`,
    table: { headers: ["Account", "Type", "Net Income"], rows: tableRows7 },
    noData: tableRows7.length === 0,
  };
}

export async function runPhase7SupplierContainerHistory({
  params,
  companyId,
  rowLimit,
  fmtDec,
  fmt,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmtDec: DataQueryContext["fmtDec"];
  fmt: DataQueryContext["fmt"];
}) {
  const suppName7 = params.entityName;
  if (!suppName7) {
    return {
      queryType: "supplier_container_history",
      title: "Supplier Container History",
      summary: "Please specify a supplier name.",
    };
  }
  const rows = await db.execute<{
    container_number: string;
    status: string;
    import_date: string | null;
    eta: string | null;
    grand_total: string;
    currency: string;
    total_kg: string | null;
    rate_per_kg: string | null;
    item_name: string | null;
    supplier: string | null;
  }>(sql`
        SELECT c.container_number, c.status, c.import_date, c.eta,
          CAST(c.grand_total AS numeric) AS grand_total, c.currency,
          c.total_kg, c.rate_per_kg, c.item_name, s.legal_name AS supplier
        FROM containers c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.company_id = ${companyId}
          AND s.legal_name ILIKE ${"%" + suppName7 + "%"}
        ORDER BY c.import_date DESC
        LIMIT ${rowLimit}
      `);
  let totalValue = 0,
    totalKg = 0;
  const statusCounts: Record<string, number> = {};
  const tableRows7 = rows.rows.map((r) => {
    const val = toMoney(r.grand_total).toNumber();
    const kg = toMoney(r.total_kg).toNumber();
    totalValue += val;
    totalKg += kg;
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
    return [
      r.container_number,
      r.status,
      String(r.import_date).slice(0, 10),
      r.eta ? String(r.eta).slice(0, 10) : "—",
      fmtDec(kg),
      fmt(val),
      r.currency,
      (r.item_name || "—").slice(0, 25),
    ];
  });
  const supplier7 = (rows.rows[0] as { supplier: unknown })?.supplier || suppName7;
  const stats7 = [
    { label: "Supplier", value: supplier7 },
    { label: "Total Containers", value: String(tableRows7.length) },
    { label: "Total Kg", value: fmtDec(totalKg) },
    { label: "Total Value", value: fmt(totalValue), highlight: "positive" },
    ...Object.entries(statusCounts).map(([s, c]) => ({ label: s, value: String(c) })),
  ];
  return {
    queryType: "supplier_container_history",
    title: `Containers from: ${supplier7}`,
    subtitle: `${tableRows7.length} container(s) · most recent first`,
    stats: stats7,
    table: {
      headers: ["Container #", "Status", "Import Date", "ETA", "Total Kg", "Value", "Currency", "Item"],
      rows: tableRows7,
    },
    noData: tableRows7.length === 0,
  };
}
