/**
 * Shared cascade logic for propagating a corrected raw-material landed cost
 * through raw stock, mix-batch sources, mix-batch headers, and bales.
 *
 * This service is cost-only. It never changes quantities, vouchers, supplier
 * balances, payments, or source ownership. Callers must invoke it inside the
 * transaction that owns the business event.
 *
 * Wave 11 (inventory fidelity):
 *   - once the company's cut-over applies (today), a cascade re-costs only the
 *     bales that are factory stock (pending pressing, in stock, reserved). Sold,
 *     dispatched, loaded and written-off bales, and bales on finalized,
 *     dispatched or sold orders, keep the cost their invoice or sale took
 *     (history kept). Before the cut-over the ledger carries no bale cost, so
 *     the cascade keeps correcting every bale of the batch, sold ones
 *     included, as it always did (order profit and history read the
 *     corrected landed cost);
 *   - the change the cascade makes to the factory valuation is recorded as a
 *     REVALUATION event, which the daily factory stock journal posts to
 *     Factory Stock Revaluation instead of Production Variance.
 */
import type { DbTransaction } from "../../db";
import { eq, and, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  factoryRawStock,
  factoryMixBatchSources,
  factoryMixBatches,
  factoryBales,
  factoryContainers,
  factorySuppliers,
} from "@shared/schema";
import { getLockedSupplierRate, getAuthoritativeSupplierRemainingKg } from "./rawStockLockedRate";
import { resolveMixSourcePricingBasis } from "./mixSourcePricingBasis";
import { factoryStockEventsActive, withFactoryValuationEventTx } from "./factoryStockValueEvents";
import {
  calculateCostLine,
  calculateRateAfterInventoryValueDelta,
  calculateRemainingInventoryCorrection,
  calculateWeightedAverageCost,
  factoryCostDecimal,
  formatFactoryLockedRate,
  formatFactoryRate,
  formatFactoryTotal,
} from "./factoryCostingEngine";

/** Cost recalculation must never mutate inventory or batch quantities. */
export function assertNoQuantityFields(update: Record<string, unknown>, context = "cost update"): void {
  const forbidden = [
    "receivedKg",
    "received_kg",
    "usedKg",
    "used_kg",
    "totalWeightKg",
    "total_weight_kg",
    "weightKg",
    "weight_kg",
  ];
  for (const field of forbidden) {
    if (field in update) {
      throw new Error(
        `assertNoQuantityFields [${context}]: forbidden quantity field "${field}" found. ` +
          "Cost recalculation must never modify quantities."
      );
    }
  }
}

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

const OPEN_BATCH_STATUSES = ["ACTIVE", "OPEN", "CARRY_FORWARD"];
const COMPLETED_BATCH_STATUSES = ["COMPLETED", "CLOSED"];

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

async function recomputeBatchAndCascadeBalesInner(
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
  const oldCostPerKg = batch ? parseFloat(batch.costPerKg || "0") : 0;
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

/**
 * Apply a corrected container landed rate and propagate only the accounting
 * value that remains relevant to current inventory and eligible production.
 */
export async function cascadeContainerCostChange(
  tx: DbTransaction,
  params: CascadeContainerParams,
  opts: {
    includeCompletedBatches?: boolean;
  } = {}
): Promise<CascadeResult> {
  return withFactoryValuationEventTx(
    tx,
    params.companyId,
    "REVALUATION",
    { sourceType: "factory-container-cost-cascade", sourceId: params.containerId },
    () => cascadeContainerCostChangeInner(tx, params, opts)
  );
}

interface CascadeContainerParams {
  companyId: number;
  containerId: number;
  newCostPerKg: number;
  newCostPerKgUsd: number;
  supplierInventoryValueDeltaUsdOverride?: Decimal;
  skipSupplierRateUpdate?: boolean;
}

async function cascadeContainerCostChangeInner(
  tx: DbTransaction,
  params: CascadeContainerParams,
  opts: {
    includeCompletedBatches?: boolean;
  }
): Promise<CascadeResult> {
  const { companyId, containerId } = params;
  const { includeCompletedBatches = false } = opts;
  const newCostPerKg = factoryCostDecimal(params.newCostPerKg, "newCostPerKg");
  const newCostPerKgUsd = factoryCostDecimal(params.newCostPerKgUsd, "newCostPerKgUsd");

  const rawStockRows = await tx
    .select()
    .from(factoryRawStock)
    .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, containerId)));

  let correctedContainerRemainingKg = new Decimal(0);
  let oldValueOfRemaining = new Decimal(0);
  for (const row of rawStockRows) {
    const received = factoryCostDecimal(row.receivedKg as string, "rawStock.receivedKg");
    const used = factoryCostDecimal(row.usedKg as string, "rawStock.usedKg");
    const remaining = Decimal.max(0, received.minus(used));
    const oldCostUsd = factoryCostDecimal(
      (row.costPerKgUsd as string) || (row.costPerKg as string) || "0",
      "rawStock.costPerKgUsd"
    );
    correctedContainerRemainingKg = correctedContainerRemainingKg.plus(remaining);
    oldValueOfRemaining = oldValueOfRemaining.plus(calculateCostLine(remaining, oldCostUsd).totalCost);

    const rawStockCostUpdate = {
      costPerKg: formatFactoryRate(newCostPerKg),
      costPerKgUsd: formatFactoryRate(newCostPerKgUsd),
    };
    assertNoQuantityFields(rawStockCostUpdate, "cascadeContainerCostChange → factoryRawStock");
    await tx.update(factoryRawStock).set(rawStockCostUpdate).where(eq(factoryRawStock.id, row.id));
  }

  const [container] = await tx
    .select({ supplierId: factoryContainers.supplierId })
    .from(factoryContainers)
    .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));

  if (container?.supplierId && !params.skipSupplierRateUpdate) {
    const oldLockedRate = await getLockedSupplierRate(tx, companyId, container.supplierId, {
      forUpdate: true,
    });
    const supplierTotalRemainingKg = Math.max(
      0,
      await getAuthoritativeSupplierRemainingKg(tx, companyId, container.supplierId)
    );

    const nextLockedRate =
      params.supplierInventoryValueDeltaUsdOverride !== undefined
        ? calculateRateAfterInventoryValueDelta({
            inventoryQuantityKg: supplierTotalRemainingKg,
            currentRatePerKg: oldLockedRate,
            valueDelta: params.supplierInventoryValueDeltaUsdOverride,
            fallbackRatePerKg: newCostPerKgUsd,
          })
        : calculateRemainingInventoryCorrection({
            supplierRemainingKg: supplierTotalRemainingKg,
            currentLockedRatePerKg: oldLockedRate,
            correctedContainerRemainingKg,
            oldCorrectedContainerRemainingValue: oldValueOfRemaining,
            newContainerRatePerKg: newCostPerKgUsd,
          }).newLockedRatePerKg;

    await tx
      .update(factorySuppliers)
      .set({
        currentRawMaterialCostPerKgUsd: formatFactoryLockedRate(nextLockedRate),
        updatedAt: new Date(),
      })
      .where(and(eq(factorySuppliers.id, container.supplierId), eq(factorySuppliers.companyId, companyId)));
  }

  const cascadeStatuses = includeCompletedBatches
    ? [...OPEN_BATCH_STATUSES, ...COMPLETED_BATCH_STATUSES]
    : OPEN_BATCH_STATUSES;

  const mixSourcesWithStatus = await tx
    .select({ src: factoryMixBatchSources, batchStatus: factoryMixBatches.status })
    .from(factoryMixBatchSources)
    .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
    .where(and(eq(factoryMixBatchSources.containerId, containerId), sql`${factoryMixBatches.deletedAt} IS NULL`));

  const affectedBatches: CascadeResult["affectedBatches"] = [];
  const affectedBales: CascadeResult["affectedBales"] = [];

  if (mixSourcesWithStatus.length > 0) {
    const allSources = mixSourcesWithStatus.map((row) => row.src);
    const containerWeightByBatch = new Map<number, Decimal>();
    for (const source of allSources) {
      const previous = containerWeightByBatch.get(source.mixBatchId) || new Decimal(0);
      containerWeightByBatch.set(
        source.mixBatchId,
        previous.plus(factoryCostDecimal(source.weightKg, "mixSource.weightKg"))
      );
    }

    for (const source of allSources) {
      const basis = resolveMixSourcePricingBasis({
        sourceBatchId: source.sourceBatchId,
        supplierId: source.supplierId,
        containerId: source.containerId,
      });
      if (basis !== "CONTAINER_DIRECT") continue;

      const sourceTotal = calculateCostLine(source.weightKg, newCostPerKgUsd).totalCost;
      await tx
        .update(factoryMixBatchSources)
        .set({
          costPerKg: formatFactoryRate(newCostPerKgUsd),
          totalCost: formatFactoryTotal(sourceTotal),
        })
        .where(eq(factoryMixBatchSources.id, source.id));
    }

    const cascadeEligibleBatchIds = [
      ...new Set(
        mixSourcesWithStatus
          .filter((row: { batchStatus: string }) => cascadeStatuses.includes(row.batchStatus))
          .map((row) => row.src.mixBatchId as number)
      ),
    ] as number[];

    for (const batchId of cascadeEligibleBatchIds) {
      const {
        bales,
        totalBatchWeightKg: _totalWeight,
        ...batchResult
      } = await recomputeBatchAndCascadeBalesInner(tx, companyId, batchId);
      affectedBatches.push({
        batchId,
        ...batchResult,
        weightKgFromContainer: (containerWeightByBatch.get(batchId) || new Decimal(0)).toNumber(),
      });
      affectedBales.push(...bales);
    }

    // Closed/completed batches that are not explicitly cascaded keep bale history,
    // but their header must still reconcile to their own persisted source values.
    const skippedCompletedBatchIds = [
      ...new Set(
        mixSourcesWithStatus
          .filter((row: { batchStatus: string }) => !cascadeStatuses.includes(row.batchStatus))
          .map((row) => row.src.mixBatchId as number)
      ),
    ] as number[];

    for (const batchId of skippedCompletedBatchIds) {
      const batchSources = await tx
        .select({
          weightKg: factoryMixBatchSources.weightKg,
          costPerKg: factoryMixBatchSources.costPerKg,
          totalCost: factoryMixBatchSources.totalCost,
        })
        .from(factoryMixBatchSources)
        .where(eq(factoryMixBatchSources.mixBatchId, batchId));
      const aggregate = calculateWeightedAverageCost(
        batchSources.map((source: { weightKg: string; costPerKg: string; totalCost: string }) => ({
          quantityKg: source.weightKg,
          unitCostPerKg: source.costPerKg,
          totalCost: source.totalCost,
        }))
      );
      if (aggregate.totalQuantityKg.gt(0)) {
        await tx
          .update(factoryMixBatches)
          .set({
            costPerKg: formatFactoryRate(aggregate.weightedUnitCostPerKg),
            totalCost: formatFactoryTotal(aggregate.totalCost),
            updatedAt: new Date(),
          })
          .where(eq(factoryMixBatches.id, batchId));
      }
    }
  }

  return {
    rawStockRowsUpdated: rawStockRows.length,
    affectedBatches,
    affectedBales,
  };
}
