// Extracted from ./accountingDetailReportShard.ts: report query handlers.
import { db, sql } from "./reportShardSupport";
import { toMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";
import { defaultOpeningSide } from "../../../services/accounting/accountClassification";

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

export async function runPhase5DailyReport({
  params,
  todayStr,
  companyId,
  rowLimit,
  fmt,
}: {
  params: DataQueryContext["params"];
  todayStr: DataQueryContext["todayStr"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
}) {
  const reportDate = params.dateFrom || todayStr;
  const rows = await db.execute<{
    voucher_number: string;
    voucher_type: string;
    description: string | null;
    amount: string;
    currency: string;
    location: string | null;
  }>(sql`
        SELECT v.voucher_number, v.voucher_type, v.description,
          CAST(v.total_amount AS numeric) AS amount,
          v.currency, l.name AS location
        FROM vouchers v
        LEFT JOIN locations l ON l.id = v.location_id
        WHERE v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND v.optional = false
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) = ${reportDate}
        ORDER BY v.voucher_type, v.voucher_number
        LIMIT ${rowLimit}
      `);
  const typeMap5: Record<string, number> = {};
  let grandAmt = 0;
  const tableRows5 = rows.rows.map((r) => {
    const amt = toMoney(r.amount).toNumber();
    typeMap5[r.voucher_type] = (typeMap5[r.voucher_type] || 0) + amt;
    grandAmt += amt;
    return [
      r.voucher_number,
      r.voucher_type,
      (r.description || "").slice(0, 40),
      r.location || "—",
      fmt(amt),
      r.currency,
    ];
  });
  const stats5 = [
    { label: "Date", value: reportDate },
    { label: "Total Vouchers", value: String(tableRows5.length) },
    { label: "Grand Total", value: fmt(grandAmt), highlight: "positive" },
    ...Object.entries(typeMap5).map(([t, a]) => ({ label: t, value: fmt(a) })),
  ];
  return {
    queryType: "daily_report",
    title: `Daily Report: ${reportDate}`,
    subtitle: `${tableRows5.length} voucher(s) · Total: ${fmt(grandAmt)}`,
    stats: stats5,
    table: {
      headers: ["Voucher #", "Type", "Description", "Location", "Amount", "Currency"],
      rows: tableRows5,
    },
    noData: tableRows5.length === 0,
  };
}

export async function runPhase5LedgerAccountBalance({
  params,
  companyId,
  dateFrom,
  dateTo,
  rowLimit,
  fmt,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
}) {
  const acctName5 = params.entityName || params.locationName;
  if (!acctName5) {
    return {
      queryType: "ledger_account_balance",
      title: "Ledger Account Balance",
      summary: "Please specify an account name.",
    };
  }
  const acctRow5 = await db.execute<{
    id: number;
    name: string;
    account_type: string;
    code: string | null;
    opening_balance: string;
    opening_balance_side: string | null;
  }>(sql`
        SELECT id, name, account_type, code,
          CAST(opening_balance AS numeric) AS opening_balance, opening_balance_side
        FROM ledger_accounts
        WHERE company_id = ${companyId} AND deleted_at IS NULL
          AND name ILIKE ${"%" + acctName5 + "%"}
        ORDER BY name LIMIT 1
      `);
  if (!acctRow5.rows.length) {
    return {
      queryType: "ledger_account_balance",
      title: "Ledger Account Balance",
      summary: `No account found matching "${acctName5}".`,
    };
  }
  const la5 = acctRow5.rows[0];
  const txRows5 = await db.execute<{
    voucher_date: string;
    voucher_type: string;
    voucher_number: string;
    description: string | null;
    dr: string;
    cr: string;
  }>(sql`
        SELECT v.voucher_date, v.voucher_type, v.voucher_number, v.description,
          CAST(ve.debit_amount AS numeric) AS dr,
          CAST(ve.credit_amount AS numeric) AS cr
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
          AND v.deleted_at IS NULL AND v.optional = false
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        WHERE ve.ledger_account_id = ${la5.id}
        ORDER BY v.voucher_date, v.id
        LIMIT ${rowLimit}
      `);
  // A sideless opening is on its type's usual side, as in the balance engine (wave 13, C1).
  const obSide5 =
    la5.opening_balance_side === "Dr" || la5.opening_balance_side === "Cr"
      ? la5.opening_balance_side
      : (defaultOpeningSide(la5.account_type) ?? "Dr");
  const ob = toMoney(la5.opening_balance).toNumber() * (obSide5 === "Cr" ? -1 : 1);
  let runningBal = ob;
  let totalDr = 0,
    totalCr = 0;
  const tableRows5 = txRows5.rows.map((r) => {
    const dr = toMoney(r.dr).toNumber();
    const cr = toMoney(r.cr).toNumber();
    runningBal += dr - cr;
    totalDr += dr;
    totalCr += cr;
    return [
      String(r.voucher_date).slice(0, 10),
      r.voucher_number,
      r.voucher_type,
      (r.description || "").slice(0, 35),
      dr > 0 ? fmt(dr) : "—",
      cr > 0 ? fmt(cr) : "—",
      fmt(Math.abs(runningBal)) + (runningBal >= 0 ? " Dr" : " Cr"),
    ];
  });
  const stats5 = [
    { label: "Account", value: `${la5.code ? la5.code + " — " : ""}${la5.name}` },
    { label: "Type", value: la5.account_type },
    { label: "Total Debit", value: fmt(totalDr) },
    { label: "Total Credit", value: fmt(totalCr) },
    {
      label: "Closing Balance",
      value: fmt(Math.abs(runningBal)) + (runningBal >= 0 ? " Dr" : " Cr"),
      highlight: "positive",
    },
  ];
  return {
    queryType: "ledger_account_balance",
    title: `Ledger: ${la5.name}`,
    subtitle: `${dateFrom} → ${dateTo}`,
    stats: stats5,
    table: {
      headers: ["Date", "Voucher #", "Type", "Description", "Dr", "Cr", "Balance"],
      rows: tableRows5,
    },
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

export async function runPhase5StockTransfers({
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
  const locFilter5 = params.locationName || params.entityName;
  const rows = await db.execute<{
    voucher_date: string;
    voucher_number: string;
    from_location: string | null;
    to_location: string | null;
    item_name: string;
    code: string | null;
    qty: string;
    uom: string | null;
    rate: string;
    total_amount: string;
    notes: string | null;
  }>(sql`
        SELECT v.voucher_date, v.voucher_number,
          sl.name AS from_location, dl.name AS to_location,
          si.name AS item_name, si.code,
          CAST(sti.quantity AS numeric) AS qty, si.uom,
          CAST(sti.rate AS numeric) AS rate,
          CAST(sti.total_amount AS numeric) AS total_amount,
          stv.notes
        FROM stock_transfer_items sti
        JOIN stock_transfer_vouchers stv ON stv.id = sti.transfer_id
        JOIN vouchers v ON v.id = stv.voucher_id AND v.deleted_at IS NULL
        JOIN stock_items si ON si.id = sti.stock_item_id
        LEFT JOIN locations sl ON sl.id = sti.source_location_id
        JOIN locations dl ON dl.id = stv.destination_location_id
        WHERE si.company_id = ${companyId}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
          ${locFilter5 ? sql`AND (sl.name ILIKE ${"%" + locFilter5 + "%"} OR dl.name ILIKE ${"%" + locFilter5 + "%"})` : sql``}
        ORDER BY v.voucher_date DESC
        LIMIT ${rowLimit}
      `);
  let totalTransferred = 0;
  const tableRows5 = rows.rows.map((r) => {
    const amt = toMoney(r.total_amount).toNumber();
    totalTransferred += amt;
    return [
      String(r.voucher_date).slice(0, 10),
      r.voucher_number,
      r.item_name,
      `${fmtDec(toMoney(r.qty).toNumber())} ${r.uom}`,
      r.from_location || "—",
      r.to_location,
      fmt(amt),
    ];
  });
  return {
    queryType: "stock_transfers",
    title: locFilter5 ? `Stock Transfers: ${locFilter5}` : "Stock Transfers",
    subtitle: `${dateFrom} → ${dateTo} · Total value transferred: ${fmt(totalTransferred)}`,
    table: { headers: ["Date", "Voucher #", "Item", "Qty", "From", "To", "Value"], rows: tableRows5 },
    noData: tableRows5.length === 0,
  };
}
