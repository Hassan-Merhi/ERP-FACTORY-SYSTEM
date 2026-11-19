// Extracted from ./retailAndFactoryReportShard.ts: report query handlers.
import { db, sql } from "./reportShardSupport";
import { toMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";

export async function runPhase4LocationStockSummary({
  params,
  companyId,
  rowLimit,
  fmtDec,
  fmt,
  todayStr,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmtDec: DataQueryContext["fmtDec"];
  fmt: DataQueryContext["fmt"];
  todayStr: DataQueryContext["todayStr"];
}) {
  const locFilter = params.entityName || params.locationName;
  const rows = await db.execute<{
    location: string;
    item_count: string;
    total_qty: string | null;
    total_value: string | null;
  }>(sql`
        SELECT l.name AS location,
          COUNT(DISTINCT inv.stock_item_id) AS item_count,
          SUM(CAST(inv.quantity AS numeric)) AS total_qty,
          SUM(CAST(inv.total_value AS numeric)) AS total_value
        FROM inventory inv
        JOIN locations l ON l.id = inv.location_id
        WHERE inv.company_id = ${companyId}
          AND inv.quantity > 0
          ${locFilter ? sql`AND l.name ILIKE ${"%" + locFilter + "%"}` : sql``}
        GROUP BY l.id, l.name
        ORDER BY total_value DESC
        LIMIT ${rowLimit}
      `);
  let grandItems = 0,
    grandValue = 0;
  const tableRows4 = rows.rows.map((r) => {
    const items = parseInt(r.item_count || "0");
    const val = toMoney(r.total_value).toNumber();
    grandItems += items;
    grandValue += val;
    return [r.location, String(items), fmtDec(toMoney(r.total_qty).toNumber()), fmt(val)];
  });
  tableRows4.push(["GRAND TOTAL", String(grandItems), "—", fmt(grandValue)]);
  const stats4 = [
    { label: "Locations", value: String(tableRows4.length - 1) },
    { label: "Total Stock Items", value: String(grandItems) },
    { label: "Total Value", value: fmt(grandValue), highlight: "positive" },
  ];
  return {
    queryType: "location_stock_summary",
    title: locFilter ? `Stock Summary: ${locFilter}` : "Stock by Location",
    subtitle: `As of ${todayStr}`,
    stats: stats4,
    table: { headers: ["Location", "Items", "Total Qty", "Total Value"], rows: tableRows4 },
    noData: tableRows4.length <= 1,
  };
}

export async function runPhase4VoucherTypeSummary({
  companyId,
  dateFrom,
  dateTo,
  fmt,
}: {
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  fmt: DataQueryContext["fmt"];
}) {
  const rows = await db.execute<{
    voucher_type: string;
    count: string;
    total_amount: string | null;
    first_date: string | null;
    last_date: string | null;
  }>(sql`
        SELECT v.voucher_type,
          COUNT(v.id) AS count,
          SUM(CAST(v.total_amount AS numeric)) AS total_amount,
          MIN(CAST(v.voucher_date AS text)) AS first_date,
          MAX(CAST(v.voucher_date AS text)) AS last_date
        FROM vouchers v
        WHERE v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND v.optional = false
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY v.voucher_type
        ORDER BY count DESC
      `);
  let grandCount = 0,
    grandTotal = 0;
  const tableRows4 = rows.rows.map((r) => {
    const cnt = parseInt(r.count || "0");
    const amt = toMoney(r.total_amount).toNumber();
    grandCount += cnt;
    grandTotal += amt;
    return [r.voucher_type, String(cnt), fmt(amt), r.first_date?.slice(0, 10) || "—", r.last_date?.slice(0, 10) || "—"];
  });
  tableRows4.push(["TOTAL", String(grandCount), fmt(grandTotal), "", ""]);
  return {
    queryType: "voucher_type_summary",
    title: "Voucher Summary by Type",
    subtitle: `${dateFrom} → ${dateTo}`,
    table: { headers: ["Voucher Type", "Count", "Total Amount", "First", "Last"], rows: tableRows4 },
    noData: tableRows4.length <= 1,
  };
}

export async function runPhase4CustomerPaymentHistory({
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
  const custName = params.entityName;
  const rows = await db.execute<{
    voucher_date: string;
    voucher_type: string;
    description: string | null;
    voucher_number: string;
    amount: string;
    currency: string;
  }>(sql`
        SELECT v.voucher_date, v.voucher_type, v.description, v.voucher_number,
          CAST(v.total_amount AS numeric) AS amount, v.currency
        FROM vouchers v
        WHERE v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND v.voucher_type IN ('Receipt', 'Payment')
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
          ${custName ? sql`AND v.description ILIKE ${"%" + custName + "%"}` : sql``}
        ORDER BY v.voucher_date DESC
        LIMIT ${rowLimit}
      `);
  let totalReceipts = 0,
    totalPayments = 0;
  const tableRows4 = rows.rows.map((r) => {
    const amt = toMoney(r.amount).toNumber();
    if (r.voucher_type === "Receipt") totalReceipts += amt;
    else totalPayments += amt;
    return [
      String(r.voucher_date).slice(0, 10),
      r.voucher_number,
      r.voucher_type,
      (r.description || "").slice(0, 40),
      fmt(amt),
      r.currency,
    ];
  });
  const stats4 = [
    { label: "Total Receipts", value: fmt(totalReceipts), highlight: "positive" },
    { label: "Total Payments", value: fmt(totalPayments) },
  ];
  return {
    queryType: "customer_payment_history",
    title: custName ? `Payment History: ${custName}` : "Customer Payment History",
    subtitle: `${dateFrom} → ${dateTo} · ${tableRows4.length} transaction(s)`,
    stats: stats4,
    table: {
      headers: ["Date", "Voucher #", "Type", "Description", "Amount", "Currency"],
      rows: tableRows4,
    },
    noData: tableRows4.length === 0,
  };
}
