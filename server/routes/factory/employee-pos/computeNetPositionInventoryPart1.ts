// Extracted from ./netPositionInventory.ts
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { factoryContainers } from "@shared/schema";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../../lib/money";

/** A numeric column from a raw query row, exactly (missing or unparsable is zero). */
export const col = (value: unknown) => toMoney(value as string | number | null | undefined);

/**
 * Rounded half up to the cent from the exact value. Rounding a binary float
 * instead sends a half-cent (999.995) either way depending on its binary
 * representation.
 */
export const cents = (value: Decimal) => value.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP).toNumber();

/**
 * The four inventory valuations in the factory net-position report: finished
 * stock, raw material, stock on the water, and material in process.
 *
 * They were computed inline in the handler and share the same four inputs, so
 * they move together. Everything else the block produced was scratch - only
 * these four values were read after it.
 *
 * config/report-characterization.json pins the endpoint's output across the move.
 */
export interface NetPositionInventoryContext {
  companyId: number;
  asOf: string;
  getConfigFx: (cc: string) => number;
  configFxRates: Record<string, number>;
  supplierLockedRateMapNp: Map<number, number>;
  allContainersF: (typeof factoryContainers.$inferSelect)[];
}

/**
 * A raw-stock row's USD cost per kg (wave 11): the landed USD cost, or the
 * container's own cost when its currency is USD; 0 (not valued) otherwise.
 * The container alias is `fc`, the raw-stock alias `frs`.
 */
const USD_COST_PER_KG = sql.raw(`CASE
        WHEN frs.cost_per_kg_usd::numeric > 0 THEN frs.cost_per_kg_usd::numeric
        WHEN UPPER(COALESCE(fc.currency_code, 'USD')) = 'USD' THEN COALESCE(frs.cost_per_kg::numeric, 0)
        ELSE 0
      END`);

export async function computeNetPositionInventoryPart1(ctx: NetPositionInventoryContext) {
  // Match the Location Inventory page: only available IN_STOCK bales and
  // catalogue production/selling prices, aggregated across all company locations.
  const invResult = await db.execute(sql`
    SELECT COALESCE(SUM(p.production_price::numeric), 0) AS total_cost,
           COALESCE(SUM(p.selling_price::numeric), 0) AS total_selling,
           0::numeric AS reserved_cost, 0::integer AS reserved_count
    FROM factory_bales b
    LEFT JOIN factory_bale_products p ON p.id = b.product_id AND p.company_id = ${ctx.companyId}
    WHERE b.company_id = ${ctx.companyId}
      AND b.status = 'IN_STOCK'
      AND b.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM customer_order_bales cob
        INNER JOIN customer_orders co ON co.id = cob.order_id
        WHERE cob.bale_id = b.id
          AND co.company_id = ${ctx.companyId}
          AND co.status IN ('LOADING','PENDING_VERIFICATION','VERIFIED','FINALIZED','DISPATCHED','SOLD')
      )
  `);
  const invRow = resultRows(invResult)[0] ?? {};
  const inventorySellValue = cents(col(invRow.total_cost));
  const inventorySellingValue = cents(col(invRow.total_selling));
  const reservedBaleCost = 0;
  const reservedBaleCount = 0;

  // ── 3b. Raw material stock value — direct SQL, mirrors /api/factory/raw-stock
  //
  // IMPORTANT: value must be the SUM of each row's own (received - used) * cost —
  // never remaining_kg * a received-weighted average cost across the whole supplier.
  // The latter misattributes whatever was actually consumed onto every other
  // container in the blend, which drifts from /api/factory/raw-stock's per-row
  // "valueRemainingUsd" (rawStockReceiptRoutes.ts) once a supplier has multiple
  // receipts at different cost/kg — this was the cause of "What We Have" showing a
  // different total than the Raw Materials page's "Available (Free) → Value (USD)".
  const rawResult = await db.execute(sql`
  SELECT
    fc.supplier_id,
    -- Unassigned receipt rows appear separately per container in Raw Materials.
    -- Preserve that row boundary so their cent rounding also matches.
    CASE WHEN fc.supplier_id IS NULL THEN fc.id ELSE NULL END AS unattached_container_id,
    SUM(frs.received_kg::numeric)                                            AS total_recv,
    SUM(frs.used_kg::numeric)                                                AS total_used,
    -- Local cost per kg (the currency on the container, e.g. AUD, EUR) — a
    -- received-weighted rate used only for display/adjustment math, never for
    -- the remaining-value total itself.
    SUM(frs.received_kg::numeric * frs.cost_per_kg::numeric)
      / NULLIF(SUM(frs.received_kg::numeric), 0)                             AS avg_cpk_local,
    -- USD cost per kg: the landed USD cost, or the container's own cost when
    -- its currency is USD. Never the native cost of another currency (wave
    -- 11): a row with no USD cost is not valued (it counts as zero).
    SUM(frs.received_kg::numeric * ${USD_COST_PER_KG})
      / NULLIF(SUM(frs.received_kg::numeric), 0)                             AS avg_cpk_usd,
    -- Per-row remaining cost basis, summed — mirrors rawStockReceiptRoutes.ts's
    -- rowRemainingValueLocal/rowRemainingValueUsd accumulation exactly.
    SUM((frs.received_kg::numeric - frs.used_kg::numeric) * frs.cost_per_kg::numeric)
                                                                               AS remaining_value_local,
    SUM((frs.received_kg::numeric - frs.used_kg::numeric) * ${USD_COST_PER_KG})
                                                                               AS remaining_value_usd
  FROM   factory_raw_stock   frs
  JOIN   factory_containers  fc  ON fc.id  = frs.container_id
  WHERE  frs.company_id = ${ctx.companyId}
    AND  fc.status     != 'DELETED'
    AND  frs.deleted_at IS NULL
    AND  fc.deleted_at IS NULL
  GROUP  BY fc.supplier_id, CASE WHEN fc.supplier_id IS NULL THEN fc.id ELSE NULL END
`);
  const rawRows = resultRows(rawResult);

  const adjResult = await db.execute(sql`
  SELECT supplier_id, type, kg::numeric AS kg, cost_per_kg::numeric AS cpk, material_label,
         UPPER(COALESCE(currency_code, 'USD')) AS currency
  FROM   factory_raw_material_adjustments
  WHERE  company_id = ${ctx.companyId}
    AND  deleted_at IS NULL
`);
  const adjRows = resultRows(adjResult);

  // Build per-supplier totals (same weighted-average logic as rawStockReceiptRoutes.ts)
  // cpkLocal = weighted avg of local-currency cost_per_kg (AUD/EUR/USD etc.)
  // cpkUsd   = weighted avg of cost_per_kg_usd (falls back to local when 0)
  // After a manual ADD adjustment on an existing supplier, rawStockReceiptRoutes sets
  // _avgCostPerKgUsd = _avgCostPerKg (the newly blended local rate). We mirror that here
  // so the net-position value matches the "Stock Value" shown on the Raw Materials page.
  type SupMap = {
    recv: Decimal;
    used: Decimal;
    cpkUsd: Decimal;
    cpkLocal: Decimal;
    remValLocal: Decimal;
    remValUsd: Decimal;
  };
  const supMap = new Map<string, SupMap>();
  for (const r of rawRows) {
    const key = r.supplier_id ? `s${r.supplier_id}` : `u-${r.unattached_container_id}`;
    const recv = col(r.total_recv);
    const used = col(r.total_used);
    const cpkLocal = col(r.avg_cpk_local);
    const cpkUsd = col(r.avg_cpk_usd);
    const remValLocal = col(r.remaining_value_local);
    const remValUsd = col(r.remaining_value_usd);
    supMap.set(key, { recv, used, cpkUsd, cpkLocal, remValLocal, remValUsd });
  }
  return { inventorySellValue, inventorySellingValue, reservedBaleCost, reservedBaleCount, rawRows, adjRows, supMap };
}
