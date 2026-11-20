import { sql } from "drizzle-orm";

import { db } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getFactoryBalanceOnTableSnapshot } from "../../../services/factory/productionBalanceOnTable";
import { getLockedSupplierRatesReadOnlyBulk } from "../../../services/factory/rawStockLockedRateBulk";
import {
  computeNetPositionInventoryPart1,
  col,
  cents,
  type NetPositionInventoryContext,
} from "./computeNetPositionInventoryPart1";
export type { NetPositionInventoryContext } from "./computeNetPositionInventoryPart1";

const ZERO = new MoneyDecimal(0);

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
  const { inventorySellValue, inventorySellingValue, reservedBaleCost, reservedBaleCount, rawRows, adjRows, supMap } =
    await computeNetPositionInventoryPart1(ctx);
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

  // Kg reserved in open (not yet CLOSED/COMPLETED) mix batches is NOT
  // subtracted: until a batch closes and consumption is recorded, that raw
  // material is still owned stock and stays in the net-position value.
  // (Owner-confirmed; an earlier comment here wrongly said it was subtracted.)

  // /api/factory/raw-stock serializes each supplier/material row to cents
  // AFTER rounding freeKg to three decimals. The Raw Materials page sums those
  // displayed row values; rounding one grand total can differ by $0.01+.
  // Mirror the source row boundaries instead of re-rounding the sum.
  const missingSupplierRateIds = [...supMap.keys()]
    .filter((key) => key.startsWith("s"))
    .map((key) => Number(key.slice(1)))
    .filter((id) => Number.isInteger(id) && !ctx.supplierLockedRateMapNp.has(id));
  // The Raw Materials page also resolves legacy NULL locked rates instead of
  // falling back to a different receipt-derived net-position valuation.
  const legacyRates = missingSupplierRateIds.length
    ? await getLockedSupplierRatesReadOnlyBulk(db, ctx.companyId, missingSupplierRateIds)
    : new Map<number, number>();

  let rawTotal: Decimal = ZERO;
  for (const [key, stock] of supMap.entries()) {
    const supplierId = key.startsWith("s") ? Number(key.slice(1)) : null;
    const lockedRate =
      supplierId !== null
        ? toMoney(ctx.supplierLockedRateMapNp.get(supplierId) ?? legacyRates.get(supplierId) ?? 0)
        : null;
    const rowValue =
      lockedRate !== null ? toMoney(stock.recv.minus(stock.used).toFixed(3)).times(lockedRate) : stock.remValUsd;
    rawTotal = rawTotal.plus(rowValue.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP));
  }
  const rawMaterialStockValue = rawTotal.toNumber();

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

  // Authoritative Production Overview → Balance on Table (historical as-of,
  // excludes REPACKED bales, uses the cumulative 10dp batch rate).
  const balanceSnapshot = await getFactoryBalanceOnTableSnapshot(ctx.companyId, ctx.asOf);
  const balanceOnTableValue = balanceSnapshot.value;

  // Legacy selling-price valuation field, retained for existing consumers.
  // Factory Net Position itself always shows the COST Balance on Table.
  const baleSellingResult = await db.execute(sql`
    SELECT COALESCE(SUM(p.selling_price::numeric), 0) AS total_selling_value
    FROM factory_bales b
    LEFT JOIN factory_bale_products p ON p.id = b.product_id
    WHERE b.company_id = ${ctx.companyId}
      AND b.status NOT IN ('DELETED', 'REMOVED', 'REPACKED')
      AND COALESCE(DATE(b.stock_entry_date), DATE(b.created_at)) <= ${ctx.asOf}
  `);
  const totalSellingValue = col((resultRows(baleSellingResult)[0] ?? {}).total_selling_value);
  const baleWeightKg = toMoney(balanceSnapshot.baleWeightKg);
  const blendedSellingPerKg = baleWeightKg.gt(0) ? totalSellingValue.div(baleWeightKg) : ZERO;
  const balanceOnTableSellingValue = blendedSellingPerKg.gt(0)
    ? cents(toMoney(balanceSnapshot.weightKg).times(blendedSellingPerKg))
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
