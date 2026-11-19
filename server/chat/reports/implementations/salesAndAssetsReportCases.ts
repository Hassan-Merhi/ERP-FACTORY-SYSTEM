// Extracted from ./salesAndAssetsReportShard.ts: report query handlers.
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

export async function runPhase3CustomerOrderStatus({
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
  const statusFilter = (params.entityName || "").toUpperCase() || null;
  const rows = await db.execute<{
    invoice_number: string | null;
    customer: string | null;
    order_date: string | null;
    status: string;
    grand_total: string;
    total_qty_bales: number | null;
    destination: string | null;
    container_number: string | null;
  }>(sql`
        SELECT co.invoice_number, cu.legal_name AS customer,
          co.order_date, co.status,
          CAST(co.grand_total AS numeric) AS grand_total,
          co.total_qty_bales, co.destination, co.container_number
        FROM customer_orders co
        JOIN customers cu ON cu.id = co.customer_id
        WHERE co.company_id = ${companyId}
          AND co.deleted_at IS NULL
          ${statusFilter ? sql`AND co.status = ${statusFilter}` : sql``}
          AND co.order_date BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY co.order_date DESC
        LIMIT ${rowLimit}
      `);
  const tableRows2 = rows.rows.map((r) => [
    r.invoice_number || "—",
    r.customer,
    String(r.order_date).slice(0, 10),
    r.status,
    fmt(toMoney(r.grand_total).toNumber()),
    String(r.total_qty_bales || 0),
    r.destination || "—",
  ]);
  return {
    queryType: "customer_order_status",
    title: statusFilter ? `Customer Orders — ${statusFilter}` : "Customer Orders",
    subtitle: `${dateFrom} → ${dateTo} · ${tableRows2.length} order(s)`,
    table: {
      headers: ["Invoice", "Customer", "Date", "Status", "Total", "Bales", "Destination"],
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

export async function runPhase3StockValuation({
  companyId,
  rowLimit,
  fmtDec,
  fmt,
  todayStr,
}: {
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmtDec: DataQueryContext["fmtDec"];
  fmt: DataQueryContext["fmt"];
  todayStr: DataQueryContext["todayStr"];
}) {
  const rows = await db.execute<{
    group_name: string;
    item_count: string;
    total_qty: string | null;
    total_value: string | null;
  }>(sql`
        SELECT COALESCE(sg.name, 'Ungrouped') AS group_name,
          COUNT(DISTINCT si.id) AS item_count,
          SUM(CAST(inv.quantity AS numeric)) AS total_qty,
          SUM(CAST(inv.total_value AS numeric)) AS total_value
        FROM inventory inv
        JOIN stock_items si ON si.id = inv.stock_item_id AND si.deleted_at IS NULL
        LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id
        WHERE inv.company_id = ${companyId} AND inv.quantity > 0
        GROUP BY sg.id, sg.name
        ORDER BY total_value DESC
        LIMIT ${rowLimit}
      `);
  let grandTotalValue = 0,
    grandTotalItems = 0;
  const tableRows2 = rows.rows.map((r) => {
    const val = toMoney(r.total_value).toNumber();
    grandTotalValue += val;
    grandTotalItems += parseInt(r.item_count || "0");
    return [r.group_name, String(r.item_count), fmtDec(toMoney(r.total_qty).toNumber()), fmt(val)];
  });
  tableRows2.push(["GRAND TOTAL", String(grandTotalItems), "—", fmt(grandTotalValue)]);
  const stats3 = [
    { label: "Total Stock Groups", value: String(tableRows2.length - 1) },
    { label: "Total Distinct Items", value: String(grandTotalItems) },
    { label: "Total Inventory Value", value: fmt(grandTotalValue), highlight: "positive" },
  ];
  return {
    queryType: "stock_valuation",
    title: "Stock Valuation by Group",
    subtitle: `As of ${todayStr}`,
    stats: stats3,
    table: { headers: ["Stock Group", "Items", "Total Qty", "Total Value"], rows: tableRows2 },
    noData: tableRows2.length <= 1,
  };
}

export async function runPhase3ContainerProfitability({
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
    import_date: string | null;
  }>(sql`
        SELECT c.container_number,
          s.legal_name AS supplier,
          cu.legal_name AS customer,
          c.currency,
          CAST(c.grand_total AS numeric) AS cost,
          CAST(cs.total_amount AS numeric) AS sale_amount,
          CAST(cs.commission AS numeric) AS commission,
          cs.payment_status,
          c.import_date
        FROM container_sales cs
        JOIN containers c ON c.id = cs.container_id
        JOIN suppliers s ON s.id = c.supplier_id
        JOIN customers cu ON cu.id = cs.customer_id
        WHERE c.company_id = ${companyId}
          AND CAST(cs.sale_date AS text) BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY cs.sale_date DESC
        LIMIT ${rowLimit}
      `);
  let totCost = 0,
    totSale = 0,
    totProfit = 0;
  const tableRows2 = rows.rows.map((r) => {
    const cost = toMoney(r.cost).toNumber();
    const sale = toMoney(r.sale_amount).toNumber();
    const comm = toMoney(r.commission).toNumber();
    const profit3 = sale - cost - comm;
    const margin = sale > 0 ? ((profit3 / sale) * 100).toFixed(1) + "%" : "—";
    totCost += cost;
    totSale += sale;
    totProfit += profit3;
    return [
      r.container_number,
      r.supplier,
      r.customer,
      r.currency,
      fmt(cost),
      fmt(sale),
      fmt(comm),
      fmt(profit3),
      margin,
      r.payment_status,
    ];
  });
  if (tableRows2.length) {
    const totMargin = totSale > 0 ? ((totProfit / totSale) * 100).toFixed(1) + "%" : "—";
    tableRows2.push(["TOTAL", "", "", "", fmt(totCost), fmt(totSale), "", fmt(totProfit), totMargin, ""]);
  }
  return {
    queryType: "container_profitability",
    title: "Container Profitability",
    subtitle: `${dateFrom} → ${dateTo}`,
    table: {
      headers: ["Container #", "Supplier", "Customer", "Curr.", "Cost", "Sale", "Comm.", "Profit", "Margin", "Payment"],
      rows: tableRows2,
    },
    noData: tableRows2.length === 0,
  };
}

export async function runPhase3TopSellingItems({
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
    item_name: string;
    code: string;
    uom: string;
    total_qty: string;
    total_revenue: string;
    total_profit: string;
    num_transactions: string;
  }>(sql`
        SELECT si.name AS item_name, si.code, si.uom,
          SUM(CAST(sal.quantity AS numeric)) AS total_qty,
          SUM(CAST(sal.total_sales AS numeric)) AS total_revenue,
          SUM(CAST(sal.profit AS numeric)) AS total_profit,
          COUNT(DISTINCT v.id) AS num_transactions
        FROM sales_items sal
        JOIN stock_items si ON si.id = sal.stock_item_id
        JOIN vouchers v ON v.id = sal.voucher_id AND v.deleted_at IS NULL
        WHERE si.company_id = ${companyId}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY si.id, si.name, si.code, si.uom
        ORDER BY total_revenue DESC
        LIMIT ${rowLimit}
      `);
  const tableRows2 = rows.rows.map((r, i) => [
    String(i + 1),
    r.item_name,
    r.code,
    `${fmtDec(toMoney(r.total_qty).toNumber())} ${r.uom}`,
    fmt(toMoney(r.total_revenue).toNumber()),
    fmt(toMoney(r.total_profit).toNumber()),
    String(r.num_transactions),
  ]);
  return {
    queryType: "top_selling_items",
    title: "Top Selling Items",
    subtitle: `${dateFrom} → ${dateTo} · by revenue`,
    table: {
      headers: ["#", "Item", "Code", "Qty Sold", "Revenue", "Profit", "Transactions"],
      rows: tableRows2,
    },
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
