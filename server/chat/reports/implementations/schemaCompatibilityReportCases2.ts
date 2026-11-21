// Extracted from ./schemaCompatibilityReportShard.ts: report query handlers.
import { db, sql } from "./reportShardSupport";
import { toMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";
export { runSchemaCompatibilityStockItemDetail } from "./schemaCompatibilityReportCases2Helpers";

export async function runSchemaCompatibilitySupplierContainerHistory({
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
  const supplierName = params.entityName;
  if (!supplierName) {
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
          CAST(c.grand_total AS numeric) AS grand_total,
          COALESCE((
            SELECT po.currency
            FROM purchase_orders po
            WHERE po.container_id = c.id
            ORDER BY po.id DESC
            LIMIT 1
          ), 'USD') AS currency,
          c.total_kg, c.rate_per_kg, c.item_name, s.legal_name AS supplier
        FROM containers c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.company_id = ${companyId}
          AND s.legal_name ILIKE ${"%" + supplierName + "%"}
        ORDER BY c.import_date DESC
        LIMIT ${rowLimit}
      `);
  let totalValue = 0;
  let totalKg = 0;
  const statusCounts: Record<string, number> = {};
  const tableRows = rows.rows.map((r) => {
    const value = toMoney(r.grand_total).toNumber();
    const kg = toMoney(r.total_kg).toNumber();
    totalValue += value;
    totalKg += kg;
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
    return [
      r.container_number,
      r.status,
      r.import_date ? String(r.import_date).slice(0, 10) : "—",
      r.eta ? String(r.eta).slice(0, 10) : "—",
      fmtDec(kg),
      fmt(value),
      r.currency,
      r.item_name || "—",
    ];
  });
  return {
    queryType: "supplier_container_history",
    title: `Supplier Containers: ${rows.rows[0]?.supplier || supplierName}`,
    subtitle: `${tableRows.length} container(s)`,
    stats: [
      { label: "Containers", value: String(tableRows.length) },
      { label: "Total Kg", value: fmtDec(totalKg) },
      { label: "Total Value", value: fmt(totalValue), highlight: "positive" },
      {
        label: "Status Mix",
        value:
          Object.entries(statusCounts)
            .map(([status, count]) => `${status}: ${count}`)
            .join(" · ") || "—",
      },
    ],
    table: {
      headers: ["Container #", "Status", "Import Date", "ETA", "Kg", "Value", "Currency", "Item"],
      rows: tableRows,
    },
    noData: tableRows.length === 0,
  };
}

export async function runSchemaCompatibilityContainerCostBreakdown({
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
  const containerFilter = params.containerNumber || params.entityName;
  if (!containerFilter) {
    return {
      queryType: "container_cost_breakdown",
      title: "Container Cost Breakdown",
      summary: "Please specify a container number.",
    };
  }
  const containerRows = await db.execute<{
    id: number;
    container_number: string;
    status: string;
    import_date: string | null;
    currency: string;
    supplier: string | null;
    items_total: string;
    charges_total: string;
    grand_total: string;
    total_kg: string | null;
    rate_per_kg: string | null;
    transport_fee: string | null;
    duty_fee: string | null;
    transporter: string | null;
    agent: string | null;
  }>(sql`
        SELECT c.id, c.container_number, c.status, c.import_date,
          COALESCE((
            SELECT po.currency
            FROM purchase_orders po
            WHERE po.container_id = c.id
            ORDER BY po.id DESC
            LIMIT 1
          ), 'USD') AS currency,
          s.legal_name AS supplier,
          CAST(c.items_total AS numeric) AS items_total,
          CAST(c.charges_total AS numeric) AS charges_total,
          CAST(c.grand_total AS numeric) AS grand_total,
          CAST(c.total_kg AS numeric) AS total_kg,
          CAST(c.rate_per_kg AS numeric) AS rate_per_kg,
          CAST(c.transport_fee AS numeric) AS transport_fee,
          CAST(c.duty_fee AS numeric) AS duty_fee,
          c.transporter, c.agent
        FROM containers c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.company_id = ${companyId}
          AND c.container_number ILIKE ${"%" + containerFilter + "%"}
        ORDER BY c.import_date DESC
        LIMIT 1
      `);
  if (!containerRows.rows.length) {
    return {
      queryType: "container_cost_breakdown",
      title: "Container Cost Breakdown",
      summary: `No container found matching "${containerFilter}".`,
    };
  }
  const container = containerRows.rows[0];
  const poRows = await db.execute<{
    po_number: string;
    currency: string;
    freight: string;
    surcharge: string;
    fumigation: string;
    doc_charges: string;
    discount: string;
  }>(sql`
        SELECT po.po_number, po.currency,
          CAST(po.freight AS numeric) AS freight,
          CAST(po.surcharge AS numeric) AS surcharge,
          CAST(po.fumigation AS numeric) AS fumigation,
          CAST(po.document_charges AS numeric) AS doc_charges,
          CAST(po.discount AS numeric) AS discount
        FROM purchase_orders po
        WHERE po.container_id = ${container.id}
        ORDER BY po.id
        LIMIT 10
      `);
  const stats = [
    { label: "Supplier", value: container.supplier },
    { label: "Status", value: container.status },
    { label: "Import Date", value: container.import_date ? String(container.import_date).slice(0, 10) : "—" },
    { label: "Total Kg", value: fmtDec(toMoney(container.total_kg).toNumber()) },
    { label: "Rate/Kg", value: fmtDec(toMoney(container.rate_per_kg).toNumber()) },
    { label: "Grand Total", value: fmt(toMoney(container.grand_total).toNumber()), highlight: "positive" },
  ];
  const breakdownRows: string[][] = [
    ["Items Total", container.currency, fmt(toMoney(container.items_total).toNumber())],
    ["Charges Total", container.currency, fmt(toMoney(container.charges_total).toNumber())],
  ];
  if (toMoney(container.transport_fee).toNumber() > 0) {
    breakdownRows.push(["Transport Fee", container.currency, fmt(toMoney(container.transport_fee).toNumber())]);
  }
  if (toMoney(container.duty_fee).toNumber() > 0) {
    breakdownRows.push(["Duty Fee", container.currency, fmt(toMoney(container.duty_fee).toNumber())]);
  }
  for (const po of poRows.rows) {
    if (toMoney(po.freight).toNumber() > 0)
      breakdownRows.push([`Freight (${po.po_number})`, po.currency, fmt(toMoney(po.freight).toNumber())]);
    if (toMoney(po.fumigation).toNumber() > 0)
      breakdownRows.push([`Fumigation (${po.po_number})`, po.currency, fmt(toMoney(po.fumigation).toNumber())]);
    if (toMoney(po.surcharge).toNumber() > 0)
      breakdownRows.push([`Surcharge (${po.po_number})`, po.currency, fmt(toMoney(po.surcharge).toNumber())]);
    if (toMoney(po.doc_charges).toNumber() > 0)
      breakdownRows.push([`Doc Charges (${po.po_number})`, po.currency, fmt(toMoney(po.doc_charges).toNumber())]);
    if (toMoney(po.discount).toNumber() > 0)
      breakdownRows.push([`Discount (${po.po_number})`, po.currency, `(${fmt(toMoney(po.discount).toNumber())})`]);
  }
  breakdownRows.push(["GRAND TOTAL", container.currency, fmt(toMoney(container.grand_total).toNumber())]);
  return {
    queryType: "container_cost_breakdown",
    title: `Cost Breakdown: ${container.container_number}`,
    subtitle: container.transporter
      ? `Transporter: ${container.transporter}${container.agent ? ` · Agent: ${container.agent}` : ""}`
      : "",
    stats,
    table: { headers: ["Component", "Currency", "Amount"], rows: breakdownRows },
    noData: false,
  };
}
