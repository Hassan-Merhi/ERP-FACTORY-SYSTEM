// Extracted from ./inventoryOperationsReportShard.ts: report query handlers.
import { db, sql, accountTypesOfClassSql } from "./reportShardSupport";
import { plusMoney, toMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";
import { notFiscalClosingVoucher } from "../../../services/accounting/balances/periodReportRules";

export async function runPhase2PayrollSummary({
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
        SELECT fw.name AS worker_name,
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
        ORDER BY fp.period_start DESC, fw.name
        LIMIT ${rowLimit}
      `);
  let totalNet = 0,
    totalBase = 0,
    totalBale = 0,
    totalDed = 0;
  const tableRows2 = rows.rows.map((r) => {
    const net = toMoney(r.net_salary).toNumber();
    totalNet += net;
    totalBase = plusMoney(totalBase, r.base_salary);
    totalBale = plusMoney(totalBale, r.bale_earnings);
    totalDed = plusMoney(totalDed, r.deductions);
    return [
      r.worker_name,
      String(r.period_start).slice(0, 10),
      String(r.period_end).slice(0, 10),
      fmt(toMoney(r.base_salary).toNumber()),
      fmt(toMoney(r.bale_earnings).toNumber()),
      fmt(toMoney(r.deductions).toNumber()),
      fmt(net),
      r.status,
    ];
  });
  const stats2 = [
    { label: "Total Workers", value: String(tableRows2.length) },
    { label: "Total Base Salary", value: fmt(totalBase) },
    { label: "Total Bale Earnings", value: fmt(totalBale) },
    { label: "Total Deductions", value: fmt(totalDed) },
    { label: "Total Net Payroll", value: fmt(totalNet), highlight: "positive" },
  ];
  return {
    queryType: "payroll_summary",
    title: "Factory Payroll Summary",
    subtitle: `${dateFrom} → ${dateTo}`,
    stats: stats2,
    table: {
      headers: ["Worker", "Period From", "Period To", "Base", "Bale Earn.", "Deductions", "Net", "Status"],
      rows: tableRows2,
    },
    noData: tableRows2.length === 0,
  };
}

export async function runPhase2RentalSummary({
  todayDate,
  companyId,
  rowLimit,
  fmt,
}: {
  todayDate: DataQueryContext["todayDate"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
}) {
  const currentYear = todayDate.getFullYear();
  const currentMonth = todayDate.getMonth() + 1;
  const rows = await db.execute<{
    unit_number: string;
    unit_type: string;
    location_group: string | null;
    tenant_name: string | null;
    rental_amount: string | null;
    contract_status: string | null;
    expected: string;
    paid: string;
  }>(sql`
        SELECT pu.unit_number, pu.unit_type, pu.location_group,
          pc.tenant_name, CAST(pc.rental_amount AS numeric) AS rental_amount, pc.status AS contract_status,
          CAST(COALESCE(pml.expected_amount, 0) AS numeric) AS expected,
          CAST(COALESCE(pml.paid_amount, 0) AS numeric) AS paid
        FROM property_units pu
        LEFT JOIN property_contracts pc ON pc.unit_id = pu.id AND pc.status = 'ACTIVE'
        LEFT JOIN property_monthly_ledger pml ON pml.unit_id = pu.id
          AND pml.year = ${currentYear} AND pml.month = ${currentMonth}
        WHERE pu.company_id = ${companyId} AND pu.active = true
        ORDER BY pu.unit_type, pu.location_group, pu.unit_number
        LIMIT ${rowLimit}
      `);
  let totalExpected = 0,
    totalPaid = 0,
    occupied = 0,
    vacant = 0;
  const tableRows2 = rows.rows.map((r) => {
    const exp = toMoney(r.expected).toNumber();
    const paid = toMoney(r.paid).toNumber();
    totalExpected += exp;
    totalPaid += paid;
    if (r.tenant_name) occupied++;
    else vacant++;
    const balance = exp - paid;
    return [
      r.unit_number,
      r.unit_type,
      r.location_group,
      r.tenant_name || "VACANT",
      fmt(exp),
      fmt(paid),
      fmt(balance),
      balance > 0 ? "OUTSTANDING" : "OK",
    ];
  });
  const stats2 = [
    { label: "Occupied", value: String(occupied) },
    { label: "Vacant", value: String(vacant) },
    { label: "Total Expected", value: fmt(totalExpected) },
    { label: "Total Collected", value: fmt(totalPaid) },
    {
      label: "Outstanding",
      value: fmt(totalExpected - totalPaid),
      highlight: totalExpected - totalPaid > 0 ? "negative" : "positive",
    },
  ];
  return {
    queryType: "rental_summary",
    title: "Rental Summary",
    subtitle: `${currentYear}-${String(currentMonth).padStart(2, "0")} · ${occupied} occupied, ${vacant} vacant`,
    stats: stats2,
    table: {
      headers: ["Unit", "Type", "Location", "Tenant", "Expected", "Paid", "Balance", "Status"],
      rows: tableRows2,
    },
    noData: tableRows2.length === 0,
  };
}

export async function runPhase2MonthlyComparison({
  companyId,
  thisMonthStart,
  todayStr,
  lastMonthStart,
  lastMonthEnd,
  fmt,
}: {
  companyId: DataQueryContext["companyId"];
  thisMonthStart: DataQueryContext["thisMonthStart"];
  todayStr: DataQueryContext["todayStr"];
  lastMonthStart: DataQueryContext["lastMonthStart"];
  lastMonthEnd: DataQueryContext["lastMonthEnd"];
  fmt: DataQueryContext["fmt"];
}) {
  const runPL = async (from: string, to: string) => {
    const r = await db.execute<{ revenue: string; expenses: string }>(sql`
          SELECT
            COALESCE(SUM(CASE WHEN LOWER(TRIM(la.account_type)) IN (${accountTypesOfClassSql("income")}) THEN CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS revenue,
            COALESCE(SUM(CASE WHEN LOWER(TRIM(la.account_type)) IN (${accountTypesOfClassSql("expense")}) THEN CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS expenses
          FROM voucher_entries ve
          JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL AND v.optional = false
          JOIN ledger_accounts la ON la.id = ve.ledger_account_id
          WHERE la.company_id = ${companyId}
            AND v.company_id = ${companyId}
            AND ${notFiscalClosingVoucher("v")}
            AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${from} AND ${to}
        `);
    const row = r.rows[0];
    const rev = toMoney(row?.revenue).toNumber();
    const exp = toMoney(row?.expenses).toNumber();
    return { revenue: rev, expenses: exp, net: rev - exp };
  };
  const [thisM, lastM] = await Promise.all([runPL(thisMonthStart, todayStr), runPL(lastMonthStart, lastMonthEnd)]);
  const diff = (a: number, b: number) => {
    if (b === 0) return a > 0 ? "+100%" : "—";
    const pct = ((a - b) / Math.abs(b)) * 100;
    return (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%";
  };
  const tableRows2 = [
    ["Revenue", fmt(lastM.revenue), fmt(thisM.revenue), diff(thisM.revenue, lastM.revenue)],
    ["Expenses", fmt(lastM.expenses), fmt(thisM.expenses), diff(thisM.expenses, lastM.expenses)],
    ["Net Profit", fmt(lastM.net), fmt(thisM.net), diff(thisM.net, lastM.net)],
  ];
  return {
    queryType: "monthly_comparison",
    title: "Month-over-Month Comparison",
    subtitle: `Last month (${lastMonthStart.slice(0, 7)}) vs This month (${thisMonthStart.slice(0, 7)})`,
    table: { headers: ["Metric", "Last Month", "This Month", "Change"], rows: tableRows2 },
    noData: false,
  };
}

export async function runPhase2ContainerList({
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
    supplier: string;
    grand_total: string;
    currency: string;
    transporter: string | null;
  }>(sql`
        SELECT c.container_number, c.status, c.import_date, c.eta,
          s.legal_name AS supplier,
          CAST(c.grand_total AS numeric) AS grand_total,
          c.currency, c.transporter
        FROM containers c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.company_id = ${companyId}
          ${statusFilter ? sql`AND c.status ILIKE ${"%" + statusFilter + "%"}` : sql``}
          AND c.import_date BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY c.import_date DESC
        LIMIT ${rowLimit}
      `);
  const tableRows2 = rows.rows.map((r) => [
    r.container_number,
    r.status,
    String(r.import_date).slice(0, 10),
    r.eta ? String(r.eta).slice(0, 10) : "—",
    r.supplier,
    r.transporter || "—",
    fmtDec(toMoney(r.grand_total).toNumber()),
  ]);
  return {
    queryType: "container_list",
    title: statusFilter ? `Containers — ${statusFilter}` : "Container List",
    subtitle: `${dateFrom} → ${dateTo} · ${tableRows2.length} container(s)`,
    table: {
      headers: ["Container #", "Status", "Import Date", "ETA", "Supplier", "Transporter", "Grand Total"],
      rows: tableRows2,
    },
    noData: tableRows2.length === 0,
  };
}
