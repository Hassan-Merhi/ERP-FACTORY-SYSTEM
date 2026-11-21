// Extracted from ./schemaCompatibilityReportCases2.ts
import { db, sql } from "./reportShardSupport";
import { toMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";

export async function runSchemaCompatibilityStockItemDetail({
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
  const itemName = params.entityName;
  if (!itemName) {
    return { queryType: "stock_item_detail", title: "Stock Item Detail", summary: "Please specify an item name." };
  }
  const itemRows = await db.execute<{
    id: number;
    code: string;
    name: string;
    uom: string | null;
    selling_price: string | null;
    reorder_level: string | null;
    group_name: string | null;
  }>(sql`
        SELECT si.id, si.code, si.name, si.uom, si.selling_price, si.reorder_level,
          sg.name AS group_name
        FROM stock_items si
        LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id
        WHERE si.company_id = ${companyId}
          AND si.deleted_at IS NULL
          AND si.name ILIKE ${"%" + itemName + "%"}
        ORDER BY si.name
        LIMIT 1
      `);
  if (!itemRows.rows.length) {
    return {
      queryType: "stock_item_detail",
      title: "Stock Item Detail",
      summary: `No item found matching "${itemName}".`,
    };
  }
  const item = itemRows.rows[0];
  const inventoryRows = await db.execute<{
    location: string;
    qty: string;
    avg_rate: string;
    total_value: string;
  }>(sql`
        SELECT l.name AS location,
          CAST(inv.quantity AS numeric) AS qty,
          CAST(inv.average_rate AS numeric) AS avg_rate,
          CAST(inv.total_value AS numeric) AS total_value
        FROM inventory inv
        JOIN locations l ON l.id = inv.location_id
        WHERE inv.stock_item_id = ${item.id}
          AND inv.company_id = ${companyId}
          AND inv.quantity > 0
        ORDER BY inv.quantity DESC
      `);
  let totalQty = 0;
  let totalValue = 0;
  const tableRows = inventoryRows.rows.map((r) => {
    const qty = toMoney(r.qty).toNumber();
    const value = toMoney(r.total_value).toNumber();
    totalQty += qty;
    totalValue += value;
    return [r.location, fmtDec(qty), fmtDec(toMoney(r.avg_rate).toNumber()), fmt(value)];
  });
  return {
    queryType: "stock_item_detail",
    title: `Item: ${item.name}`,
    subtitle: `${tableRows.length} location(s) with stock`,
    stats: [
      { label: "Code", value: item.code },
      { label: "Group", value: item.group_name || "—" },
      { label: "UOM", value: item.uom },
      { label: "Selling Price", value: fmtDec(toMoney(item.selling_price).toNumber()) },
      { label: "Reorder Level", value: `${fmtDec(toMoney(item.reorder_level).toNumber())} ${item.uom}` },
      {
        label: "Total Stock",
        value: `${fmtDec(totalQty)} ${item.uom}`,
        highlight: totalQty > 0 ? "positive" : "negative",
      },
      { label: "Total Value", value: fmt(totalValue), highlight: "positive" },
    ],
    table: { headers: ["Location", "Qty", "Avg Rate", "Value"], rows: tableRows },
    noData: tableRows.length === 0,
  };
}
