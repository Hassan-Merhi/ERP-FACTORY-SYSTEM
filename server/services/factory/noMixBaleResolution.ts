/**
 * Resolution of stock bales with no costed mix (accounting audit phase 28,
 * F4 and F6; owner decision 2026-10-11).
 *
 * A stock-entry bale with no mix was costed at its product's catalogue
 * production price, and a spreadsheet-imported bale with no mix carries the
 * spreadsheet's cost; neither is a cost the factory incurred, so they block
 * the perpetual cut-over (factoryCutoverBlockers: NO_MIX_BALES_AT_CATALOGUE_PRICE)
 * and the reviewed bale re-cost leaves them alone. This tool resolves each
 * such bale with one of three actions:
 *
 *   assign    the bale is costed from a costed mix: weight × the mix's USD cost
 *             per kg, and its mix is recorded (the mix's used weight is not
 *             changed: the bale is history, the tool only fixes its cost).
 *             The candidate is the latest costed mix (cost per kg above zero,
 *             live) that produced bales of the same product on or before the
 *             bale's stock-entry date, else the latest such mix. DEFAULT where
 *             a candidate exists (decision); an Owner may name another mix of
 *             the company.
 *   writeOff  the bale leaves stock through the Stock Removal service
 *             (deletePhysicalFactoryBalesTx: status, the ERP mirror, the WASTE
 *             value event under perpetual inventory, its audit).
 *   accept    the bale keeps its cost, with a sign-off (reason of at least 10
 *             characters); the cut-over check no longer lists it while its cost
 *             stays the accepted one.
 *
 * Garbage HMD16 bales cost nothing by rule and are not listed (F5).
 *
 *   GET  plan  (Admin/Owner): the bales, each with its candidate mix, the new
 *        cost and the default action; totals; a plan hash.
 *   POST apply (Owner, confirm + plan hash + actions): one transaction under
 *        the company's re-cost lock and the priority-scan lock (the removal
 *        flow takes the same); the plan recomputed (409 PLAN_CHANGED); every
 *        bale needs an action (an explicit one, the default, or the
 *        `unmatched` choice for bales with no candidate), else 400; refused in
 *        a closed period; one factory_bale_cost_resolutions row per bale and
 *        one audit row, in the same transaction. Before the cut-over nothing is
 *        posted (the opening values the factory at its costing then); under
 *        perpetual inventory an assignment's change is a REVALUATION value
 *        event (the daily factory journal posts it).
 */
import crypto from "node:crypto";

import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db, type DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { writeAuditEvent } from "../audit";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import { ACCEPTED_BALE_COST_SQL } from "../accounting/perpetualInventory/factoryCutoverBlockers";
import { baleCostFromMix, FACTORY_COST_SCALE } from "./baleCostBasis";
import { withFactoryValuationEventTx } from "./factoryStockValueEvents";
import { deletePhysicalFactoryBalesTx } from "../../routes/factory/stock/physicalBaleDeletion";
import { PRIORITY_SCAN_LOCK_NAMESPACE } from "../../routes/factory/customer-orders/priorityScanQueue";

export const NO_MIX_RESOLUTION_ACTIONS = ["assign", "writeOff", "accept"] as const;
export type NoMixResolutionAction = (typeof NO_MIX_RESOLUTION_ACTIONS)[number];

export const NO_MIX_RESOLUTION_MESSAGES = {
  PLAN_CHANGED: "The no-mix bale plan changed since it was reviewed. Preview it again and confirm the new plan.",
  NOTHING_TO_APPLY: "There is no bale without a costed mix to resolve.",
  ACTION_REQUIRED: "Choose an action (assign, write off or accept) for every bale without a candidate mix.",
  REASON_REQUIRED: "Accepting a bale's cost needs a sign-off reason of at least 10 characters.",
  MIX_NOT_COSTED: "The chosen mix is not a live, costed mix of this company.",
  UNKNOWN_BALE: "An action names a bale that is not in the plan.",
} as const;
export type NoMixResolutionCode = keyof typeof NO_MIX_RESOLUTION_MESSAGES;

export class NoMixResolutionRefusal extends HttpError {
  constructor(
    readonly code: NoMixResolutionCode,
    readonly baleIds: number[] = []
  ) {
    super(code === "PLAN_CHANGED" || code === "NOTHING_TO_APPLY" ? 409 : 400, NO_MIX_RESOLUTION_MESSAGES[code]);
    this.name = "NoMixResolutionRefusal";
  }
  get body() {
    return { code: this.code, message: this.message, ...(this.baleIds.length ? { baleIds: this.baleIds } : {}) };
  }
}

export interface NoMixBaleLine {
  baleId: number;
  referenceNumber: string;
  productId: number | null;
  articleCode: string | null;
  status: string;
  weightKg: string;
  imported: boolean;
  oldTotalCost: string;
  candidate: { mixBatchId: number; batchCode: string; costPerKg: string; newTotalCost: string } | null;
  defaultAction: "assign" | null;
}

export interface NoMixBalePlan {
  companyId: number;
  bales: NoMixBaleLine[];
  totals: { bales: number; cost: string; withCandidate: number; candidateCost: string };
  planHash: string;
}

async function rows<T>(tx: DbTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(query)).rows as unknown as T[];
}

const fixed = (value: Decimal) => value.toDecimalPlaces(FACTORY_COST_SCALE).toFixed(FACTORY_COST_SCALE);

/** The plan, computed inside `tx` (read-only). */
export async function planNoMixBaleResolutionTx(tx: DbTransaction, companyId: number): Promise<NoMixBalePlan> {
  const found = await rows<{
    id: number;
    reference_number: string;
    product_id: number | null;
    article_code: string | null;
    status: string;
    weight_kg: string;
    total_cost: string;
    import_batch_id: number | null;
    stock_entry_date: string | null;
  }>(
    tx,
    sql`
      SELECT b.id, b.reference_number, b.product_id, b.article_code, b.status, b.weight_kg::text AS weight_kg,
             b.total_cost::text AS total_cost, b.import_batch_id,
             COALESCE(b.stock_entry_date, b.created_at::date)::text AS stock_entry_date
        FROM factory_bales b
       WHERE b.company_id = ${companyId} AND b.deleted_at IS NULL AND b.mix_batch_id IS NULL
         AND COALESCE(b.total_cost, 0) > 0 AND COALESCE(b.article_code, '') NOT LIKE 'HMD16%'
         AND b.status IN ('PENDING_PRESSING', 'IN_STOCK', 'RESERVED_FOR_ORDER', 'RESERVED_FOR_DISPATCH')
         AND NOT (b.status = 'IN_STOCK' AND EXISTS (
           SELECT 1 FROM customer_order_bales cob
             JOIN customer_orders co ON co.id = cob.order_id
            WHERE cob.bale_id = b.id AND co.company_id = ${companyId} AND co.deleted_at IS NULL
              AND co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD', 'INVOICED', 'COMPLETED')
         ))
         AND NOT ${ACCEPTED_BALE_COST_SQL(companyId, sql`b`)}
       ORDER BY b.id
    `
  );
  // Costed mixes per product: mixes that produced bales of the product.
  const productIds = [...new Set(found.map((bale) => bale.product_id).filter((id): id is number => id !== null))];
  const mixesByProduct = new Map<number, Array<{ id: number; batch_code: string; cost: string; date: string }>>();
  if (productIds.length > 0) {
    const mixes = await rows<{ product_id: number; id: number; batch_code: string; cost: string; date: string }>(
      tx,
      sql`
        SELECT DISTINCT b.product_id, m.id, m.batch_code, m.cost_per_kg::text AS cost,
               COALESCE(m.batch_date, m.created_at::date)::text AS date
          FROM factory_bales b
          JOIN factory_mix_batches m ON m.id = b.mix_batch_id AND m.company_id = ${companyId}
                                    AND m.deleted_at IS NULL AND m.cost_per_kg > 0
         WHERE b.company_id = ${companyId} AND b.product_id = ANY(${`{${productIds.join(",")}}`}::int[])
         ORDER BY b.product_id, date, m.id
      `
    );
    for (const mix of mixes) {
      const list = mixesByProduct.get(Number(mix.product_id)) ?? [];
      list.push(mix);
      mixesByProduct.set(Number(mix.product_id), list);
    }
  }
  const bales: NoMixBaleLine[] = found.map((bale) => {
    const mixes = bale.product_id === null ? [] : (mixesByProduct.get(Number(bale.product_id)) ?? []);
    const onOrBefore = mixes.filter((mix) => !bale.stock_entry_date || mix.date <= bale.stock_entry_date);
    const chosen = (onOrBefore.length ? onOrBefore : mixes).at(-1) ?? null;
    const candidate = chosen
      ? {
          mixBatchId: Number(chosen.id),
          batchCode: chosen.batch_code,
          costPerKg: fixed(toMoney(chosen.cost)),
          newTotalCost: fixed(baleCostFromMix(bale.weight_kg, chosen.cost).totalCost),
        }
      : null;
    return {
      baleId: Number(bale.id),
      referenceNumber: bale.reference_number,
      productId: bale.product_id === null ? null : Number(bale.product_id),
      articleCode: bale.article_code,
      status: bale.status,
      weightKg: toMoney(bale.weight_kg).toFixed(3),
      imported: bale.import_batch_id !== null,
      oldTotalCost: fixed(toMoney(bale.total_cost)),
      candidate,
      defaultAction: candidate ? "assign" : null,
    };
  });
  const sum = (values: string[]) => values.reduce((total, value) => total.plus(value), new MoneyDecimal(0));
  const withCandidate = bales.filter((bale) => bale.candidate !== null);
  const totals = {
    bales: bales.length,
    cost: sum(bales.map((bale) => bale.oldTotalCost)).toFixed(2),
    withCandidate: withCandidate.length,
    candidateCost: sum(withCandidate.map((bale) => bale.candidate!.newTotalCost)).toFixed(2),
  };
  const planHash = crypto.createHash("sha256").update(JSON.stringify({ companyId, bales })).digest("hex");
  return { companyId, bales, totals, planHash };
}

export function planNoMixBaleResolution(companyId: number): Promise<NoMixBalePlan> {
  return db.transaction((tx) => planNoMixBaleResolutionTx(tx, companyId));
}

export interface NoMixResolutionInput {
  planHash: string;
  actions?: Array<{ baleId: number; action: NoMixResolutionAction; mixBatchId?: number | null }>;
  /** The action for bales with no candidate mix and no explicit action. */
  unmatched?: "writeOff" | "accept" | null;
  reason?: string | null;
  actor: { userId: string; username: string };
}

export interface NoMixResolutionResult {
  plan: NoMixBalePlan;
  applied: Array<{
    baleId: number;
    action: NoMixResolutionAction;
    mixBatchId: number | null;
    oldTotalCost: string;
    newTotalCost: string;
  }>;
}

export async function applyNoMixBaleResolution(
  companyId: number,
  input: NoMixResolutionInput
): Promise<NoMixResolutionResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory_bale_recost'), ${companyId})`);
    const date = await companyBusinessDate(companyId, tx);
    await tx.execute(sql`SELECT erp_assert_accounting_date_open(${companyId}, ${date}::date)`);
    const plan = await planNoMixBaleResolutionTx(tx, companyId);
    if (plan.planHash !== input.planHash) throw new NoMixResolutionRefusal("PLAN_CHANGED");
    if (plan.bales.length === 0) throw new NoMixResolutionRefusal("NOTHING_TO_APPLY");
    const byId = new Map(plan.bales.map((bale) => [bale.baleId, bale]));
    const explicit = new Map<number, { action: NoMixResolutionAction; mixBatchId: number | null }>();
    for (const entry of input.actions ?? []) {
      if (!byId.has(Number(entry.baleId))) throw new NoMixResolutionRefusal("UNKNOWN_BALE", [Number(entry.baleId)]);
      explicit.set(Number(entry.baleId), { action: entry.action, mixBatchId: entry.mixBatchId ?? null });
    }
    const decided = plan.bales.map((bale) => {
      const chosen = explicit.get(bale.baleId);
      if (chosen) return { bale, ...chosen };
      if (bale.defaultAction === "assign") return { bale, action: "assign" as const, mixBatchId: null };
      return { bale, action: input.unmatched ?? null, mixBatchId: null };
    });
    const missing = decided.filter((entry) => entry.action === null).map((entry) => entry.bale.baleId);
    if (missing.length > 0) throw new NoMixResolutionRefusal("ACTION_REQUIRED", missing);
    const reason = String(input.reason ?? "").trim();
    if (decided.some((entry) => entry.action === "accept") && reason.length < 10) {
      throw new NoMixResolutionRefusal("REASON_REQUIRED");
    }

    const applied: NoMixResolutionResult["applied"] = [];
    const writeOffs: number[] = [];
    for (const entry of decided) {
      const { bale } = entry;
      if (entry.action === "writeOff") {
        writeOffs.push(bale.baleId);
        applied.push({
          baleId: bale.baleId,
          action: "writeOff",
          mixBatchId: null,
          oldTotalCost: bale.oldTotalCost,
          newTotalCost: bale.oldTotalCost,
        });
        continue;
      }
      if (entry.action === "accept") {
        applied.push({
          baleId: bale.baleId,
          action: "accept",
          mixBatchId: null,
          oldTotalCost: bale.oldTotalCost,
          newTotalCost: bale.oldTotalCost,
        });
        continue;
      }
      // assign
      let mixId = entry.mixBatchId ?? bale.candidate?.mixBatchId ?? null;
      let costPerKg = entry.mixBatchId ? null : (bale.candidate?.costPerKg ?? null);
      if (mixId === null) throw new NoMixResolutionRefusal("ACTION_REQUIRED", [bale.baleId]);
      if (costPerKg === null) {
        const [mix] = await rows<{ cost: string }>(
          tx,
          sql`SELECT cost_per_kg::text AS cost FROM factory_mix_batches
               WHERE id = ${mixId} AND company_id = ${companyId} AND deleted_at IS NULL AND cost_per_kg > 0`
        );
        if (!mix) throw new NoMixResolutionRefusal("MIX_NOT_COSTED", [bale.baleId]);
        costPerKg = mix.cost;
        mixId = Number(mixId);
      }
      const next = baleCostFromMix(bale.weightKg, costPerKg);
      await withFactoryValuationEventTx(
        tx,
        companyId,
        "REVALUATION",
        { sourceType: "factory-no-mix-bale-assign", sourceId: bale.baleId },
        async () => {
          await tx.execute(sql`
            UPDATE factory_bales SET mix_batch_id = ${mixId}, cost_per_kg = ${fixed(next.costPerKg)},
                   total_cost = ${fixed(next.totalCost)}, updated_at = now()
             WHERE id = ${bale.baleId} AND company_id = ${companyId}
          `);
        }
      );
      applied.push({
        baleId: bale.baleId,
        action: "assign",
        mixBatchId: mixId,
        oldTotalCost: bale.oldTotalCost,
        newTotalCost: fixed(next.totalCost),
      });
    }
    if (writeOffs.length > 0) {
      await deletePhysicalFactoryBalesTx(tx, {
        companyId,
        baleIds: writeOffs,
        actorId: input.actor.userId,
        actorName: input.actor.username,
        reason: reason || "No-mix bale written off (reviewed resolution)",
      });
    }
    for (const entry of applied) {
      await tx.execute(sql`
        INSERT INTO factory_bale_cost_resolutions
          (company_id, bale_id, action, mix_batch_id, old_total_cost, new_total_cost, reason, plan_hash, applied_by)
        VALUES (${companyId}, ${entry.baleId}, ${entry.action.toUpperCase()}, ${entry.mixBatchId},
                ${entry.oldTotalCost}, ${entry.newTotalCost}, ${reason || null}, ${plan.planHash}, ${input.actor.username})
      `);
    }
    await writeAuditEvent(
      {
        userId: input.actor.userId,
        username: input.actor.username,
        companyId,
        action: "update",
        tableName: "factory_bales",
        recordId: companyId,
        recordIdentifier: "factory-no-mix-bale-resolution",
        reason: reason || null,
        changes: {
          resolution: {
            old: applied.map((entry) => ({ id: entry.baleId, totalCost: entry.oldTotalCost })),
            new: applied.map((entry) => ({
              id: entry.baleId,
              action: entry.action,
              mixBatchId: entry.mixBatchId,
              totalCost: entry.newTotalCost,
            })),
          },
          planHash: { old: null, new: plan.planHash },
        },
      },
      tx
    );
    return { plan, applied };
  });
}
