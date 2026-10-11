import { sql } from "drizzle-orm";

import { db } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { factoryContainers } from "@shared/schema";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../../lib/money";

const ZERO = new MoneyDecimal(0);
/** A numeric column from a raw query row, exactly (missing or unparsable is zero). */
const col = (value: unknown) => toMoney(value as string | number | null | undefined);
/**
 * Rounded half up to the cent from the exact value. Rounding a binary float
 * instead sends a half-cent (999.995) either way depending on its binary
 * representation.
 */
const cents = (value: Decimal) => value.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP).toNumber();

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

export interface NetPositionInventory {
  /**
   * Legacy name retained for callers/tests: the bales at COST (SUM of
   * factory_bales.total_cost), reserved bales included.
   */
  inventorySellValue: number;
  /** Selling view: the catalogue selling price per bale of the same bales. */
  inventorySellingValue: number;
  rawMaterialStockValue: number;
  stockOtwValue: number;
  balanceOnTableValue: number;
  balanceOnTableSellingValue: number;
  /** Of `inventorySellValue`: the bales of unfinalized orders (count and cost). */
  reservedBaleCount: number;
  reservedBaleCost: number;
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

/**
 * Usage not tied to a specific container draws the supplier's remaining stock
 * down at that stock's current blended remaining cost/kg.
 */
function drawDown(stock: { recv: Decimal; used: Decimal; remValUsd: Decimal; remValLocal: Decimal }, kg: Decimal) {
  const remainingKgBefore = stock.recv.minus(stock.used);
  const avgCostUsdBefore = remainingKgBefore.gt(0) ? stock.remValUsd.div(remainingKgBefore) : ZERO;
  const avgCostLocalBefore = remainingKgBefore.gt(0) ? stock.remValLocal.div(remainingKgBefore) : ZERO;
  stock.used = stock.used.plus(kg);
  stock.remValUsd = stock.remValUsd.minus(kg.times(avgCostUsdBefore));
  stock.remValLocal = stock.remValLocal.minus(kg.times(avgCostLocalBefore));
}

export async function computeNetPositionInventory(ctx: NetPositionInventoryContext): Promise<NetPositionInventory> {
  // ── 3. Inventory (Stock In Hand) — bales at cost (wave 11) ─────────────────
  // Each bale at its recorded cost, factory_bales.total_cost: USD material cost
  // (services/factory/baleCostBasis.ts). It used to be SUM(production_price)
  // of the products, one catalogue price per bale. The selling view keeps the
  // catalogue selling price per bale.
  //
  // Stock is the bales the factory still holds:
  //   - IN_STOCK, RESERVED_FOR_ORDER and RESERVED_FOR_DISPATCH bales, and bales
  //     already marked SOLD on an unfinalized order (pending verification,
  //     verified, loading). Owner decision (wave 11): bales reserved for
  //     unfinalized orders are stock at cost; those orders are listed under
  //     `notInLedger` for information only, with no amount added anywhere;
  //   - never a "stale" IN_STOCK bale whose order was FINALIZED / DISPATCHED /
  //     SOLD (its status never got updated): its invoice took it.
  const invResult = await db.execute(sql`
  SELECT
    COALESCE(SUM(b.total_cost::numeric), 0) AS total_cost,
    COALESCE(SUM(p.selling_price::numeric), 0) AS total_selling,
    COALESCE(SUM(b.total_cost::numeric) FILTER (WHERE r.reserved), 0) AS reserved_cost,
    COUNT(*) FILTER (WHERE r.reserved) AS reserved_count
  FROM   factory_bales   b
  LEFT   JOIN factory_bale_products p ON p.id = b.product_id AND p.company_id = ${ctx.companyId}
  CROSS  JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1 FROM customer_order_bales cob
      INNER JOIN customer_orders co ON co.id = cob.order_id
      WHERE cob.bale_id = b.id
        AND co.status IN ('LOADING', 'PENDING_VERIFICATION', 'VERIFIED')
        AND co.company_id = ${ctx.companyId}
        AND co.deleted_at IS NULL
    ) AS reserved
  ) r
  WHERE  b.company_id = ${ctx.companyId}
    AND  b.deleted_at IS NULL
    AND  (b.status IN ('IN_STOCK', 'RESERVED_FOR_ORDER', 'RESERVED_FOR_DISPATCH') OR (b.status = 'SOLD' AND r.reserved))
    AND  NOT EXISTS (
      SELECT 1 FROM customer_order_bales cob
      INNER JOIN customer_orders co ON co.id = cob.order_id
      WHERE cob.bale_id = b.id
        AND co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD')
        AND co.company_id = ${ctx.companyId}
    )
`);
  const invRow = resultRows(invResult)[0] ?? {};
  const inventorySellValue = cents(col(invRow?.total_cost));
  const inventorySellingValue = cents(col(invRow?.total_selling));
  const reservedBaleCost = cents(col(invRow?.reserved_cost));
  const reservedBaleCount = Number(invRow?.reserved_count ?? 0);

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
  GROUP  BY fc.supplier_id
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
    const key = r.supplier_id ? `s${r.supplier_id}` : `u`;
    const recv = col(r.total_recv);
    const used = col(r.total_used);
    const cpkLocal = col(r.avg_cpk_local);
    const cpkUsd = col(r.avg_cpk_usd);
    const remValLocal = col(r.remaining_value_local);
    const remValUsd = col(r.remaining_value_usd);
    supMap.set(key, { recv, used, cpkUsd, cpkLocal, remValLocal, remValUsd });
  }
  for (const a of adjRows) {
    // DEDUCT is history-only — it already reduced received_kg on the underlying
    // factory_raw_stock row directly, so applying it again here (on top of the
    // already-reduced total_recv from rawResult above) would double-subtract it.
    // Mirrors the same skip in /api/factory/raw-stock (rawStockReceiptRoutes.ts).
    if (a.type === "DEDUCT") continue;
    // Manual (no-supplier) adjustments are kept separate per material label, matching
    // /api/factory/raw-stock's `MANUAL__${materialLabel}` bucket keying — collapsing them
    // into a single MANUAL bucket would incorrectly blend distinct materials' weighted costs.
    const key = a.supplier_id ? `s${a.supplier_id}` : `MANUAL__${a.material_label || "unknown"}`;
    const kg = col(a.kg);
    // An adjustment's cost per kg is in its own currency; only a USD one is a
    // USD value (wave 11: never a native-currency value).
    const cpk = a.currency === "USD" ? col(a.cpk) : ZERO;
    const isAdd = a.type === "ADD";
    const ex = supMap.get(key);
    if (ex) {
      if (isAdd) {
        // Mirror rawStockReceiptRoutes: new stock's full value joins the remaining-value
        // pool directly (manual adjustments have no separate USD leg, so local and USD
        // move together); the received-weighted rate also shifts, same as a new container.
        const prevLocalVal = ex.recv.times(ex.cpkLocal);
        ex.recv = ex.recv.plus(kg);
        ex.cpkLocal = ex.recv.gt(0) ? prevLocalVal.plus(kg.times(cpk)).div(ex.recv) : ZERO;
        ex.cpkUsd = ex.cpkLocal;
        ex.remValLocal = ex.remValLocal.plus(kg.times(cpk));
        ex.remValUsd = ex.remValUsd.plus(kg.times(cpk));
      } else {
        // Manual usage isn't tied to a specific container/source, so it draws down the
        // supplier's remaining stock at that stock's current blended remaining cost/kg —
        // mirrors rawStockReceiptRoutes.ts's avgCostBefore/avgCostLocalBefore depletion.
        drawDown(ex, kg);
      }
    } else if (isAdd) {
      supMap.set(key, {
        recv: kg,
        used: ZERO,
        cpkUsd: cpk,
        cpkLocal: cpk,
        remValLocal: kg.times(cpk),
        remValUsd: kg.times(cpk),
      });
    }
  }

  // MANUAL-only suppliers (no factoryRawStock container rows) never get usedKg
  // incremented anywhere else — consumption only happens via factoryMixBatchSources
  // when a batch is completed. Without this step their `used` stays 0 forever, so
  // remaining/value stays overstated relative to /api/factory/raw-stock, which
  // applies this same correction (see rawStockReceiptRoutes.ts "completedBatchRows").
  const supplierKeysWithContainerStock = new Set<string>();
  for (const r of rawRows) {
    if (r.supplier_id) supplierKeysWithContainerStock.add(`s${r.supplier_id}`);
  }
  const completedBatchResult = await db.execute(sql`
  SELECT fms.supplier_id, SUM(fms.weight_kg::numeric) AS consumed_kg
  FROM   factory_mix_batch_sources fms
  JOIN   factory_mix_batches fmb ON fmb.id = fms.mix_batch_id
  WHERE  fmb.company_id = ${ctx.companyId}
    AND  fms.supplier_id IS NOT NULL
    AND  fmb.status IN ('CLOSED', 'COMPLETED')
  GROUP  BY fms.supplier_id
`);
  const completedBatchRows = resultRows(completedBatchResult);
  for (const r of completedBatchRows) {
    if (!r.supplier_id) continue;
    const key = `s${r.supplier_id}`;
    if (supplierKeysWithContainerStock.has(key)) continue; // container stock already tracks used via total_used
    const ex = supMap.get(key);
    if (!ex) continue;
    // Mirrors rawStockReceiptRoutes.ts: draw down at the current blended remaining
    // cost/kg (the best available attribution without a specific source container).
    drawDown(ex, col(r.consumed_kg));
  }

  // Subtract kg reserved in open (not yet CLOSED/COMPLETED) mix batches —
  // mirrors the freeKg = remainingKg − reservedKg logic in rawStockReceiptRoutes.ts.
  // This aligns the net-position "Factory Raw Material Stock" value with the
  // "FREE AVAILABLE → Stock Value" figure shown on the Raw Materials page.
  const openReservedResult = await db.execute(sql`
  SELECT fms.supplier_id, SUM(fms.weight_kg::numeric) AS reserved_kg
  FROM   factory_mix_batch_sources fms
  JOIN   factory_mix_batches fmb ON fmb.id = fms.mix_batch_id
  WHERE  fmb.company_id = ${ctx.companyId}
    AND  fms.supplier_id IS NOT NULL
    AND  fmb.status NOT IN ('CLOSED', 'COMPLETED')
  GROUP  BY fms.supplier_id
`);
  const openReservedRows = resultRows(openReservedResult);
  const reservedBySupKey = new Map<string, Decimal>();
  for (const r of openReservedRows) {
    if (r.supplier_id) reservedBySupKey.set(`s${r.supplier_id}`, col(r.reserved_kg));
  }

  // Sum each supplier's stock value the SAME way rawStockReceiptRoutes.ts computes
  // "Stock Value" on the Raw Materials page: for a real supplier with a locked rate,
  // value = remainingKg × lockedRateUsd (the spec-mandated formula — the locked rate
  // supersedes whatever blended/tracked cost basis this supplier's receipts drifted to
  // over time). Only MANUAL/standalone materials (no supplierId, key "u") have no
  // locked rate — those keep the tracked remaining-value basis (remValUsd), since that
  // page-side formula only applies to real suppliers too.
  // (Reserved kg still have physical value in the warehouse; they are subtracted from the
  // displayed kg count but not from the dollar value, matching the raw-materials KPI.)
  let rawTotal: Decimal = ZERO;
  for (const [key, s] of supMap.entries()) {
    const supplierId = key.startsWith("s") ? parseInt(key.slice(1)) : null;
    const lockedRate = supplierId !== null ? ctx.supplierLockedRateMapNp.get(supplierId) : undefined;
    if (lockedRate !== undefined) {
      rawTotal = rawTotal.plus(s.recv.minus(s.used).times(lockedRate));
    } else {
      rawTotal = rawTotal.plus(s.remValUsd);
    }
  }
  const rawMaterialStockValue = cents(rawTotal);

  // ── 3b. Factory Stock OTW — containers in transit (PENDING / IN_TRANSIT / ARRIVED) ──
  // Per-currency goods+freight+commission+other charges, converted to USD using the
  // user-configured manual FX rates loaded above (ctx.getConfigFx / ctx.configFxRates — set in
  // Settings → FX Rates, e.g. EUR=1.18, AUD=0.75). This was previously hardcoded
  // (EUR×1.17, AUD×0.75), which drifted from the user's actual configured rates and
  // produced a wrong OTW total on this page.
  const otwStatuses = new Set(["PENDING", "IN_TRANSIT", "ARRIVED"]);
  const otwCurrBuckets: Record<string, Decimal> = {};
  const otwAdd = (cc: string, amt: Decimal) => {
    if (amt.gt(0) && cc) otwCurrBuckets[cc] = (otwCurrBuckets[cc] ?? ZERO).plus(amt);
  };
  for (const c of ctx.allContainersF) {
    if (!c.status || !otwStatuses.has(c.status)) continue;
    const containerCcy = c.currencyCode || "USD";
    const finalPayable = col(c.finalPayableAmount);
    const goods = finalPayable.gt(0) ? finalPayable : col(c.ratePerKg).times(col(c.totalKg));
    otwAdd(containerCcy, goods);
    const freightCcy = c.freightCurrencyCode || containerCcy;
    otwAdd(freightCcy, col(c.freight));
    const commCcy = c.commissionCurrencyCode || "USD";
    otwAdd(commCcy, col(c.commissionAmount));
    otwAdd(containerCcy, col(c.otherCharges));
  }
  const stockOtwValue = cents(
    Object.entries(otwCurrBuckets).reduce(
      (sum: Decimal, [cc, amt]) => sum.plus(amt.times(cc === "USD" ? 1 : ctx.getConfigFx(cc))),
      ZERO
    )
  );

  // ── 3c. Balance on Table — material in process (mix batch input minus bale output) ──
  // Mirrors the production-value-report formula: all-time totals, no date filter.
  // Must exclude soft-deleted batches and carry-forward rows exactly like
  // factoryBaleExportRoutes.ts does, or a deleted batch keeps inflating this figure
  // (its total_weight_kg/total_cost still get summed even though the batch no longer
  // exists from the user's point of view) and Net Position stops matching the
  // Production report's Balance on Table card.
  const mixSumResult = await db.execute(sql`
  SELECT
    COALESCE(SUM(total_weight_kg::numeric), 0) AS total_mix_kg,
    COALESCE(SUM(total_cost::numeric),      0) AS total_mix_cost
  FROM factory_mix_batches
  WHERE company_id = ${ctx.companyId}
    AND carry_forward_from_id IS NULL
    AND deleted_at IS NULL
`);
  const mixSumRow = resultRows(mixSumResult)[0] ?? {};
  const totalMixKg = col(mixSumRow.total_mix_kg);
  const totalMixCost = col(mixSumRow.total_mix_cost);
  const blendedCpk = totalMixKg.gt(0) ? totalMixCost.div(totalMixKg) : ZERO;

  // Split bales: wipers/garbage (by category name) vs regular
  const baleSumResult = await db.execute(sql`
  SELECT
    COALESCE(SUM(b.weight_kg::numeric), 0)                                          AS total_kg,
    COALESCE(SUM(p.selling_price::numeric), 0)                                      AS total_selling_value,
    COALESCE(SUM(CASE WHEN lower(c.name) ~ '(wiper|garbage|rag)'
                      THEN b.weight_kg::numeric ELSE 0 END), 0)                     AS wg_kg
  FROM   factory_bales        b
  LEFT   JOIN factory_bale_products  p ON p.id = b.product_id
  LEFT   JOIN factory_categories     c ON c.id = p.category_id
  WHERE  b.company_id = ${ctx.companyId}
    AND  b.status NOT IN ('DELETED', 'REMOVED')
`);
  const baleSumRow = resultRows(baleSumResult)[0] ?? {};
  const totalBaleKg = col(baleSumRow.total_kg);
  const totalSellingValue = col(baleSumRow.total_selling_value);

  const botWeightKg = MoneyDecimal.max(totalMixKg.minus(totalBaleKg), 0);
  const balanceOnTableValue = cents(botWeightKg.times(blendedCpk));
  // Selling valuation uses the realized configured selling value per kg of produced
  // bales as the best like-for-like valuation for material still on the table.
  // If no produced-bale selling basis exists yet, fall back to cost rather than
  // inventing a markup.
  const blendedSellingPerKg = totalBaleKg.gt(0) ? totalSellingValue.div(totalBaleKg) : ZERO;
  const balanceOnTableSellingValue = blendedSellingPerKg.gt(0)
    ? cents(botWeightKg.times(blendedSellingPerKg))
    : balanceOnTableValue;

  return {
    inventorySellValue,
    inventorySellingValue,
    rawMaterialStockValue,
    stockOtwValue,
    balanceOnTableValue,
    balanceOnTableSellingValue,
    reservedBaleCount,
    reservedBaleCost,
  };
}
