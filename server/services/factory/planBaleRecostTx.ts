// Extracted from ./baleRecost.ts to keep that module under the source-size cap.
import crypto from "node:crypto";
import type Decimal from "decimal.js";
import type { DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { isPerpetualInventoryActive } from "../accounting/perpetualInventory/cutover";
import {
  baleCostFromMix,
  containerUsdRate,
  FACTORY_COST_SCALE,
  rawSourceUsdRate,
  stockEntryBaleCost,
} from "./baleCostBasis";
import { resolveMixSourcePricingBasis } from "./mixSourcePricingBasis";
import { fixed, type BaleRecostPlan, type RecostBaleLine, type RecostMixLine } from "./baleRecostTypes";
import { planBaleRecostTxPart1 } from "./planBaleRecostTxPart1";

/** The plan, computed inside `tx` (read-only). */
export async function planBaleRecostTx(tx: DbTransaction, companyId: number): Promise<BaleRecostPlan> {
  const { date, unvalued, bales, openMixes, mixIds, mixById, sourcesByMix, loadMixes, mixRate } =
    await planBaleRecostTxPart1(tx, companyId);
  const sourceRate = new Map<number, Decimal | null>();
  const rateOf = async (mixId: number, depth: number): Promise<Decimal | null> => {
    if (mixRate.has(mixId)) return mixRate.get(mixId)!;
    if (depth > 8) return null;
    await loadMixes([mixId]);
    const sources = sourcesByMix.get(mixId);
    if (!mixById.has(mixId) || !sources || sources.length === 0) {
      mixRate.set(mixId, null);
      return null;
    }
    mixRate.set(mixId, null); // a cycle resolves to "no rate"
    let weight: Decimal = new MoneyDecimal(0);
    let cost: Decimal = new MoneyDecimal(0);
    let priced = true;
    for (const source of sources) {
      const basis = resolveMixSourcePricingBasis({
        sourceBatchId: source.source_batch_id,
        supplierId: source.supplier_id,
        containerId: source.container_id,
      });
      let rate: Decimal | null = null;
      if (basis === "BATCH") rate = await rateOf(source.source_batch_id!, depth + 1);
      else if (basis === "SUPPLIER_LOCKED_RATE") {
        rate =
          (await rawSourceUsdRate(tx, companyId, { supplierId: source.supplier_id, containerId: source.container_id }))
            ?.rate ?? null;
      } else if (basis === "CONTAINER_DIRECT") rate = await containerUsdRate(tx, companyId, source.container_id!);
      sourceRate.set(source.id, rate);
      weight = weight.plus(toMoney(source.weight_kg));
      if (rate === null) priced = false;
      else cost = cost.plus(toMoney(source.weight_kg).times(rate));
    }
    const result = priced && weight.gt(0) ? cost.dividedBy(weight).toDecimalPlaces(FACTORY_COST_SCALE) : null;
    mixRate.set(mixId, result);
    return result;
  };

  const mixes: RecostMixLine[] = [];
  let wipChange: Decimal = new MoneyDecimal(0);
  const openIds = new Set(openMixes.map((mix) => mix.id));
  for (const mixId of [...mixIds].sort((a, b) => a - b)) {
    const mix = mixById.get(mixId);
    if (!mix) continue;
    const rate = await rateOf(mixId, 0);
    if (rate === null) {
      unvalued.push({ source: "factory_mix_batches", id: mixId, reason: "a source has no USD rate" });
      continue;
    }
    const sources = (sourcesByMix.get(mixId) ?? []).map((source) => {
      const newRate = sourceRate.get(source.id)!;
      return {
        id: source.id,
        oldCostPerKg: fixed(toMoney(source.cost_per_kg)),
        newCostPerKg: fixed(newRate),
        newTotalCost: fixed(toMoney(source.weight_kg).times(newRate)),
      };
    });
    const oldRate = toMoney(mix.cost_per_kg);
    const sourcesChange = sources.some((source) => source.oldCostPerKg !== source.newCostPerKg);
    if (fixed(oldRate) === fixed(rate) && !sourcesChange) continue;
    const wipKg = openIds.has(mixId) ? toMoney(mix.total_weight_kg).minus(toMoney(mix.used_kg)) : new MoneyDecimal(0);
    const change = wipKg.times(rate).minus(wipKg.times(oldRate));
    wipChange = wipChange.plus(change);
    mixes.push({
      id: mixId,
      batchCode: mix.batch_code,
      status: mix.status,
      wipKg: wipKg.toFixed(3),
      oldCostPerKg: fixed(oldRate),
      newCostPerKg: fixed(rate),
      oldTotalCost: fixed(toMoney(mix.total_cost)),
      newTotalCost: fixed(sources.reduce((sum, source) => sum.plus(source.newTotalCost), new MoneyDecimal(0))),
      wipChange: change.toFixed(2),
      sources,
    });
  }

  const baleLines: RecostBaleLine[] = [];
  let finishedChange: Decimal = new MoneyDecimal(0);
  for (const bale of bales) {
    let next: { costPerKg: Decimal; totalCost: Decimal };
    let basis: RecostBaleLine["basis"] = "mix";
    if (bale.mix_batch_id !== null) {
      const rate = mixRate.get(bale.mix_batch_id) ?? null;
      if (rate === null) {
        unvalued.push({ source: "factory_bales", id: bale.id, reason: "its mix has no USD cost" });
        continue;
      }
      next = baleCostFromMix(bale.weight_kg, rate);
    } else {
      basis = "production-price";
      if (!bale.has_product) continue; // no catalogue product: the bale keeps its recorded cost
      if (bale.production_price === null && !bale.article_code?.startsWith("HMD16")) {
        if (!toMoney(bale.total_cost).gt(0)) {
          unvalued.push({ source: "factory_bales", id: bale.id, reason: "its product has no production price" });
        }
        continue;
      }
      next = stockEntryBaleCost(bale.production_price, bale.weight_kg, bale.article_code);
    }
    const oldTotal = toMoney(bale.total_cost);
    if (fixed(oldTotal) === fixed(next.totalCost) && fixed(toMoney(bale.cost_per_kg)) === fixed(next.costPerKg)) {
      continue;
    }
    const change = next.totalCost.minus(oldTotal);
    finishedChange = finishedChange.plus(change);
    baleLines.push({
      id: bale.id,
      referenceNumber: bale.reference_number,
      status: bale.status,
      eligibility: bale.status === "SOLD" ? "sold-on-uninvoiced-verified-order" : "unsold-stock",
      mixBatchId: bale.mix_batch_id,
      weightKg: toMoney(bale.weight_kg).toFixed(3),
      basis,
      oldCostPerKg: fixed(toMoney(bale.cost_per_kg)),
      newCostPerKg: fixed(next.costPerKg),
      oldTotalCost: fixed(oldTotal),
      newTotalCost: fixed(next.totalCost),
      change: change.toFixed(2),
    });
  }

  const totals = {
    wipChange: wipChange.toDecimalPlaces(2).toFixed(2),
    finishedChange: finishedChange.toDecimalPlaces(2).toFixed(2),
    total: wipChange.toDecimalPlaces(2).plus(finishedChange.toDecimalPlaces(2)).toFixed(2),
  };
  const planHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ companyId, mixes, bales: baleLines, unvalued, totals }))
    .digest("hex");
  return {
    companyId,
    date,
    perpetual: await isPerpetualInventoryActive(tx, companyId, date),
    mixes,
    bales: baleLines,
    unvalued,
    totals,
    planHash,
  };
}
