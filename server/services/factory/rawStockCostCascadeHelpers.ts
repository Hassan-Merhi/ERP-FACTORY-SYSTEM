// Extracted from ./rawStockCostCascade.ts
import type { DbTransaction } from "../../db";
import { eq, and, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { factoryMixBatchSources, factoryMixBatches, factoryBales } from "@shared/schema";
import { factoryStockEventsActive, withFactoryValuationEventTx } from "./factoryStockValueEvents";
import {
  calculateCostLine,
  calculateWeightedAverageCost,
  formatFactoryRate,
  formatFactoryTotal,
} from "./factoryCostingEngine";
import { toMoney } from "../../lib/money";

export interface CascadeResult {
  rawStockRowsUpdated: number;
  affectedBatches: {
    batchId: number;
    batchCode: string;
    status: string;
    oldCostPerKg: number;
    newCostPerKg: number;
    weightKgFromContainer: number;
    wasCompleted: boolean;
  }[];
  affectedBales: { baleId: number; baleCode?: string }[];
}

export const OPEN_BATCH_STATUSES = ["ACTIVE", "OPEN", "CARRY_FORWARD"];

export const COMPLETED_BATCH_STATUSES = ["COMPLETED", "CLOSED"];

type BatchCascadeResult = {
  batchCode: string;
  status: string;
  oldCostPerKg: number;
  newCostPerKg: number;
  totalBatchWeightKg: number;
  wasCompleted: boolean;
  bales: { baleId: number; baleCode?: string }[];
};

/**
 * Recompute one batch from all persisted source values, then cascade that cost
 * to the bales still associated with the batch (after the cut-over, only those
 * that are factory stock).
 */
export async function recomputeBatchAndCascadeBales(
  tx: DbTransaction,
  companyId: number,
  batchId: number
): Promise<BatchCascadeResult> {
  return withFactoryValuationEventTx(
    tx,
    companyId,
    "REVALUATION",
    { sourceType: "factory-mix-batch-cost-cascade", sourceId: batchId },
    () => recomputeBatchAndCascadeBalesInner(tx, companyId, batchId)
  );
}

/** Bales a cascade may re-cost: after the cut-over, factory stock only. */
async function cascadeBaleFilter(tx: DbTransaction, companyId: number) {
  if (!(await factoryStockEventsActive(tx, companyId))) {
    return sql`${factoryBales.status} NOT IN ('DELETED','REMOVED')`;
  }
  return sql`${factoryBales.status} IN ('PENDING_PRESSING','IN_STOCK','RESERVED_FOR_ORDER','RESERVED_FOR_DISPATCH')
    AND NOT EXISTS (
      SELECT 1 FROM customer_order_bales cob
        JOIN customer_orders co ON co.id = cob.order_id
       WHERE cob.bale_id = ${factoryBales.id} AND co.company_id = ${companyId}
         AND co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD')
    )`;
}

export async function recomputeBatchAndCascadeBalesInner(
  tx: DbTransaction,
  companyId: number,
  batchId: number
): Promise<{
  batchCode: string;
  status: string;
  oldCostPerKg: number;
  newCostPerKg: number;
  totalBatchWeightKg: number;
  wasCompleted: boolean;
  bales: { baleId: number; baleCode?: string }[];
}> {
  const [batch] = await tx.select().from(factoryMixBatches).where(eq(factoryMixBatches.id, batchId));
  const oldCostPerKg = batch ? toMoney(batch.costPerKg).toNumber() : 0;
  const wasCompleted = !!batch && COMPLETED_BATCH_STATUSES.includes(batch.status);
  const allSources = await tx
    .select({
      weightKg: factoryMixBatchSources.weightKg,
      costPerKg: factoryMixBatchSources.costPerKg,
      totalCost: factoryMixBatchSources.totalCost,
    })
    .from(factoryMixBatchSources)
    .where(eq(factoryMixBatchSources.mixBatchId, batchId));

  const aggregate = calculateWeightedAverageCost(
    allSources.map((source: { weightKg: string; costPerKg: string; totalCost: string }) => ({
      quantityKg: source.weightKg,
      unitCostPerKg: source.costPerKg,
      totalCost: source.totalCost,
    }))
  );

  await tx
    .update(factoryMixBatches)
    .set({
      costPerKg: formatFactoryRate(aggregate.weightedUnitCostPerKg),
      totalCost: formatFactoryTotal(aggregate.totalCost),
      updatedAt: new Date(),
    })
    .where(eq(factoryMixBatches.id, batchId));

  const balesInBatch = await tx
    .select({ id: factoryBales.id, baleCode: factoryBales.baleCode, weightKg: factoryBales.weightKg })
    .from(factoryBales)
    .where(
      and(
        eq(factoryBales.mixBatchId, batchId),
        eq(factoryBales.companyId, companyId),
        await cascadeBaleFilter(tx, companyId)
      )
    );

  const bales: { baleId: number; baleCode?: string }[] = [];
  for (const bale of balesInBatch) {
    const baleTotal = calculateCostLine(bale.weightKg as string, aggregate.weightedUnitCostPerKg).totalCost;
    await tx
      .update(factoryBales)
      .set({
        costPerKg: formatFactoryRate(aggregate.weightedUnitCostPerKg),
        totalCost: formatFactoryTotal(baleTotal),
        updatedAt: new Date(),
      })
      .where(eq(factoryBales.id, bale.id));
    bales.push({ baleId: bale.id, baleCode: bale.baleCode });
  }

  return {
    batchCode: batch?.batchCode || `#${batchId}`,
    status: batch?.status || "UNKNOWN",
    oldCostPerKg,
    newCostPerKg: aggregate.weightedUnitCostPerKg.toNumber(),
    totalBatchWeightKg: aggregate.totalQuantityKg.toNumber(),
    wasCompleted,
    bales,
  };
}

export interface CascadeContainerParams {
  companyId: number;
  containerId: number;
  newCostPerKg: number;
  newCostPerKgUsd: number;
  supplierInventoryValueDeltaUsdOverride?: Decimal;
  skipSupplierRateUpdate?: boolean;
}
