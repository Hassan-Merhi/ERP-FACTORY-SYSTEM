// Extracted from ./baleRecost.ts to keep that module under the source-size cap.
import crypto from "node:crypto";
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";
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
import {
  fixed,
  rows,
  todayUtc,
  type BaleRecostPlan,
  type MixRow,
  type RecostBaleLine,
  type RecostMixLine,
  type RecostUnvalued,
  type SourceRow,
} from "./baleRecostTypes";

/** The plan, computed inside `tx` (read-only). */
export async function planBaleRecostTx(tx: DbTransaction, companyId: number): Promise<BaleRecostPlan> {
  const date = todayUtc();
  const unvalued: RecostUnvalued[] = [];

  const bales = await rows<{
    id: number;
    reference_number: string;
    status: string;
    mix_batch_id: number | null;
    weight_kg: string;
    cost_per_kg: string;
    total_cost: string;
    article_code: string | null;
    production_price: string | null;
    has_product: boolean;
  }>(
    tx,
    sql`
      SELECT b.id, b.reference_number, b.status, b.mix_batch_id, b.weight_kg::text AS weight_kg,
             b.cost_per_kg::text AS cost_per_kg, b.total_cost::text AS total_cost, b.article_code,
             p.production_price::text AS production_price, (p.id IS NOT NULL) AS has_product
        FROM factory_bales b
        LEFT JOIN factory_bale_products p ON p.id = b.product_id AND p.company_id = ${companyId}
       WHERE b.company_id = ${companyId} AND b.deleted_at IS NULL
         AND (
           b.status IN ('IN_STOCK', 'RESERVED_FOR_ORDER', 'RESERVED_FOR_DISPATCH')
           OR (b.status = 'SOLD'
             -- Some legacy verification flows mark bales SOLD before the
             -- invoice exists. Those bales remain in factory finished goods.
             AND EXISTS (
               SELECT 1 FROM customer_order_bales open_cob
                 JOIN customer_orders open_co ON open_co.id = open_cob.order_id
                WHERE open_cob.bale_id = b.id
                  AND open_co.company_id = ${companyId}
                  AND open_co.deleted_at IS NULL
                  AND open_co.status = 'VERIFIED'
                  AND open_co.invoice_number IS NULL
                  AND open_co.finalized_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM factory_invoice_document_snapshots ds
                     WHERE ds.company_id = ${companyId} AND ds.order_id = open_co.id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM customer_balances cb
                     WHERE cb.company_id = ${companyId}
                       AND cb.reference_type = 'INVOICE'
                       AND cb.reference_id = open_co.id
                       AND cb.transaction_type = 'SALE'
                  )
             )
             AND NOT EXISTS (
               SELECT 1 FROM factory_pos_sale_bales psb
                WHERE psb.company_id = ${companyId} AND psb.bale_id = b.id
             )
           )
         )
         -- Never recost a bale on any invoiced, completed, or marked-finalized
         -- order, even if the order was subsequently moved back to VERIFIED.
         AND NOT EXISTS (
           SELECT 1 FROM customer_order_bales cob
             JOIN customer_orders co ON co.id = cob.order_id
            WHERE cob.bale_id = b.id AND co.company_id = ${companyId}
              AND co.deleted_at IS NULL
              AND (co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD', 'INVOICED', 'COMPLETED')
                   OR co.invoice_number IS NOT NULL OR co.finalized_at IS NOT NULL
                   OR EXISTS (
                     SELECT 1 FROM factory_invoice_document_snapshots ds
                      WHERE ds.company_id = ${companyId} AND ds.order_id = co.id
                   )
                   -- A SALE ledger entry on any linked order is invoice evidence
                   -- too, even when the order row itself still reads VERIFIED.
                   OR EXISTS (
                     SELECT 1 FROM customer_balances cb
                      WHERE cb.company_id = ${companyId}
                        AND cb.reference_type = 'INVOICE'
                        AND cb.reference_id = co.id
                        AND cb.transaction_type = 'SALE'
                   ))
         )
       ORDER BY b.id
    `
  );

  const openMixes = await rows<MixRow>(
    tx,
    sql`
      SELECT id, batch_code, status, total_weight_kg::text AS total_weight_kg, used_kg::text AS used_kg,
             cost_per_kg::text AS cost_per_kg, total_cost::text AS total_cost
        FROM factory_mix_batches
       WHERE company_id = ${companyId} AND deleted_at IS NULL AND status <> 'CLOSED'
         AND total_weight_kg - used_kg > 0
    `
  );
  const mixIds = new Set<number>([
    ...openMixes.map((mix) => mix.id),
    ...bales.map((bale) => bale.mix_batch_id).filter((id): id is number => id !== null),
  ]);

  const mixById = new Map<number, MixRow>();
  const sourcesByMix = new Map<number, SourceRow[]>();
  const loadMixes = async (ids: number[]) => {
    const missing = ids.filter((id) => !mixById.has(id));
    if (missing.length === 0) return;
    const list = sql.join(
      missing.map((id) => sql`${id}`),
      sql`, `
    );
    for (const mix of await rows<MixRow>(
      tx,
      sql`
        SELECT id, batch_code, status, total_weight_kg::text AS total_weight_kg, used_kg::text AS used_kg,
               cost_per_kg::text AS cost_per_kg, total_cost::text AS total_cost
          FROM factory_mix_batches WHERE company_id = ${companyId} AND deleted_at IS NULL AND id IN (${list})
      `
    )) {
      mixById.set(mix.id, mix);
      sourcesByMix.set(mix.id, []);
    }
    for (const source of await rows<SourceRow>(
      tx,
      sql`
        SELECT id, mix_batch_id, container_id, supplier_id, source_batch_id, weight_kg::text AS weight_kg,
               cost_per_kg::text AS cost_per_kg
          FROM factory_mix_batch_sources WHERE mix_batch_id IN (${list}) ORDER BY id
      `
    )) {
      sourcesByMix.get(source.mix_batch_id)?.push(source);
    }
  };
  await loadMixes([...mixIds]);

  // The USD rate of each mix and of each of its sources, recomputed now.
  const mixRate = new Map<number, Decimal | null>();
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
