// Extracted from ./phase2ReportShard.ts: report query handlers.
import { db, sql, accountTypesOfClassSql } from "./reportShardSupport";
import { toMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";
export { runPhase2CustomerAging, runPhase2LowStockItems } from "./phase2ReportCasesHelpers";

export async function runPhase2SupplierAging({
  companyId,
  rowLimit,
  fmt,
  todayStr,
}: {
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
  todayStr: DataQueryContext["todayStr"];
}) {
  const rows = await db.execute<{
    name: string;
    ob: string;
    total_debit: string;
    total_credit: string;
    bucket_0_30: string;
    bucket_31_60: string;
    bucket_61_90: string;
    bucket_over_90: string;
  }>(sql`
        SELECT la.name,
          COALESCE(CASE WHEN la.opening_balance_side = 'Dr' THEN -CAST(la.opening_balance AS numeric) ELSE CAST(la.opening_balance AS numeric) END, 0) AS ob,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS total_credit,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS total_debit,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false AND CURRENT_DATE - CAST(v.voucher_date AS date) BETWEEN 0 AND 30
            THEN CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS bucket_0_30,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false AND CURRENT_DATE - CAST(v.voucher_date AS date) BETWEEN 31 AND 60
            THEN CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS bucket_31_60,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false AND CURRENT_DATE - CAST(v.voucher_date AS date) BETWEEN 61 AND 90
            THEN CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS bucket_61_90,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false AND CURRENT_DATE - CAST(v.voucher_date AS date) > 90
            THEN CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS bucket_over_90
        FROM ledger_accounts la
        LEFT JOIN voucher_entries ve ON ve.ledger_account_id = la.id
        LEFT JOIN vouchers v ON v.id = ve.voucher_id
        WHERE la.company_id = ${companyId} AND la.active = true AND la.deleted_at IS NULL
          AND LOWER(TRIM(la.account_type)) IN (${accountTypesOfClassSql("liability")})
        GROUP BY la.id, la.name, la.opening_balance, la.opening_balance_side
        HAVING (
          COALESCE(CASE WHEN la.opening_balance_side = 'Dr' THEN -CAST(la.opening_balance AS numeric) ELSE CAST(la.opening_balance AS numeric) END, 0)
          + COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0)
        ) > 100
        ORDER BY (
          COALESCE(CASE WHEN la.opening_balance_side = 'Dr' THEN -CAST(la.opening_balance AS numeric) ELSE CAST(la.opening_balance AS numeric) END, 0)
          + COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0)
        ) DESC
        LIMIT ${rowLimit}
      `);
  let sgTotal0_30 = 0,
    sgTotal31_60 = 0,
    sgTotal61_90 = 0,
    sgTotalOver90 = 0,
    sgTotalAll = 0;
  const tableRows2 = rows.rows.map((r) => {
    const balance = toMoney(r.ob).plus(toMoney(r.total_credit)).minus(toMoney(r.total_debit)).toNumber();
    const b0 = toMoney(r.bucket_0_30).toNumber();
    const b1 = toMoney(r.bucket_31_60).toNumber();
    const b2 = toMoney(r.bucket_61_90).toNumber();
    const b3 = toMoney(r.bucket_over_90).toNumber();
    sgTotal0_30 += b0;
    sgTotal31_60 += b1;
    sgTotal61_90 += b2;
    sgTotalOver90 += b3;
    sgTotalAll += balance;
    return [
      r.name,
      fmt(balance),
      fmt(b0 > 0 ? b0 : 0),
      fmt(b1 > 0 ? b1 : 0),
      fmt(b2 > 0 ? b2 : 0),
      fmt(b3 > 0 ? b3 : 0),
    ];
  });
  tableRows2.push([
    "TOTAL",
    fmt(sgTotalAll),
    fmt(sgTotal0_30),
    fmt(sgTotal31_60),
    fmt(sgTotal61_90),
    fmt(sgTotalOver90),
  ]);
  return {
    queryType: "supplier_aging",
    title: "Supplier Payables Aging",
    subtitle: `As of ${todayStr}`,
    table: {
      headers: ["Supplier", "Total Owed", "0-30 days", "31-60 days", "61-90 days", "90+ days"],
      rows: tableRows2,
    },
    noData: tableRows2.length <= 1,
  };
}

export async function runPhase2OpenPurchaseOrders({
  params,
  companyId,
  rowLimit,
  fmtDec,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmtDec: DataQueryContext["fmtDec"];
}) {
  const supplierName = params.entityName;
  const rows = await db.execute<{
    po_number: string;
    supplier: string;
    container_number: string | null;
    currency: string;
    items_total: string;
    status: string;
    created_at: Date;
  }>(sql`
        SELECT po.po_number, s.legal_name AS supplier,
          c.container_number, po.currency,
          CAST(po.items_total AS numeric) AS items_total,
          po.status, po.created_at
        FROM purchase_orders po
        JOIN suppliers s ON s.id = po.supplier_id
        JOIN containers c ON c.id = po.container_id
        WHERE po.company_id = ${companyId}
          AND po.status = 'Open'
          ${supplierName ? sql`AND s.legal_name ILIKE ${"%" + supplierName + "%"}` : sql``}
        ORDER BY po.created_at DESC
        LIMIT ${rowLimit}
      `);
  const tableRows2 = rows.rows.map((r) => [
    r.po_number,
    r.supplier,
    r.container_number,
    r.currency,
    fmtDec(toMoney(r.items_total).toNumber()),
    r.status,
  ]);
  return {
    queryType: "open_purchase_orders",
    title: supplierName ? `Open POs — ${supplierName}` : "Open Purchase Orders",
    subtitle: `${tableRows2.length} open PO(s)`,
    table: {
      headers: ["PO #", "Supplier", "Container", "Currency", "Items Total", "Status"],
      rows: tableRows2,
    },
    noData: tableRows2.length === 0,
  };
}

export async function runPhase2StockMovement({
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
  const itemName = params.entityName;
  if (!itemName) {
    return {
      queryType: "stock_movement",
      title: "Stock Movement",
      summary: "Please specify an item name.",
    };
  }
  const rows = await db.execute<{
    voucher_date: string;
    adjustment_type: string;
    location: string;
    item_name: string;
    uom: string;
    qty: string;
    rate: string;
  }>(sql`
        SELECT v.voucher_date, sav.adjustment_type, l.name AS location,
          si.name AS item_name, si.uom,
          CAST(sai.quantity AS numeric) AS qty,
          CAST(sai.rate AS numeric) AS rate
        FROM stock_adjustment_items sai
        JOIN stock_adjustment_vouchers sav ON sav.id = sai.adjustment_id
        JOIN vouchers v ON v.id = sav.voucher_id AND v.deleted_at IS NULL
        JOIN stock_items si ON si.id = sai.stock_item_id
        JOIN locations l ON l.id = sav.location_id
        WHERE si.company_id = ${companyId}
          AND si.name ILIKE ${"%" + itemName + "%"}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY v.voucher_date DESC
        LIMIT ${rowLimit}
      `);
  const tableRows2 = rows.rows.map((r) => [
    String(r.voucher_date).slice(0, 10),
    r.adjustment_type,
    r.location,
    `${fmtDec(Math.abs(toMoney(r.qty).toNumber()))} ${r.uom}`,
    toMoney(r.qty).toNumber() >= 0 ? "IN" : "OUT",
  ]);
  return {
    queryType: "stock_movement",
    title: `Stock Movement: ${itemName}`,
    subtitle: `${dateFrom} → ${dateTo}`,
    table: { headers: ["Date", "Type", "Location", "Qty", "Direction"], rows: tableRows2 },
    noData: tableRows2.length === 0,
  };
}

export async function runPhase2InventoryCheck({
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
  const itemName = params.entityName;
  const locName = params.locationName;
  const rows = await db.execute<{
    item_name: string;
    code: string;
    uom: string;
    location_name: string;
    qty: string;
    avg_rate: string;
    total_value: string;
  }>(sql`
        SELECT si.name AS item_name, si.code, si.uom,
          l.name AS location_name,
          CAST(inv.quantity AS numeric) AS qty,
          CAST(inv.average_rate AS numeric) AS avg_rate,
          CAST(inv.total_value AS numeric) AS total_value
        FROM inventory inv
        JOIN stock_items si ON si.id = inv.stock_item_id AND si.deleted_at IS NULL
        JOIN locations l ON l.id = inv.location_id
        WHERE inv.company_id = ${companyId}
          AND inv.quantity > 0
          ${itemName ? sql`AND si.name ILIKE ${"%" + itemName + "%"}` : sql``}
          ${locName ? sql`AND l.name ILIKE ${"%" + locName + "%"}` : sql``}
        ORDER BY total_value DESC
        LIMIT ${rowLimit}
      `);
  const tableRows2 = rows.rows.map((r) => [
    r.item_name,
    r.code,
    r.location_name,
    `${fmtDec(toMoney(r.qty).toNumber())} ${r.uom}`,
    fmtDec(toMoney(r.avg_rate).toNumber()),
    fmt(toMoney(r.total_value).toNumber()),
  ]);
  return {
    queryType: "inventory_check",
    title: itemName ? `Stock Levels: ${itemName}` : "Inventory Stock Levels",
    subtitle: locName ? `Location: ${locName}` : "All locations",
    table: { headers: ["Item", "Code", "Location", "Qty", "Avg Rate", "Total Value"], rows: tableRows2 },
    noData: tableRows2.length === 0,
  };
}
