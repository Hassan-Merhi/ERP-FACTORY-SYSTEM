import { sql } from "drizzle-orm";

import { db } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { factoryContainers } from "@shared/schema";

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
  round2: (n: number) => number;
  getConfigFx: (cc: string) => number;
  configFxRates: Record<string, number>;
  supplierLockedRateMapNp: Map<number, number>;
  allContainersF: (typeof factoryContainers.$inferSelect)[];
}

export interface NetPositionInventory {
  inventorySellValue: number;
  rawMaterialStockValue: number;
  stockOtwValue: number;
  balanceOnTableValue: number;
}

export async function computeNetPositionInventory(ctx: NetPositionInventoryContext): Promise<NetPositionInventory> {
  // ── 3. Inventory (Stock In Hand) — direct SQL sum of production price ──────
  // Single query: sum production_price for every IN_STOCK bale that has a
  // matched product, scoped strictly to ctx.companyId.
  // Production price (cost to manufacture) is used here, not selling price.
  //
  // Must exclude "stale" IN_STOCK bales — bales still marked IN_STOCK in the
  // DB but whose order was actually FINALIZED/DISPATCHED/SOLD (status never
  // got updated). Location Inventory and Bale Ledger already exclude these;
  // without the same exclusion here, Stock In Hand is inflated and drifts
  // out of sync with what Location Inventory shows.
  //
  // Must ALSO exclude bales tied to an order that's currently LOADING /
  // PENDING_VERIFICATION / VERIFIED. Location Inventory's Cost Value KPI
  // subtracts these ("loadingCount") from its total, and they're already
  // counted separately here as "Loading Orders" / "Verified Orders" /
  // "Pending Orders" receivables — leaving them in Stock In Hand as well
  // double-counts them.
  const invResult = await db.execute(sql`
  SELECT COALESCE(SUM(p.production_price::numeric), 0) AS total
  FROM   factory_bales   b
  JOIN   factory_bale_products p ON p.id = b.product_id
  WHERE  b.company_id = ${ctx.companyId}
    AND  b.status     = 'IN_STOCK'
    AND  p.company_id = ${ctx.companyId}
    AND  NOT EXISTS (
      SELECT 1 FROM customer_order_bales cob
      INNER JOIN customer_orders co ON co.id = cob.order_id
      WHERE cob.bale_id = b.id
        AND co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD')
        AND co.company_id = ${ctx.companyId}
    )
    AND  NOT EXISTS (
      SELECT 1 FROM customer_order_bales cob
      INNER JOIN customer_orders co ON co.id = cob.order_id
      WHERE cob.bale_id = b.id
        AND co.status IN ('LOADING', 'PENDING_VERIFICATION', 'VERIFIED')
        AND co.company_id = ${ctx.companyId}
    )
`);
  const invRow = resultRows(invResult)[0] ?? {};
  const inventorySellValue = ctx.round2(parseFloat(String(invRow?.total ?? "0")));

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
    -- USD cost per kg (falls back to local when cost_per_kg_usd is zero/null)
    SUM(frs.received_kg::numeric *
        COALESCE(NULLIF(frs.cost_per_kg_usd::numeric, 0), frs.cost_per_kg::numeric, 0))
      / NULLIF(SUM(frs.received_kg::numeric), 0)                             AS avg_cpk_usd,
    -- Per-row remaining cost basis, summed — mirrors rawStockReceiptRoutes.ts's
    -- rowRemainingValueLocal/rowRemainingValueUsd accumulation exactly.
    SUM((frs.received_kg::numeric - frs.used_kg::numeric) * frs.cost_per_kg::numeric)
                                                                               AS remaining_value_local,
    SUM((frs.received_kg::numeric - frs.used_kg::numeric) *
        COALESCE(NULLIF(frs.cost_per_kg_usd::numeric, 0), frs.cost_per_kg::numeric, 0))
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
  SELECT supplier_id, type, kg::numeric AS kg, cost_per_kg::numeric AS cpk, material_label
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
    recv: number;
    used: number;
    cpkUsd: number;
    cpkLocal: number;
    remValLocal: number;
    remValUsd: number;
  };
  const supMap = new Map<string, SupMap>();
  for (const r of rawRows) {
    const key = r.supplier_id ? `s${r.supplier_id}` : `u`;
    const recv = parseFloat(String(r.total_recv ?? "0")) || 0;
    const used = parseFloat(String(r.total_used ?? "0")) || 0;
    const cpkLocal = parseFloat(String(r.avg_cpk_local ?? "0")) || 0;
    const cpkUsd = parseFloat(String(r.avg_cpk_usd ?? "0")) || 0;
    const remValLocal = parseFloat(String(r.remaining_value_local ?? "0")) || 0;
    const remValUsd = parseFloat(String(r.remaining_value_usd ?? "0")) || 0;
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
    const kg = parseFloat(String(a.kg ?? "0")) || 0;
    const cpk = parseFloat(String(a.cpk ?? "0")) || 0;
    const isAdd = a.type === "ADD";
    const ex = supMap.get(key);
    if (ex) {
      if (isAdd) {
        // Mirror rawStockReceiptRoutes: new stock's full value joins the remaining-value
        // pool directly (manual adjustments have no separate USD leg, so local and USD
        // move together); the received-weighted rate also shifts, same as a new container.
        const prevLocalVal = ex.recv * ex.cpkLocal;
        ex.recv += kg;
        ex.cpkLocal = ex.recv > 0 ? (prevLocalVal + kg * cpk) / ex.recv : 0;
        ex.cpkUsd = ex.cpkLocal;
        ex.remValLocal += kg * cpk;
        ex.remValUsd += kg * cpk;
      } else {
        // Manual usage isn't tied to a specific container/source, so it draws down the
        // supplier's remaining stock at that stock's current blended remaining cost/kg —
        // mirrors rawStockReceiptRoutes.ts's avgCostBefore/avgCostLocalBefore depletion.
        const remainingKgBefore = ex.recv - ex.used;
        const avgCostUsdBefore = remainingKgBefore > 0 ? ex.remValUsd / remainingKgBefore : 0;
        const avgCostLocalBefore = remainingKgBefore > 0 ? ex.remValLocal / remainingKgBefore : 0;
        ex.used += kg;
        ex.remValUsd -= kg * avgCostUsdBefore;
        ex.remValLocal -= kg * avgCostLocalBefore;
      }
    } else if (isAdd) {
      supMap.set(key, {
        recv: kg,
        used: 0,
        cpkUsd: cpk,
        cpkLocal: cpk,
        remValLocal: kg * cpk,
        remValUsd: kg * cpk,
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
    const consumed = parseFloat(String(r.consumed_kg ?? "0")) || 0;
    // Mirrors rawStockReceiptRoutes.ts: draw down at the current blended remaining
    // cost/kg (the best available attribution without a specific source container).
    const remainingKgBefore = ex.recv - ex.used;
    const avgCostUsdBefore = remainingKgBefore > 0 ? ex.remValUsd / remainingKgBefore : 0;
    const avgCostLocalBefore = remainingKgBefore > 0 ? ex.remValLocal / remainingKgBefore : 0;
    ex.used += consumed;
    ex.remValUsd -= consumed * avgCostUsdBefore;
    ex.remValLocal -= consumed * avgCostLocalBefore;
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
  const reservedBySupKey = new Map<string, number>();
  for (const r of openReservedRows) {
    if (r.supplier_id) reservedBySupKey.set(`s${r.supplier_id}`, parseFloat(String(r.reserved_kg ?? "0")) || 0);
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
  let rawTotal = 0;
  for (const [key, s] of supMap.entries()) {
    const supplierId = key.startsWith("s") ? parseInt(key.slice(1)) : null;
    const lockedRate = supplierId !== null ? ctx.supplierLockedRateMapNp.get(supplierId) : undefined;
    if (lockedRate !== undefined) {
      const remainingKg = s.recv - s.used;
      rawTotal += remainingKg * lockedRate;
    } else {
      rawTotal += s.remValUsd;
    }
  }
  const rawMaterialStockValue = ctx.round2(rawTotal);

  // ── 3b. Factory Stock OTW — containers in transit (PENDING / IN_TRANSIT / ARRIVED) ──
  // Per-currency goods+freight+commission+other charges, converted to USD using the
  // user-configured manual FX rates loaded above (ctx.getConfigFx / ctx.configFxRates — set in
  // Settings → FX Rates, e.g. EUR=1.18, AUD=0.75). This was previously hardcoded
  // (EUR×1.17, AUD×0.75), which drifted from the user's actual configured rates and
  // produced a wrong OTW total on this page.
  const otwStatuses = new Set(["PENDING", "IN_TRANSIT", "ARRIVED"]);
  const otwCurrBuckets: Record<string, number> = {};
  const otwAdd = (cc: string, amt: number) => {
    if (amt > 0 && cc) otwCurrBuckets[cc] = (otwCurrBuckets[cc] || 0) + amt;
  };
  for (const c of ctx.allContainersF) {
    if (!c.status || !otwStatuses.has(c.status)) continue;
    const containerCcy = c.currencyCode || "USD";
    const goods =
      parseFloat(c.finalPayableAmount || "0") > 0
        ? parseFloat(c.finalPayableAmount || "0")
        : parseFloat(c.ratePerKg || "0") * parseFloat(c.totalKg || "0");
    otwAdd(containerCcy, goods);
    const freightCcy = c.freightCurrencyCode || containerCcy;
    otwAdd(freightCcy, parseFloat(c.freight || "0"));
    const commCcy = c.commissionCurrencyCode || "USD";
    otwAdd(commCcy, parseFloat(c.commissionAmount || "0"));
    otwAdd(containerCcy, parseFloat(c.otherCharges || "0"));
  }
  const stockOtwValue = ctx.round2(
    Object.entries(otwCurrBuckets).reduce((sum, [cc, amt]) => {
      const fx = cc === "USD" ? 1 : ctx.getConfigFx(cc);
      return sum + amt * fx;
    }, 0)
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
  const totalMixKg = parseFloat(String(mixSumRow.total_mix_kg ?? "0")) || 0;
  const totalMixCost = parseFloat(String(mixSumRow.total_mix_cost ?? "0")) || 0;
  const blendedCpk = totalMixKg > 0 ? totalMixCost / totalMixKg : 0;

  // Split bales: wipers/garbage (by category name) vs regular
  const baleSumResult = await db.execute(sql`
  SELECT
    COALESCE(SUM(b.weight_kg::numeric), 0)                                          AS total_kg,
    COALESCE(SUM(CASE WHEN lower(c.name) ~ '(wiper|garbage|rag)'
                      THEN b.weight_kg::numeric ELSE 0 END), 0)                     AS wg_kg
  FROM   factory_bales        b
  LEFT   JOIN factory_bale_products  p ON p.id = b.product_id
  LEFT   JOIN factory_categories     c ON c.id = p.category_id
  WHERE  b.company_id = ${ctx.companyId}
    AND  b.status NOT IN ('DELETED', 'REMOVED')
`);
  const baleSumRow = resultRows(baleSumResult)[0] ?? {};
  const totalBaleKg = parseFloat(String(baleSumRow.total_kg ?? "0")) || 0;
  const _totalWgKg = parseFloat(String(baleSumRow.wg_kg ?? "0")) || 0;

  const botWeightKg = totalMixKg - totalBaleKg;
  const balanceOnTableValue = ctx.round2(Math.max(botWeightKg, 0) * blendedCpk);
  return { inventorySellValue, rawMaterialStockValue, stockOtwValue, balanceOnTableValue };
}
