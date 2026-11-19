// Extracted from ./phase6ReportShard.ts: report query handlers.
import { db, sql } from "./reportShardSupport";
import type { DataQueryContext } from "../types";
import type { JournalEntryLine } from "./phase6ReportShard";
import { toMoney } from "../../../lib/money";

export async function runPhase6JournalEntries({
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
    voucher_date: string;
    voucher_number: string;
    description: string | null;
    total_amount: string;
    currency: string;
    entries: JournalEntryLine[] | string;
  }>(sql`
        SELECT v.voucher_date, v.voucher_number, v.description,
          CAST(v.total_amount AS numeric) AS total_amount,
          v.currency,
          json_agg(json_build_object(
            'account', la.name,
            'dr', CAST(ve.debit_amount AS numeric),
            'cr', CAST(ve.credit_amount AS numeric)
          ) ORDER BY ve.id) AS entries
        FROM vouchers v
        JOIN voucher_entries ve ON ve.voucher_id = v.id
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND v.voucher_type = 'Journal'
          AND v.optional = false
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY v.id, v.voucher_date, v.voucher_number, v.description, v.total_amount, v.currency
        ORDER BY v.voucher_date DESC
        LIMIT ${rowLimit}
      `);
  const tableRows6: string[][] = [];
  for (const r of rows.rows) {
    const entries: JournalEntryLine[] =
      typeof r.entries === "string" ? (JSON.parse(r.entries) as JournalEntryLine[]) : r.entries;
    const firstEntry = entries?.[0];
    tableRows6.push([
      String(r.voucher_date).slice(0, 10),
      r.voucher_number,
      (r.description || "").slice(0, 35),
      firstEntry?.account || "—",
      firstEntry?.dr > 0 ? fmt(firstEntry.dr) : "—",
      firstEntry?.cr > 0 ? fmt(firstEntry.cr) : "—",
      r.currency,
    ]);
    for (let i = 1; i < (entries || []).length && i < 4; i++) {
      const e = entries[i];
      tableRows6.push(["", "", "", e.account, e.dr > 0 ? fmt(e.dr) : "—", e.cr > 0 ? fmt(e.cr) : "—", ""]);
    }
  }
  return {
    queryType: "journal_entries",
    title: "Journal Entries",
    subtitle: `${dateFrom} → ${dateTo} · ${rows.rows.length} journal(s)`,
    table: {
      headers: ["Date", "Voucher #", "Description", "Account", "Dr", "Cr", "Currency"],
      rows: tableRows6,
    },
    noData: tableRows6.length === 0,
  };
}

export async function runPhase6EmployeeList({
  params,
  companyId,
  rowLimit,
  fmt,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
}) {
  const deptFilter6 = params.entityName;
  const rows = await db.execute<{
    code: string;
    first_name: string;
    last_name: string | null;
    department: string | null;
    employee_type: string | null;
    monthly_salary: string | null;
    current_balance: string | null;
    join_date: string | null;
    active: boolean;
  }>(sql`
        SELECT e.code, e.first_name, e.last_name, e.department, e.employee_type,
          CAST(e.monthly_salary AS numeric) AS monthly_salary,
          CAST(e.current_balance AS numeric) AS current_balance,
          e.join_date, e.active
        FROM employees e
        WHERE e.company_id = ${companyId}
          AND e.active = true
          AND e.deleted_at IS NULL
          ${deptFilter6 ? sql`AND e.department ILIKE ${"%" + deptFilter6 + "%"}` : sql``}
        ORDER BY e.department, e.first_name, e.last_name
        LIMIT ${rowLimit}
      `);
  let totalSalary = 0,
    totalBalance = 0;
  const tableRows6 = rows.rows.map((r) => {
    const sal = toMoney(r.monthly_salary).toNumber();
    const bal = toMoney(r.current_balance).toNumber();
    totalSalary += sal;
    totalBalance += bal;
    return [
      r.code || "—",
      `${r.first_name} ${r.last_name}`,
      r.department || "—",
      r.employee_type,
      fmt(sal),
      fmt(bal),
      r.join_date ? String(r.join_date).slice(0, 10) : "—",
    ];
  });
  const stats6 = [
    { label: "Total Employees", value: String(tableRows6.length) },
    { label: "Total Monthly Salary", value: fmt(totalSalary), highlight: "positive" },
    { label: "Total Outstanding Balance", value: fmt(totalBalance) },
  ];
  return {
    queryType: "employee_list",
    title: deptFilter6 ? `Employees — ${deptFilter6}` : "Employee Roster",
    subtitle: `${tableRows6.length} active employee(s)`,
    stats: stats6,
    table: {
      headers: ["Code", "Name", "Dept", "Type", "Monthly Salary", "Balance", "Join Date"],
      rows: tableRows6,
    },
    noData: tableRows6.length === 0,
  };
}

export async function runPhase6ContainerItemsList({
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
  const cn6 = params.containerNumber || params.entityName;
  if (!cn6) {
    return {
      queryType: "container_items_list",
      title: "Container Items",
      summary: "Please specify a container number.",
    };
  }
  const rows = await db.execute<{
    container_number: string;
    supplier: string | null;
    import_date: string | null;
    item_name: string;
    code: string | null;
    uom: string | null;
    qty: string;
    rate: string;
    line_total: string;
    po_number: string;
    currency: string;
  }>(sql`
        SELECT c.container_number, s.legal_name AS supplier, c.import_date,
          pli.item_name, si.code, si.uom,
          CAST(pli.quantity AS numeric) AS qty,
          CAST(pli.rate AS numeric) AS rate,
          CAST(pli.line_total AS numeric) AS line_total,
          po.po_number, po.currency
        FROM po_line_items pli
        JOIN purchase_orders po ON po.id = pli.po_id
        JOIN containers c ON c.id = po.container_id
        JOIN suppliers s ON s.id = c.supplier_id
        JOIN stock_items si ON si.id = pli.stock_item_id
        WHERE c.container_number ILIKE ${"%" + cn6 + "%"}
          AND po.company_id = ${companyId}
        ORDER BY pli.item_name
        LIMIT ${rowLimit}
      `);
  let grandItems = 0;
  const tableRows6 = rows.rows.map((r) => {
    const lt = toMoney(r.line_total).toNumber();
    grandItems += lt;
    return [
      r.item_name,
      r.code,
      `${fmtDec(toMoney(r.qty).toNumber())} ${r.uom}`,
      fmtDec(toMoney(r.rate).toNumber()),
      fmt(lt),
      r.po_number,
      r.currency,
    ];
  });
  const hdr = rows.rows[0];
  tableRows6.push(["TOTAL", "", "", "", fmt(grandItems), "", ""]);
  return {
    queryType: "container_items_list",
    title: `Items in Container: ${hdr?.container_number || cn6}`,
    subtitle: hdr ? `Supplier: ${hdr.supplier} · Import: ${String(hdr.import_date).slice(0, 10)}` : "",
    table: { headers: ["Item", "Code", "Qty", "Rate", "Total", "PO #", "Currency"], rows: tableRows6 },
    noData: tableRows6.length <= 1,
  };
}

export async function runPhase6WeeklySales({
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
    week_start: Date;
    sales_count: string;
    revenue: string | null;
    cost: string | null;
    profit: string | null;
  }>(sql`
        SELECT DATE_TRUNC('week', CAST(v.voucher_date AS date)) AS week_start,
          COUNT(DISTINCT v.id) AS sales_count,
          SUM(CAST(sal.total_sales AS numeric)) AS revenue,
          SUM(CAST(sal.total_cost AS numeric)) AS cost,
          SUM(CAST(sal.profit AS numeric)) AS profit
        FROM sales_items sal
        JOIN vouchers v ON v.id = sal.voucher_id AND v.deleted_at IS NULL
        WHERE v.company_id = ${companyId}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY week_start
        ORDER BY week_start DESC
        LIMIT ${rowLimit}
      `);
  let totRev = 0,
    totCost = 0,
    totProfit = 0;
  const tableRows6 = rows.rows.map((r) => {
    const rev = toMoney(r.revenue).toNumber();
    const cost = toMoney(r.cost).toNumber();
    const profit6 = toMoney(r.profit).toNumber();
    const margin = rev > 0 ? ((profit6 / rev) * 100).toFixed(1) + "%" : "—";
    totRev += rev;
    totCost += cost;
    totProfit += profit6;
    const ws = String(r.week_start).slice(0, 10);
    return [ws, String(r.sales_count), fmt(rev), fmt(cost), fmt(profit6), margin];
  });
  if (tableRows6.length) {
    const totMargin = totRev > 0 ? ((totProfit / totRev) * 100).toFixed(1) + "%" : "—";
    tableRows6.push(["TOTAL", "", fmt(totRev), fmt(totCost), fmt(totProfit), totMargin]);
  }
  return {
    queryType: "weekly_sales",
    title: "Weekly Sales Breakdown",
    subtitle: `${dateFrom} → ${dateTo}`,
    table: {
      headers: ["Week Starting", "Invoices", "Revenue", "Cost", "Profit", "Margin"],
      rows: tableRows6,
    },
    noData: tableRows6.length === 0,
  };
}
