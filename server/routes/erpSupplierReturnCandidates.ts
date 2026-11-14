/** Existing ERP supplier-return source lookup and strict quantity validation. */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../db";
import { resultRows } from "../lib/queryResult";

const qtyPattern = /^\d+(?:\.\d{1,3})?$/;
export type Row = Record<string, unknown>;
export type Candidate = {
  offloadItemId: number;
  offloadId: number;
  containerId: number;
  containerNumber: string;
  supplierId: number | null;
  supplierName: string | null;
  supplierCount: number;
  currency: string | null;
  currencyCount: number;
  stockItemId: number;
  code: string;
  name: string;
  locationId: number;
  originalQty: string;
  returnedQty: string;
  remainingQty: string;
  availableQty: string;
  unitPurchaseCost: string;
  unitLandedCost: string;
  averageCost: string;
};
export class ReturnError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}
export function quantity(value: unknown): Decimal {
  const raw = String(value ?? "").trim();
  if (!qtyPattern.test(raw))
    throw new ReturnError(
      400,
      "RETURN_QUANTITY_INVALID",
      "Quantities must be positive numbers with at most 3 decimals"
    );
  const number = new Decimal(raw);
  if (!number.isFinite() || !number.gt(0))
    throw new ReturnError(400, "RETURN_QUANTITY_INVALID", "Quantity must be greater than zero");
  return number;
}
function asNumber(value: unknown): number {
  return Number(value ?? 0);
}
function mapCandidate(row: Row): Candidate {
  const original = new Decimal(String(row.original_qty ?? 0));
  const returned = new Decimal(String(row.returned_qty ?? 0));
  const remaining = Decimal.max(original.minus(returned), 0);
  return {
    offloadItemId: asNumber(row.offload_item_id),
    offloadId: asNumber(row.offload_id),
    containerId: asNumber(row.container_id),
    containerNumber: String(row.container_number ?? ""),
    supplierId: row.supplier_id == null ? null : asNumber(row.supplier_id),
    supplierName: row.supplier_name == null ? null : String(row.supplier_name),
    supplierCount: asNumber(row.supplier_count),
    currency: row.currency == null ? null : String(row.currency),
    currencyCount: asNumber(row.currency_count),
    stockItemId: asNumber(row.stock_item_id),
    code: String(row.code ?? ""),
    name: String(row.item_name ?? ""),
    locationId: asNumber(row.location_id),
    originalQty: original.toFixed(3),
    returnedQty: returned.toFixed(3),
    remainingQty: remaining.toFixed(3),
    availableQty: String(row.available_qty ?? "0"),
    unitPurchaseCost: String(row.purchase_rate ?? "0"),
    averageCost: String(row.average_cost ?? "0"),
    unitLandedCost: original.gt(0) ? new Decimal(String(row.landed_total ?? "0")).div(original).toFixed(4) : "0",
  };
}
export async function candidates(executor: DatabaseOrTransaction, companyId: number, code: string): Promise<Candidate[]> {
  const rows = resultRows<Row>(
    await executor.execute(sql`
    SELECT coi.id AS offload_item_id, co.id AS offload_id, c.id AS container_id,
           c.container_number, co.location_id, coi.stock_item_id,
           si.code, si.name AS item_name, coi.quantity::text AS original_qty,
           coi.rate::text AS purchase_rate, coi.total_value::text AS landed_total,
           COALESCE(rt.returned, 0)::text AS returned_qty,
           COALESCE(i.quantity, 0)::text AS available_qty,
           CASE WHEN i.quantity > 0 THEN (i.total_value / i.quantity)::text ELSE '0' END AS average_cost,
           sources.supplier_id, sources.supplier_name, sources.supplier_count,
           sources.currency, sources.currency_count
    FROM container_offload_items coi
    JOIN container_offloads co ON co.id = coi.offload_id
    JOIN containers c ON c.id = co.container_id AND c.company_id = ${companyId}
    JOIN stock_items si ON si.id = coi.stock_item_id AND si.company_id = ${companyId}
    LEFT JOIN inventory i ON i.company_id = ${companyId} AND i.location_id = co.location_id
       AND i.stock_item_id = coi.stock_item_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(l.quantity), 0) AS returned
        FROM erp_supplier_return_lines l
       WHERE l.company_id = ${companyId} AND l.offload_item_id = coi.id
    ) rt ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(po.supplier_id) AS supplier_id, MIN(s.legal_name) AS supplier_name,
             COUNT(DISTINCT po.supplier_id)::int AS supplier_count,
             MIN(UPPER(po.currency)) AS currency,
             COUNT(DISTINCT UPPER(po.currency))::int AS currency_count
        FROM purchase_orders po
        JOIN po_line_items pli ON pli.po_id = po.id AND pli.stock_item_id = coi.stock_item_id
        JOIN suppliers s ON s.id = po.supplier_id
       WHERE po.company_id = ${companyId} AND po.container_id = c.id
    ) sources ON TRUE
    WHERE c.status = 'OFFLOADED' AND co.optional = FALSE
      AND (UPPER(si.code) = UPPER(${code}) OR EXISTS (
        SELECT 1 FROM stock_item_code_aliases a
         WHERE a.company_id = ${companyId} AND a.stock_item_id = si.id AND UPPER(a.alias_code) = UPPER(${code})
      ))
    ORDER BY co.offloaded_at DESC, c.id DESC, coi.id DESC
  `)
  );
  return rows.map(mapCandidate);
}
export async function byId(executor: DatabaseOrTransaction, companyId: number, itemId: number): Promise<Candidate> {
  // Resolve by the authoritative item code, not a client-provided cost or supplier.
  const [ref] = resultRows<{ code: string }>(
    await executor.execute(sql`
    SELECT si.code FROM container_offload_items coi
      JOIN container_offloads co ON co.id=coi.offload_id
      JOIN containers c ON c.id=co.container_id
      JOIN stock_items si ON si.id=coi.stock_item_id
     WHERE coi.id=${itemId} AND c.company_id=${companyId} AND si.company_id=${companyId}
  `)
  );
  if (!ref) throw new ReturnError(404, "RETURN_SOURCE_MISSING", "Offloaded item was not found in this company");
  const matched = await candidates(executor, companyId, ref.code);
  const selected = matched.find((item) => item.offloadItemId === itemId);
  if (!selected)
    throw new ReturnError(409, "RETURN_SOURCE_UNAVAILABLE", "The source container is no longer an active offload");
  return selected;
}
