import { pool } from "../../db";

export interface ProfitSourceItem {
  id: number | string;
  code: string;
  name: string;
  stock_group_id: number | null;
  stock_group_name: string | null;
  proforma_qty: number | string | null;
  proforma_price: number | string | null;
  proforma_barcode: string | null;
  unresolved?: boolean;
}

interface BuildSupplierProfitRowsInput {
  companyId: number;
  supplierId: number | null;
  items: ProfitSourceItem[];
  fromDate?: string | null;
  toDate?: string | null;
  sellPriceSource?: string | null;
  locationId?: number | null;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Defensive final boundary: Supplier Profit Check must never expose more than
 * one row for a stock item. Source queries already aggregate, but keeping the
 * invariant here prevents a later SQL change from reintroducing duplicate rows
 * and double-counting totals in the client. Negative ids are reserved for
 * unresolved source rows so imported proforma quantities are never silently
 * discarded just because a barcode no longer resolves to an active stock item.
 */
export function consolidateProfitSourceItems(items: ProfitSourceItem[]): ProfitSourceItem[] {
  const byId = new Map<number, ProfitSourceItem>();

  for (const item of items) {
    const id = Number(item.id);
    if (!Number.isInteger(id) || id === 0) continue;

    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { ...item, id });
      continue;
    }

    const existingQty = finiteNumber(existing.proforma_qty);
    const incomingQty = finiteNumber(item.proforma_qty);
    existing.proforma_qty =
      existingQty === null && incomingQty === null ? null : (existingQty ?? 0) + (incomingQty ?? 0);

    if (existing.proforma_price == null && item.proforma_price != null) existing.proforma_price = item.proforma_price;
    if (!existing.proforma_barcode && item.proforma_barcode) existing.proforma_barcode = item.proforma_barcode;
    if (item.unresolved) existing.unresolved = true;
  }

  return [...byId.values()];
}

export async function buildSupplierProfitRows({
  companyId,
  supplierId,
  items: sourceItems,
  fromDate,
  toDate,
  sellPriceSource,
  locationId,
}: BuildSupplierProfitRowsInput) {
  const items = consolidateProfitSourceItems(sourceItems);
  if (items.length === 0) return [];

  const stockItemIds = items.map((item) => Number(item.id)).filter((id) => id > 0);
  const allTime = !fromDate || !toDate;

  const avgSellResult = allTime
    ? await pool.query(
        `
        SELECT sales.stock_item_id,
          SUM(sales.total_sales::numeric) / NULLIF(SUM(sales.quantity::numeric), 0) AS avg_selling_price,
          SUM(sales.quantity::numeric) AS total_qty
        FROM sales_items sales
        JOIN vouchers v ON v.id = sales.voucher_id
        WHERE v.company_id = $1
          AND v.voucher_type = 'Sales'
          AND v.deleted_at IS NULL
          AND sales.stock_item_id = ANY($2::int[])
        GROUP BY sales.stock_item_id
      `,
        [companyId, stockItemIds]
      )
    : await pool.query(
        `
        SELECT sales.stock_item_id,
          SUM(sales.total_sales::numeric) / NULLIF(SUM(sales.quantity::numeric), 0) AS avg_selling_price,
          SUM(sales.quantity::numeric) AS total_qty
        FROM sales_items sales
        JOIN vouchers v ON v.id = sales.voucher_id
        WHERE v.company_id = $1
          AND v.voucher_type = 'Sales'
          AND v.voucher_date >= $2
          AND v.voucher_date <= $3
          AND v.deleted_at IS NULL
          AND sales.stock_item_id = ANY($4::int[])
        GROUP BY sales.stock_item_id
      `,
        [companyId, fromDate, toDate, stockItemIds]
      );

  const avgSellMap = new Map<number, { avgSellingPrice: number | null; salesQty: number }>();
  for (const row of avgSellResult.rows) {
    avgSellMap.set(Number(row.stock_item_id), {
      avgSellingPrice: row.avg_selling_price != null ? Number(row.avg_selling_price) : null,
      salesQty: row.total_qty != null ? Number(row.total_qty) : 0,
    });
  }

  const nCostResult = supplierId
    ? await pool.query(
        `
        SELECT DISTINCT ON (pli.stock_item_id)
          pli.stock_item_id,
          pli.rate::numeric AS rate
        FROM po_line_items pli
        JOIN purchase_orders po ON po.id = pli.po_id
        WHERE po.company_id = $1
          AND po.supplier_id = $2
          AND pli.stock_item_id = ANY($3::int[])
        ORDER BY pli.stock_item_id, po.created_at DESC, po.id DESC
      `,
        [companyId, supplierId, stockItemIds]
      )
    : { rows: [] };
  const nCostMap = new Map<number, number>();
  for (const row of nCostResult.rows) nCostMap.set(Number(row.stock_item_id), Number(row.rate));

  const hassansPriceResult = await pool.query(
    `
    SELECT si.id AS stock_item_id,
      COALESCE(
        NULLIF(si.selling_price::numeric, 0),
        (
          SELECT MAX(silp.selling_price::numeric)
          FROM stock_item_location_prices silp
          JOIN locations l ON l.id = silp.location_id
          WHERE silp.stock_item_id = si.id
            AND l.company_id = $1
        )
      ) AS hassans_price
    FROM stock_items si
    WHERE si.company_id = $1
      AND si.deleted_at IS NULL
      AND si.id = ANY($2::int[])
  `,
    [companyId, stockItemIds]
  );
  const hassansPriceMap = new Map<number, number>();
  for (const row of hassansPriceResult.rows) {
    hassansPriceMap.set(Number(row.stock_item_id), Number(row.hassans_price) || 0);
  }

  const stockResult = await pool.query(
    `
    SELECT i.stock_item_id,
      SUM(i.quantity::numeric) AS current_stock,
      SUM(i.total_value::numeric) / NULLIF(SUM(i.quantity::numeric), 0) AS avg_cost,
      MAX(i.average_rate::numeric) AS max_avg_rate
    FROM inventory i
    WHERE i.company_id = $1
      AND i.stock_item_id = ANY($2::int[])
    GROUP BY i.stock_item_id
  `,
    [companyId, stockItemIds]
  );
  const stockMap = new Map<number, { currentStock: number; avgCost: number }>();
  for (const row of stockResult.rows) {
    stockMap.set(Number(row.stock_item_id), {
      currentStock: Number(row.current_stock) || 0,
      avgCost: row.avg_cost != null ? Number(row.avg_cost) : row.max_avg_rate != null ? Number(row.max_avg_rate) : 0,
    });
  }

  const avgCostFallbackResult = await pool.query(
    `
    SELECT DISTINCT ON (pli.stock_item_id)
      pli.stock_item_id,
      pli.rate::numeric AS rate
    FROM po_line_items pli
    JOIN purchase_orders po ON po.id = pli.po_id
    WHERE po.company_id = $1
      AND pli.stock_item_id = ANY($2::int[])
    ORDER BY pli.stock_item_id, po.created_at DESC, po.id DESC
  `,
    [companyId, stockItemIds]
  );
  const avgCostFallbackMap = new Map<number, number>();
  for (const row of avgCostFallbackResult.rows) {
    avgCostFallbackMap.set(Number(row.stock_item_id), Number(row.rate));
  }

  const groupPriceMap = new Map<number, number>();
  if (sellPriceSource === "location_group" && locationId) {
    const groupPriceResult = await pool.query(
      `
      SELECT silp.stock_item_id, silp.selling_price::numeric AS selling_price
      FROM stock_item_location_prices silp
      JOIN stock_items si ON si.id = silp.stock_item_id
      JOIN locations l ON l.id = silp.location_id
      WHERE silp.location_id = $2
        AND l.company_id = $1
        AND si.company_id = $1
        AND si.deleted_at IS NULL
        AND silp.stock_item_id = ANY($3::int[])
    `,
      [companyId, locationId, stockItemIds]
    );
    for (const row of groupPriceResult.rows) {
      const price = Number(row.selling_price);
      if (Number.isFinite(price) && price > 0) groupPriceMap.set(Number(row.stock_item_id), price);
    }
  }

  return items.map((item) => {
    const id = Number(item.id);
    const unresolved = item.unresolved === true || id < 0;
    const salesData = avgSellMap.get(id);
    const avgSellingPrice = salesData?.avgSellingPrice ?? null;
    const salesQty = salesData?.salesQty ?? 0;
    const nCost = nCostMap.get(id) ?? 0;
    const configPrice = hassansPriceMap.get(id) ?? 0;
    const inventoryData = stockMap.get(id);
    const currentStock = inventoryData?.currentStock ?? 0;
    const invAvgCost = inventoryData?.avgCost ?? 0;
    const offloadingCost = invAvgCost > 0 ? invAvgCost : (avgCostFallbackMap.get(id) ?? 0);
    const avgCostSource = invAvgCost > 0 ? "inventory" : avgCostFallbackMap.has(id) ? "po_fallback" : "missing";
    const proformaPrice = finiteNumber(item.proforma_price);
    const unresolvedProformaPrice = unresolved && proformaPrice != null && proformaPrice > 0 ? proformaPrice : null;
    const poPrice = nCostMap.has(id)
      ? nCostMap.get(id)!
      : avgCostFallbackMap.has(id)
        ? avgCostFallbackMap.get(id)!
        : unresolvedProformaPrice;
    const poPriceSource = nCostMap.has(id)
      ? "selected_supplier_po"
      : avgCostFallbackMap.has(id)
        ? "any_po_fallback"
        : unresolvedProformaPrice != null
          ? "proforma_unresolved"
          : "missing";
    const groupSellingPrice = groupPriceMap.get(id) ?? null;
    const hassansProfit = configPrice - offloadingCost;
    const baseCostProfit = avgSellingPrice != null ? avgSellingPrice - offloadingCost : null;
    const profitPercent =
      avgSellingPrice != null && avgSellingPrice > 0 && baseCostProfit != null
        ? (baseCostProfit / avgSellingPrice) * 100
        : null;
    const status =
      avgSellingPrice == null
        ? "no_sales_data"
        : baseCostProfit != null && baseCostProfit > 0
          ? "gaining"
          : baseCostProfit != null && baseCostProfit < 0
            ? "losing"
            : "break_even";

    return {
      stockItemId: id,
      code: item.code,
      name: item.name,
      stockGroupId: item.stock_group_id,
      stockGroupName: item.stock_group_name,
      currentStock,
      salesQty,
      avgSellingPrice,
      groupSellingPrice,
      poPrice,
      poPriceSource,
      inventoryAvgCost: offloadingCost,
      nCost,
      nCostSource: avgCostSource,
      configPrice,
      offloadingCost,
      totalCost: configPrice + offloadingCost,
      estimatedProfit: baseCostProfit,
      profitPercent,
      status,
      hassansProfit,
      proformaQty: item.proforma_qty != null ? Number(item.proforma_qty) : null,
      proformaBarcode: item.proforma_barcode,
      unresolved,
    };
  });
}
