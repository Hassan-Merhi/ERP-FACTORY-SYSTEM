// Extracted from ./masterDataAndJournalReportShard.ts: report query handlers.
import { db, sql } from "./reportShardSupport";
import { toMoney, plusMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";

export async function runPhase6SupplierProformas({
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
  const suppFilter6 = params.entityName;
  const rows = await db.execute<{
    id: number;
    reference: string;
    supplier: string | null;
    notes: string | null;
    created_at: Date;
    line_count: string;
    total_qty: string;
    total_value: string;
  }>(sql`
        SELECT sp.id, sp.reference, s.legal_name AS supplier, sp.notes, sp.created_at,
          COUNT(spl.id) AS line_count,
          COALESCE(SUM(spl.qty), 0) AS total_qty,
          COALESCE(SUM(CAST(spl.price_per_bale AS numeric) * spl.qty), 0) AS total_value
        FROM supplier_proformas sp
        JOIN suppliers s ON s.id = sp.supplier_id
        LEFT JOIN supplier_proforma_lines spl ON spl.proforma_id = sp.id
        WHERE sp.company_id = ${companyId}
          ${suppFilter6 ? sql`AND s.legal_name ILIKE ${"%" + suppFilter6 + "%"}` : sql``}
        GROUP BY sp.id, sp.reference, s.legal_name, sp.notes, sp.created_at
        ORDER BY sp.created_at DESC
        LIMIT ${rowLimit}
      `);
  const tableRows6 = rows.rows.map((r) => [
    r.reference,
    r.supplier,
    String(r.line_count),
    String(r.total_qty),
    fmt(toMoney(r.total_value).toNumber()),
    String(r.created_at).slice(0, 10),
    (r.notes || "").slice(0, 40),
  ]);
  return {
    queryType: "supplier_proformas",
    title: suppFilter6 ? `Supplier Proformas: ${suppFilter6}` : "Supplier Proformas",
    subtitle: `${tableRows6.length} proforma(s)`,
    table: {
      headers: ["Reference", "Supplier", "Items", "Total Qty", "Total Value", "Date", "Notes"],
      rows: tableRows6,
    },
    noData: tableRows6.length === 0,
  };
}

export async function runPhase6CustomerProformas({
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
  const custFilter6 = params.entityName;
  const rows = await db.execute<{
    id: number;
    proforma_name: string;
    customer: string | null;
    is_active: boolean;
    created_at: Date;
    line_count: string;
    total_qty: string;
    total_value: string;
  }>(sql`
        SELECT cp.id, cp.name AS proforma_name, cu.legal_name AS customer,
          cp.is_active, cp.created_at,
          COUNT(cpl.id) AS line_count,
          COALESCE(SUM(cpl.quantity), 0) AS total_qty,
          COALESCE(SUM(CAST(cpl.price_per_bale AS numeric) * cpl.quantity), 0) AS total_value
        FROM customer_proformas cp
        JOIN customers cu ON cu.id = cp.customer_id
        LEFT JOIN customer_proforma_lines cpl ON cpl.proforma_id = cp.id
        WHERE cp.company_id = ${companyId}
          AND cp.deleted_at IS NULL
          ${custFilter6 ? sql`AND cu.legal_name ILIKE ${"%" + custFilter6 + "%"}` : sql``}
        GROUP BY cp.id, cp.name, cu.legal_name, cp.is_active, cp.created_at
        ORDER BY cp.is_active DESC, cu.legal_name
        LIMIT ${rowLimit}
      `);
  const tableRows6 = rows.rows.map((r) => [
    r.proforma_name,
    r.customer,
    String(r.line_count),
    String(r.total_qty),
    fmt(toMoney(r.total_value).toNumber()),
    r.is_active ? "Active" : "Inactive",
    String(r.created_at).slice(0, 10),
  ]);
  return {
    queryType: "customer_proformas",
    title: custFilter6 ? `Customer Proformas: ${custFilter6}` : "Customer Proformas",
    subtitle: `${tableRows6.length} proforma(s)`,
    table: {
      headers: ["Proforma", "Customer", "Items", "Total Qty", "Total Value", "Status", "Created"],
      rows: tableRows6,
    },
    noData: tableRows6.length === 0,
  };
}

export async function runPhase6FactoryMixBatches({
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
  const statusFilter6 = params.entityName?.toUpperCase() || null;
  const rows = await db.execute<{
    batch_code: string;
    name: string | null;
    batch_date: string | null;
    status: string;
    total_kg: string | null;
    used_kg: string | null;
    cost_per_kg: string | null;
    total_cost: string | null;
    operator_user: string | null;
  }>(sql`
        SELECT fmb.batch_code, fmb.name, fmb.batch_date, fmb.status,
          CAST(fmb.total_weight_kg AS numeric) AS total_kg,
          CAST(fmb.used_kg AS numeric) AS used_kg,
          CAST(fmb.cost_per_kg AS numeric) AS cost_per_kg,
          CAST(fmb.total_cost AS numeric) AS total_cost,
          fmb.operator_user
        FROM factory_mix_batches fmb
        WHERE fmb.company_id = ${companyId}
          AND fmb.deleted_at IS NULL
          ${statusFilter6 ? sql`AND fmb.status = ${statusFilter6}` : sql``}
          ${params.dateFrom ? sql`AND fmb.batch_date >= ${params.dateFrom}` : sql``}
        ORDER BY fmb.batch_date DESC, fmb.id DESC
        LIMIT ${rowLimit}
      `);
  let totWeight = 0,
    totUsed = 0,
    totCost = 0;
  const tableRows6 = rows.rows.map((r) => {
    const totalKg = toMoney(r.total_kg).toNumber();
    const usedKg = toMoney(r.used_kg).toNumber();
    const remainKg = totalKg - usedKg;
    const pct = totalKg > 0 ? ((usedKg / totalKg) * 100).toFixed(1) + "%" : "—";
    totWeight += totalKg;
    totUsed += usedKg;
    totCost = plusMoney(totCost, r.total_cost);
    return [
      r.batch_code,
      r.name || "—",
      r.batch_date ? String(r.batch_date).slice(0, 10) : "—",
      r.status,
      fmtDec(totalKg),
      fmtDec(usedKg),
      fmtDec(remainKg),
      pct,
      fmtDec(toMoney(r.cost_per_kg).toNumber()),
      r.operator_user || "—",
    ];
  });
  const stats6 = [
    { label: "Batches", value: String(tableRows6.length) },
    { label: "Total Weight Kg", value: fmtDec(totWeight) },
    { label: "Used Kg", value: fmtDec(totUsed) },
    { label: "Remaining Kg", value: fmtDec(totWeight - totUsed), highlight: "positive" },
    { label: "Total Cost", value: fmt(totCost) },
  ];
  return {
    queryType: "factory_mix_batches",
    title: statusFilter6 ? `Mix Batches — ${statusFilter6}` : "Factory Mix Batches",
    subtitle: `${tableRows6.length} batch(es)`,
    stats: stats6,
    table: {
      headers: ["Code", "Name", "Date", "Status", "Total Kg", "Used Kg", "Remaining", "Usage%", "Cost/Kg", "Operator"],
      rows: tableRows6,
    },
    noData: tableRows6.length === 0,
  };
}

export async function runPhase6StockItemDetail({
  params,
  companyId,
  fmtDec,
  fmt,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  fmtDec: DataQueryContext["fmtDec"];
  fmt: DataQueryContext["fmt"];
}) {
  const itemName6 = params.entityName;
  if (!itemName6) {
    return {
      queryType: "stock_item_detail",
      title: "Stock Item Detail",
      summary: "Please specify an item name.",
    };
  }
  const itemRow = await db.execute<{
    id: number;
    code: string;
    name: string;
    uom: string | null;
    selling_price: string | null;
    reorder_level: string | null;
    opening_qty: string | null;
    opening_rate: string | null;
    opening_value: string | null;
    active: boolean;
    group_name: string | null;
  }>(sql`
        SELECT si.id, si.code, si.name, si.uom, si.selling_price, si.reorder_level,
          si.opening_qty, si.opening_rate, si.opening_value, si.active,
          sg.name AS group_name
        FROM stock_items si
        LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id
        WHERE si.company_id = ${companyId}
          AND si.deleted_at IS NULL
          AND si.name ILIKE ${"%" + itemName6 + "%"}
        ORDER BY si.name LIMIT 1
      `);
  if (!itemRow.rows.length) {
    return {
      queryType: "stock_item_detail",
      title: "Stock Item Detail",
      summary: `No item found matching "${itemName6}".`,
    };
  }
  const si6 = itemRow.rows[0];
  const invRows = await db.execute<{ location: string; qty: string; avg_rate: string; total_value: string }>(sql`
        SELECT l.name AS location,
          CAST(inv.quantity AS numeric) AS qty,
          CAST(inv.avg_rate AS numeric) AS avg_rate,
          CAST(inv.total_value AS numeric) AS total_value
        FROM inventory inv
        JOIN locations l ON l.id = inv.location_id
        WHERE inv.stock_item_id = ${si6.id}
          AND inv.company_id = ${companyId}
          AND inv.quantity > 0
        ORDER BY inv.quantity DESC
      `);
  let totalQty = 0,
    totalVal = 0;
  const tableRows6 = invRows.rows.map((r) => {
    const qty = toMoney(r.qty).toNumber();
    const val = toMoney(r.total_value).toNumber();
    totalQty += qty;
    totalVal += val;
    return [r.location, fmtDec(qty), fmtDec(toMoney(r.avg_rate).toNumber()), fmt(val)];
  });
  const stats6 = [
    { label: "Code", value: si6.code },
    { label: "Group", value: si6.group_name || "—" },
    { label: "UOM", value: si6.uom },
    { label: "Selling Price", value: fmtDec(toMoney(si6.selling_price).toNumber()) },
    { label: "Reorder Level", value: `${fmtDec(toMoney(si6.reorder_level).toNumber())} ${si6.uom}` },
    {
      label: "Total Stock",
      value: `${fmtDec(totalQty)} ${si6.uom}`,
      highlight: totalQty > 0 ? "positive" : "negative",
    },
    { label: "Total Value", value: fmt(totalVal), highlight: "positive" },
  ];
  return {
    queryType: "stock_item_detail",
    title: `Item: ${si6.name}`,
    subtitle: `${tableRows6.length} location(s) with stock`,
    stats: stats6,
    table: { headers: ["Location", "Qty", "Avg Rate", "Value"], rows: tableRows6 },
    noData: tableRows6.length === 0,
  };
}

export async function runPhase6SupplierList({
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
  const nameFilter6 = params.entityName;
  const rows = await db.execute<{
    code: string;
    legal_name: string;
    email: string | null;
    phone: string | null;
    payment_terms: string | null;
    active: boolean;
    po_count: string;
    total_ordered: string;
  }>(sql`
        SELECT s.code, s.legal_name, s.email, s.phone, s.payment_terms, s.active,
          COUNT(DISTINCT po.id) AS po_count,
          COALESCE(SUM(CAST(po.items_total AS numeric)), 0) AS total_ordered
        FROM suppliers s
        JOIN purchase_orders po ON po.supplier_id = s.id AND po.company_id = ${companyId}
        WHERE s.deleted_at IS NULL
          ${nameFilter6 ? sql`AND s.legal_name ILIKE ${"%" + nameFilter6 + "%"}` : sql``}
        GROUP BY s.id, s.code, s.legal_name, s.email, s.phone, s.payment_terms, s.active
        ORDER BY total_ordered DESC
        LIMIT ${rowLimit}
      `);
  const tableRows6 = rows.rows.map((r) => [
    r.code || "—",
    r.legal_name,
    r.email || "—",
    r.phone || "—",
    r.payment_terms || "—",
    String(r.po_count),
    fmt(toMoney(r.total_ordered).toNumber()),
    r.active ? "Active" : "Inactive",
  ]);
  const stats6 = [
    { label: "Suppliers", value: String(tableRows6.length) },
    { label: "Total POs", value: String(tableRows6.reduce((s, r) => s + parseInt(r[5]), 0)) },
  ];
  return {
    queryType: "supplier_list",
    title: nameFilter6 ? `Suppliers: ${nameFilter6}` : "Supplier List",
    subtitle: `${tableRows6.length} supplier(s) · ranked by total ordered`,
    stats: stats6,
    table: {
      headers: ["Code", "Name", "Email", "Phone", "Terms", "POs", "Total Ordered", "Status"],
      rows: tableRows6,
    },
    noData: tableRows6.length === 0,
  };
}

export async function runPhase6CustomerList({
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
  const nameFilter6 = params.entityName;
  const rows = await db.execute<{
    code: string;
    legal_name: string;
    phone: string | null;
    payment_terms_days: number | null;
    active: boolean;
    net_balance: string | null;
  }>(sql`
        SELECT c.code, c.legal_name, c.phone, c.payment_terms_days, c.active,
          COALESCE(
            CAST(c.opening_balance AS numeric) * CASE WHEN c.opening_balance_side = 'Dr' THEN 1 ELSE -1 END
            + COALESCE(SUM(CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric)), 0),
            CAST(c.opening_balance AS numeric) * CASE WHEN c.opening_balance_side = 'Dr' THEN 1 ELSE -1 END
          ) AS net_balance
        FROM customers c
        LEFT JOIN ledger_accounts la ON la.id = c.ledger_account_id AND la.deleted_at IS NULL
        LEFT JOIN voucher_entries ve ON ve.ledger_account_id = la.id
        LEFT JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL AND v.optional = false
        WHERE c.company_id = ${companyId}
          AND c.deleted_at IS NULL
          ${nameFilter6 ? sql`AND c.legal_name ILIKE ${"%" + nameFilter6 + "%"}` : sql``}
        GROUP BY c.id, c.code, c.legal_name, c.phone, c.payment_terms_days, c.active, c.opening_balance, c.opening_balance_side
        ORDER BY c.legal_name
        LIMIT ${rowLimit}
      `);
  let totalBalance = 0;
  const tableRows6 = rows.rows.map((r) => {
    const bal = toMoney(r.net_balance).toNumber();
    totalBalance += Math.max(bal, 0);
    const balLabel = bal >= 0 ? fmt(bal) + " Dr" : fmt(Math.abs(bal)) + " Cr";
    return [
      r.code,
      r.legal_name,
      r.phone || "—",
      r.payment_terms_days ? `${r.payment_terms_days}d` : "—",
      balLabel,
      r.active ? "Active" : "Inactive",
    ];
  });
  const stats6 = [
    { label: "Total Customers", value: String(tableRows6.length) },
    { label: "Total Outstanding (Dr)", value: fmt(totalBalance), highlight: "positive" },
  ];
  return {
    queryType: "customer_list",
    title: nameFilter6 ? `Customers: ${nameFilter6}` : "Customer List",
    subtitle: `${tableRows6.length} customer(s)`,
    stats: stats6,
    table: { headers: ["Code", "Name", "Phone", "Terms", "Balance", "Status"], rows: tableRows6 },
    noData: tableRows6.length === 0,
  };
}
