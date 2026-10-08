/**
 * The reviewed re-cost of unsold bales and open mixes (accounting audit wave
 * 11, owner decision 5).
 *
 * Existing bales and mixes carry costs from the old rules (stock-entry bales
 * at production price × kg, pressing at the containers' native-currency cost,
 * recalculations writing native costs). They are brought to the USD cost basis
 * (baleCostBasis.ts) only here, never automatically at boot:
 *
 *   1. preview (planBaleRecost): per mix the old and new USD cost per kg and the
 *      work-in-progress change, per bale the old and new cost, the rows that
 *      cannot be valued (a source with no USD rate) and a plan hash;
 *   2. an Owner confirms the hash (applyBaleRecost): the plan is computed again
 *      inside one locked transaction and applied only when it is the plan that
 *      was reviewed. It is refused in a closed accounting period, recorded in
 *      factory_bale_recost_runs and the audit log with every old/new cost, and,
 *      once the company's cut-over applies, posts the stock value change
 *      FACTORY-RECOST-{company}-{run}: Dr/Cr Factory Work in Progress and
 *      Factory Finished Goods / Cr/Dr Factory Stock Revaluation. Before the
 *      cut-over nothing is posted (the opening journal values the factory at
 *      its costing then).
 *
 * What is re-costed:
 *   - bales that are factory stock and not sold: in stock or reserved
 *     (RESERVED_FOR_ORDER / RESERVED_FOR_DISPATCH), not on a finalized,
 *     dispatched or sold order. SOLD bales are never re-costed;
 *   - a bale from a mix at weight × the mix's USD cost per kg, recomputed from
 *     the mix's sources at their USD rates now (the supplier's locked moving
 *     average, else the container's landed USD cost; an upstream batch at its
 *     own recomputed rate);
 *   - a bale with no mix at its product's production price per bale (garbage
 *     HMD16 bales at nothing); a bale with no product keeps its cost;
 *   - mixes: every mix whose rate a re-costed bale uses, and every open mix
 *     (not closed, with weight left). Their sources take the USD rates and
 *     their header the recomputed cost. Only an open mix's remaining weight is
 *     work in progress, so only it moves the WIP account.
 * A mix with a source that has no USD rate, and its bales, are listed as
 * unvalued and left unchanged.
 */
import crypto from "node:crypto";

import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db, type DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { logAudit } from "../../routes/helpers/auditHelpers";
import { isPerpetualInventoryActive } from "../accounting/perpetualInventory/cutover";
import {
  isSupplierPartnerCompany,
  postLinkedJournalTx,
  systemAccountIdsTx,
} from "../accounting/perpetualInventory/linkedJournal";
import {
  baleCostFromMix,
  containerUsdRate,
  FACTORY_COST_SCALE,
  rawSourceUsdRate,
  stockEntryBaleCost,
} from "./baleCostBasis";
import { resolveMixSourcePricingBasis } from "./mixSourcePricingBasis";

export const FACTORY_BALE_RECOST_MOVED_MESSAGE =
  "Bale costs are now changed only through the reviewed re-cost: preview the plan, then an Owner confirms it.";
export const FACTORY_BALE_RECOST_PLAN_CHANGED_MESSAGE =
  "The re-cost plan changed since it was reviewed. Preview it again and confirm the new plan.";
export const FACTORY_BALE_RECOST_NOTHING_MESSAGE = "There is nothing to re-cost.";

export const factoryRecostVoucherNumber = (companyId: number, runId: number) => `FACTORY-RECOST-${companyId}-${runId}`;

export interface RecostMixLine {
  id: number;
  batchCode: string;
  status: string;
  /** Weight left in an open mix (work in progress); 0 for a mix that is not WIP. */
  wipKg: string;
  oldCostPerKg: string;
  newCostPerKg: string;
  oldTotalCost: string;
  newTotalCost: string;
  wipChange: string;
  sources: Array<{ id: number; oldCostPerKg: string; newCostPerKg: string; newTotalCost: string }>;
}

export interface RecostBaleLine {
  id: number;
  referenceNumber: string;
  status: string;
  mixBatchId: number | null;
  weightKg: string;
  basis: "mix" | "production-price";
  oldCostPerKg: string;
  newCostPerKg: string;
  oldTotalCost: string;
  newTotalCost: string;
  change: string;
}

export interface RecostUnvalued {
  source: "factory_mix_batches" | "factory_bales";
  id: number;
  reason: string;
}

export interface BaleRecostPlan {
  companyId: number;
  date: string;
  /** Whether applying posts the revaluation journal (the cut-over applies today). */
  perpetual: boolean;
  mixes: RecostMixLine[];
  bales: RecostBaleLine[];
  unvalued: RecostUnvalued[];
  totals: { wipChange: string; finishedChange: string; total: string };
  planHash: string;
}

export class BaleRecostRefusal extends Error {
  constructor(
    readonly code: "PLAN_CHANGED" | "NOTHING_TO_APPLY",
    message: string
  ) {
    super(message);
    this.name = "BaleRecostRefusal";
  }
}

const todayUtc = () => new Date().toISOString().slice(0, 10);
const fixed = (value: Decimal) => value.toDecimalPlaces(FACTORY_COST_SCALE).toFixed(FACTORY_COST_SCALE);

async function rows<T>(tx: DbTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(query)).rows as unknown as T[];
}

interface SourceRow {
  id: number;
  mix_batch_id: number;
  container_id: number | null;
  supplier_id: number | null;
  source_batch_id: number | null;
  weight_kg: string;
  cost_per_kg: string;
}

interface MixRow {
  id: number;
  batch_code: string;
  status: string;
  total_weight_kg: string;
  used_kg: string;
  cost_per_kg: string;
  total_cost: string;
}

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
         AND b.status IN ('IN_STOCK', 'RESERVED_FOR_ORDER', 'RESERVED_FOR_DISPATCH')
         AND NOT EXISTS (
           SELECT 1 FROM customer_order_bales cob
             JOIN customer_orders co ON co.id = cob.order_id
            WHERE cob.bale_id = b.id AND co.company_id = ${companyId}
              AND co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD')
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

export function planBaleRecost(companyId: number): Promise<BaleRecostPlan> {
  return db.transaction((tx) => planBaleRecostTx(tx, companyId));
}

export interface BaleRecostResult {
  runId: number;
  voucherId: number | null;
  plan: BaleRecostPlan;
}

/**
 * Applies the reviewed plan (see the module comment). Throws BaleRecostRefusal
 * when the plan changed or is empty, and the closed-period error when today is
 * in a closed accounting period.
 */
export async function applyBaleRecost(
  companyId: number,
  params: { planHash: string; actor: { userId: string; username: string } }
): Promise<BaleRecostResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory_bale_recost'), ${companyId})`);
    const date = todayUtc();
    // The revaluation is dated today: refused in a closed period, journal or not.
    await tx.execute(sql`SELECT erp_assert_accounting_date_open(${companyId}, ${date}::date)`);
    const plan = await planBaleRecostTx(tx, companyId);
    if (plan.planHash !== params.planHash) {
      throw new BaleRecostRefusal("PLAN_CHANGED", FACTORY_BALE_RECOST_PLAN_CHANGED_MESSAGE);
    }
    if (plan.mixes.length === 0 && plan.bales.length === 0) {
      throw new BaleRecostRefusal("NOTHING_TO_APPLY", FACTORY_BALE_RECOST_NOTHING_MESSAGE);
    }

    const now = new Date();
    for (const mix of plan.mixes) {
      for (const source of mix.sources) {
        await tx.execute(sql`
          UPDATE factory_mix_batch_sources SET cost_per_kg = ${source.newCostPerKg}, total_cost = ${source.newTotalCost}
           WHERE id = ${source.id} AND mix_batch_id = ${mix.id}
        `);
      }
      await tx.execute(sql`
        UPDATE factory_mix_batches SET cost_per_kg = ${mix.newCostPerKg}, total_cost = ${mix.newTotalCost},
               updated_at = ${now}
         WHERE id = ${mix.id} AND company_id = ${companyId}
      `);
    }
    for (const bale of plan.bales) {
      await tx.execute(sql`
        UPDATE factory_bales SET cost_per_kg = ${bale.newCostPerKg}, total_cost = ${bale.newTotalCost},
               updated_at = ${now}
         WHERE id = ${bale.id} AND company_id = ${companyId}
      `);
    }

    const [run] = await rows<{ id: number }>(
      tx,
      sql`
        INSERT INTO factory_bale_recost_runs (company_id, plan_hash, plan, applied_by)
        VALUES (${companyId}, ${plan.planHash}, ${JSON.stringify(plan)}::jsonb, ${params.actor.username})
        RETURNING id
      `
    );

    let voucherId: number | null = null;
    if (plan.perpetual && !(await isSupplierPartnerCompany(tx, companyId))) {
      const wip = toMoney(plan.totals.wipChange);
      const finished = toMoney(plan.totals.finishedChange);
      const total = wip.plus(finished);
      const zero = new MoneyDecimal(0);
      const accounts = await systemAccountIdsTx(tx, companyId, [
        "FACTORY_WIP",
        "FACTORY_FINISHED_GOODS",
        "FACTORY_REVALUATION",
      ]);
      const side = (amount: Decimal) => ({
        debit: amount.isPositive() ? amount : zero,
        credit: amount.isNegative() ? amount.negated() : zero,
      });
      const number = factoryRecostVoucherNumber(companyId, run.id);
      voucherId = await postLinkedJournalTx(tx, {
        companyId,
        voucherNumber: number,
        voucherDate: date,
        description: ["Factory bale re-cost", number].join(" - "),
        identity: { sourceType: "factory-bale-recost", sourceId: run.id },
        lines: [
          { ledgerAccountId: accounts.get("FACTORY_WIP")!, ...side(wip), narration: "Open mixes re-costed in USD" },
          {
            ledgerAccountId: accounts.get("FACTORY_FINISHED_GOODS")!,
            ...side(finished),
            narration: "Unsold bales re-costed in USD",
          },
          {
            ledgerAccountId: accounts.get("FACTORY_REVALUATION")!,
            ...side(total.negated()),
            narration: "Factory stock revaluation: reviewed bale re-cost",
          },
        ],
      });
      if (voucherId !== null) {
        await tx.execute(sql`UPDATE factory_bale_recost_runs SET voucher_id = ${voucherId} WHERE id = ${run.id}`);
      }
    }

    await logAudit(
      {
        userId: params.actor.userId,
        username: params.actor.username,
        companyId,
        action: "update",
        tableName: "factory_bales",
        recordId: run.id,
        recordIdentifier: "factory bale re-cost",
        changes: {
          recost: {
            new: {
              runId: run.id,
              planHash: plan.planHash,
              voucherId,
              totals: plan.totals,
              mixes: plan.mixes.map((mix) => ({ id: mix.id, old: mix.oldCostPerKg, new: mix.newCostPerKg })),
              bales: plan.bales.map((bale) => ({ id: bale.id, old: bale.oldTotalCost, new: bale.newTotalCost })),
            },
          },
        },
      },
      tx
    );
    return { runId: run.id, voucherId, plan };
  });
}
