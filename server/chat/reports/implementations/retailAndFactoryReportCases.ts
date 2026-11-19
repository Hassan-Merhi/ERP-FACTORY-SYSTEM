// Extracted from ./retailAndFactoryReportShard.ts: report query handlers.
import { db, sql } from "./reportShardSupport";
import { toMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";

export async function runPhase4FactoryWasteAnalysis({
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
  const rows = await db.execute<{ date: string; waste_type: string; kg_waste: string; reason: string | null }>(sql`
        SELECT fwe.date, fwe.waste_type,
          CAST(fwe.kg_waste AS numeric) AS kg_waste,
          fwe.reason
        FROM factory_waste_entries fwe
        WHERE fwe.company_id = ${companyId}
          AND fwe.date BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY fwe.date DESC
        LIMIT ${rowLimit}
      `);
  let totalWaste = 0;
  const typeMap: Record<string, number> = {};
  const tableRows4 = rows.rows.map((r) => {
    const kg = toMoney(r.kg_waste).toNumber();
    totalWaste += kg;
    const wt = r.waste_type || "Unknown";
    typeMap[wt] = (typeMap[wt] || 0) + kg;
    return [String(r.date).slice(0, 10), wt, fmtDec(kg), (r.reason || "—").slice(0, 40)];
  });
  const byType = Object.entries(typeMap)
    .sort((a, b) => b[1] - a[1])
    .map(([t, kg]) => `${t}: ${fmtDec(kg)} kg`)
    .join(" | ");
  const stats4 = [
    { label: "Total Waste Entries", value: String(tableRows4.length) },
    { label: "Total Waste Kg", value: fmtDec(totalWaste), highlight: "negative" },
    { label: "By Type", value: byType || "—" },
  ];
  return {
    queryType: "factory_waste_analysis",
    title: "Factory Waste Analysis",
    subtitle: `${dateFrom} → ${dateTo}`,
    stats: stats4,
    table: { headers: ["Date", "Waste Type", "Kg", "Reason"], rows: tableRows4 },
    noData: tableRows4.length === 0,
  };
}

export async function runPhase4UpcomingArrivals({
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
    import_date: string | null;
    grand_total: string;
    currency: string;
    days_until_eta: number | null;
  }>(sql`
        SELECT c.container_number, c.status, c.eta,
          s.legal_name AS supplier,
          c.transporter, c.tracking_location,
          c.import_date,
          CAST(c.grand_total AS numeric) AS grand_total,
          c.currency,
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
  const tableRows4 = rows.rows.map((r) => {
    const days = r.days_until_eta ?? 0;
    const daysLabel = days <= 0 ? "TODAY/OVERDUE" : `${days}d`;
    return [
      r.container_number,
      r.status,
      String(r.eta).slice(0, 10),
      daysLabel,
      r.supplier,
      r.transporter || "—",
      r.tracking_location || "—",
    ];
  });
  return {
    queryType: "upcoming_arrivals",
    title: "Upcoming Container Arrivals",
    subtitle: `Next ${daysAhead} days · ${tableRows4.length} container(s) expected`,
    table: {
      headers: ["Container #", "Status", "ETA", "Days Away", "Supplier", "Transporter", "Last Location"],
      rows: tableRows4,
    },
    noData: tableRows4.length === 0,
  };
}

export async function runPhase4SupplierSpend({
  params,
  companyId,
  dateFrom,
  rowLimit,
  fmt,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
}) {
  const supplierFilter = params.entityName;
  const rows = await db.execute<{
    supplier: string;
    po_count: string;
    total_items: string | null;
    total_charges: string | null;
    currency: string;
  }>(sql`
        SELECT s.legal_name AS supplier,
          COUNT(po.id) AS po_count,
          SUM(CAST(po.items_total AS numeric)) AS total_items,
          SUM(CAST(po.freight AS numeric) + CAST(po.surcharge AS numeric) + CAST(po.fumigation AS numeric)
              + CAST(po.document_charges AS numeric) + CAST(po.other_charges AS numeric)
              - CAST(po.discount AS numeric)) AS total_charges,
          po.currency
        FROM purchase_orders po
        JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.company_id = ${companyId}
          AND po.created_at >= ${dateFrom}
          ${supplierFilter ? sql`AND s.legal_name ILIKE ${"%" + supplierFilter + "%"}` : sql``}
        GROUP BY s.id, s.legal_name, po.currency
        ORDER BY total_items DESC
        LIMIT ${rowLimit}
      `);
  const tableRows4 = rows.rows.map((r) => {
    const items = toMoney(r.total_items).toNumber();
    const charges = toMoney(r.total_charges).toNumber();
    return [r.supplier, String(r.po_count), fmt(items), fmt(charges), fmt(items + charges), r.currency];
  });
  return {
    queryType: "supplier_spend",
    title: supplierFilter ? `Supplier Spend: ${supplierFilter}` : "Supplier Purchase Spend",
    subtitle: `Since ${dateFrom} · ${tableRows4.length} supplier(s)`,
    table: {
      headers: ["Supplier", "POs", "Items Total", "Charges", "Grand Total", "Currency"],
      rows: tableRows4,
    },
    noData: tableRows4.length === 0,
  };
}

export async function runPhase4WorkerProductivity({
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
        SELECT fw.full_name,
          COUNT(fb.id) AS total_bales,
          COALESCE(SUM(CAST(fb.weight_kg AS numeric)), 0) AS total_kg,
          COALESCE(AVG(CAST(fb.weight_kg AS numeric)), 0) AS avg_kg_per_bale
        FROM factory_bales fb
        JOIN factory_workers fw ON fw.id = fb.worker_id
        WHERE fb.company_id = ${companyId}
          AND fb.status = 'Pressed'
          AND CAST(fb.pressed_at AS text) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY fw.id, fw.full_name
        ORDER BY total_bales DESC
        LIMIT ${rowLimit}
      `);
  const tableRows4 = rows.rows.map((r, i) => [
    String(i + 1),
    r.full_name,
    String(r.total_bales),
    fmtDec(toMoney(r.total_kg).toNumber()),
    fmtDec(toMoney(r.avg_kg_per_bale).toNumber()),
  ]);
  return {
    queryType: "worker_productivity",
    title: "Worker Productivity Ranking",
    subtitle: `${dateFrom} → ${dateTo} · by bales pressed`,
    table: { headers: ["Rank", "Worker", "Bales", "Total Kg", "Avg Kg/Bale"], rows: tableRows4 },
    noData: tableRows4.length === 0,
  };
}

export async function runPhase4ContainerOffloadDetails({
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
  const cnFilter = params.containerNumber || params.entityName;
  if (!cnFilter) {
    return {
      queryType: "container_offload_details",
      title: "Container Offload Details",
      summary: "Please specify a container number.",
    };
  }
  const rows = await db.execute<{
    container_number: string;
    location: string;
    item_name: string;
    code: string;
    uom: string;
    qty: string;
    rate: string;
    total_value: string;
    offloaded_at: Date | null;
  }>(sql`
        SELECT c.container_number, l.name AS location,
          si.name AS item_name, si.code, si.uom,
          CAST(coi.quantity AS numeric) AS qty,
          CAST(coi.rate AS numeric) AS rate,
          CAST(coi.total_value AS numeric) AS total_value,
          co.offloaded_at
        FROM container_offload_items coi
        JOIN container_offloads co ON co.id = coi.offload_id
        JOIN containers c ON c.id = co.container_id
        JOIN locations l ON l.id = co.location_id
        JOIN stock_items si ON si.id = coi.stock_item_id
        WHERE c.container_number ILIKE ${"%" + cnFilter + "%"}
          AND c.company_id = ${companyId}
        ORDER BY si.name
        LIMIT ${rowLimit}
      `);
  let totalVal = 0;
  const tableRows4 = rows.rows.map((r) => {
    const val = toMoney(r.total_value).toNumber();
    totalVal += val;
    return [
      r.item_name,
      r.code,
      r.location,
      `${fmtDec(toMoney(r.qty).toNumber())} ${r.uom}`,
      fmtDec(toMoney(r.rate).toNumber()),
      fmt(val),
    ];
  });
  const cn = (rows.rows[0] as { container_number: unknown })?.container_number || cnFilter;
  return {
    queryType: "container_offload_details",
    title: `Offload Details: ${cn}`,
    subtitle: `${tableRows4.length} line(s) · Total value: ${fmt(totalVal)}`,
    table: { headers: ["Item", "Code", "Location", "Qty", "Rate", "Total Value"], rows: tableRows4 },
    noData: tableRows4.length === 0,
  };
}

export async function runPhase4IntercompanyTransfers({
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
    transfer_date: string;
    transfer_type: string;
    from_company: string | null;
    to_company: string | null;
    amount: string;
    description: string | null;
  }>(sql`
        SELECT ict.transfer_date, ict.transfer_type,
          fc.name AS from_company, tc.name AS to_company,
          CAST(ict.amount AS numeric) AS amount,
          ict.description
        FROM inter_company_transfers ict
        JOIN companies fc ON fc.id = ict.from_company_id
        JOIN companies tc ON tc.id = ict.to_company_id
        WHERE (ict.from_company_id = ${companyId} OR ict.to_company_id = ${companyId})
          AND CAST(ict.transfer_date AS text) BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY ict.transfer_date DESC
        LIMIT ${rowLimit}
      `);
  // No in/out totals are computed here: the shard renders rows and a count,
  // and the accumulators that used to sit here were written but never read.
  const tableRows4 = rows.rows.map((r) => {
    const amt = toMoney(r.amount).toNumber();
    return [
      String(r.transfer_date).slice(0, 10),
      r.transfer_type,
      r.from_company,
      r.to_company,
      fmt(amt),
      (r.description || "").slice(0, 40),
    ];
  });
  return {
    queryType: "intercompany_transfers",
    title: "Inter-Company Transfers",
    subtitle: `${dateFrom} → ${dateTo} · ${tableRows4.length} transfer(s)`,
    table: { headers: ["Date", "Type", "From", "To", "Amount", "Description"], rows: tableRows4 },
    noData: tableRows4.length === 0,
  };
}

export async function runPhase4PosSalesSummary({
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
  const itemFilter = params.entityName;
  const rows = await db.execute<{
    product_name: string;
    article_code: string | null;
    total_qty: string | null;
    total_revenue: string | null;
    num_sales: string;
    currency_code: string | null;
  }>(sql`
        SELECT fpsi.product_name, fpsi.article_code,
          SUM(fpsi.quantity) AS total_qty,
          SUM(CAST(fpsi.total_amount AS numeric)) AS total_revenue,
          COUNT(DISTINCT fps.id) AS num_sales,
          fpsi.currency_code
        FROM factory_pos_sale_items fpsi
        JOIN factory_pos_sales fps ON fps.id = fpsi.sale_id AND fps.status = 'COMPLETED'
        WHERE fps.company_id = ${companyId}
          AND CAST(fps.tx_date AS text) BETWEEN ${dateFrom} AND ${dateTo}
          ${itemFilter ? sql`AND fpsi.product_name ILIKE ${"%" + itemFilter + "%"}` : sql``}
        GROUP BY fpsi.product_name, fpsi.article_code, fpsi.currency_code
        ORDER BY total_revenue DESC
        LIMIT ${rowLimit}
      `);
  const totalsRow = await db.execute<{ num_transactions: string; grand_total: string | null }>(sql`
        SELECT COUNT(id) AS num_transactions,
          SUM(CAST(total_amount AS numeric)) AS grand_total
        FROM factory_pos_sales
        WHERE company_id = ${companyId} AND status = 'COMPLETED'
          AND CAST(tx_date AS text) BETWEEN ${dateFrom} AND ${dateTo}
      `);
  const t4 = totalsRow.rows[0];
  const tableRows4 = rows.rows.map((r) => {
    const rev = toMoney(r.total_revenue).toNumber();
    return [r.product_name, r.article_code || "—", String(r.total_qty), fmt(rev), r.currency_code, String(r.num_sales)];
  });
  const stats4 = [
    { label: "Total Transactions", value: String(t4?.num_transactions || 0) },
    {
      label: "Grand Total Revenue",
      value: fmt(toMoney(t4?.grand_total).toNumber()),
      highlight: "positive",
    },
  ];
  return {
    queryType: "pos_sales_summary",
    title: itemFilter ? `POS Sales: ${itemFilter}` : "POS Sales Summary",
    subtitle: `${dateFrom} → ${dateTo}`,
    stats: stats4,
    table: {
      headers: ["Product", "Article Code", "Qty", "Revenue", "Currency", "Sales"],
      rows: tableRows4,
    },
    noData: tableRows4.length === 0,
  };
}
