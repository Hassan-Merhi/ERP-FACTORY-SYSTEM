import Decimal from "decimal.js";
import type { BatchCorrection, ReplayQueryExecutor, ReplayScopeInternal } from "./types";
import { buildExactHistoricalReplayScopeInternalV6 } from "./exactScopeV6";
import { classifyReplayBalesForBatches } from "./baleClassification";
import { lockSelectedReplayAuthoritativeInputs } from "./authoritativeLocks";
import { toMoney } from "../../../lib/money";

function sortNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

/**
 * Final exact scope additions:
 * - authoritative landed-cost inputs are locked before apply calculations;
 * - raw-stock mismatches are independent from container target mismatches;
 * - source-correction parent batches remain signed when corrections offset;
 * - bales are classified from the final exact batch list.
 */
export async function buildExactHistoricalReplayScopeInternalFinal(params: {
  companyId: number;
  selectedSupplierIds: Set<number>;
  includeCompletedBatches: boolean;
  includeFinalizedBales: boolean;
  executor: ReplayQueryExecutor;
  lockRows?: boolean;
}): Promise<ReplayScopeInternal> {
  if (params.lockRows) {
    await lockSelectedReplayAuthoritativeInputs(params.executor, params.companyId, [...params.selectedSupplierIds]);
  }

  const base = await buildExactHistoricalReplayScopeInternalV6(params);

  // A container may already have the correct USD target while its active raw-stock
  // row is stale (or vice versa). Calculate raw-stock scope independently for all
  // safe selected suppliers rather than only under containers being rewritten.
  if (base.supplierIds.length > 0) {
    const rawRows = await params.executor.query<{
      id: number;
      container_id: number;
      cost_per_kg_usd: string | null;
    }>(
      `SELECT frs.id, frs.container_id, frs.cost_per_kg_usd
       FROM factory_raw_stock frs
       JOIN factory_containers fc ON fc.id = frs.container_id
       WHERE frs.company_id = $1
         AND fc.company_id = $1
         AND fc.supplier_id = ANY($2)
         AND frs.deleted_at IS NULL
         AND fc.deleted_at IS NULL
         AND fc.status != 'DELETED'
       ORDER BY frs.id`,
      [params.companyId, base.supplierIds]
    );
    const rawStockIdToContainer = new Map<number, number>();
    for (const row of rawRows.rows) {
      const expected = base._canonicalRateByContainer.get(row.container_id);
      if (expected == null) continue;
      const stored = toMoney(row.cost_per_kg_usd).toNumber();
      if (Math.abs(expected - stored) > 0.000001) {
        rawStockIdToContainer.set(row.id, row.container_id);
      }
    }
    base._rawStockIdToContainer = rawStockIdToContainer;
    base.rawStockIdsToUpdate = sortNumbers([...rawStockIdToContainer.keys()]);

    if (params.lockRows && base.rawStockIdsToUpdate.length > 0) {
      await params.executor.query(
        `SELECT id
         FROM factory_raw_stock
         WHERE id = ANY($1) AND company_id = $2
         ORDER BY id
         FOR UPDATE`,
        [base.rawStockIdsToUpdate, params.companyId]
      );
    }
  }

  const sourceCorrections = base._sourceCorrections ?? new Map();
  const requiredParentBatchIds = sortNumbers([...sourceCorrections.values()].map((correction) => correction.batchId));
  const missingBatchIds = requiredParentBatchIds.filter((batchId) => !base.batchIdsToUpdate.includes(batchId));

  if (missingBatchIds.length > 0) {
    const rows = await params.executor.query<{
      id: number;
      batch_code: string;
      status: string;
      batch_date: string | null;
      cost_per_kg: string;
      total_cost: string;
    }>(
      `SELECT id, batch_code, status, batch_date, cost_per_kg, total_cost
       FROM factory_mix_batches
       WHERE company_id = $1
         AND id = ANY($2)
         AND deleted_at IS NULL
       ORDER BY id`,
      [params.companyId, missingBatchIds]
    );
    if (rows.rows.length !== missingBatchIds.length) {
      throw Object.assign(
        new Error("HISTORICAL_REPLAY_SCOPE_VIOLATION: a source-correction parent batch disappeared"),
        { code: "HISTORICAL_REPLAY_SCOPE_VIOLATION" }
      );
    }

    const additions: BatchCorrection[] = [];
    for (const row of rows.rows) {
      const sources = base._sourceInfos.filter((source) => source.batchId === row.id);
      if (sources.length === 0) {
        throw Object.assign(
          new Error(`HISTORICAL_REPLAY_SCOPE_VIOLATION: batch ${row.id} has no complete source set`),
          { code: "HISTORICAL_REPLAY_SCOPE_VIOLATION" }
        );
      }
      let totalWeight = new Decimal(0);
      let totalCost = new Decimal(0);
      const correctedSourceCosts = new Map<number, number>();
      for (const source of sources) {
        const expected = sourceCorrections.get(source.sourceId)?.expectedCostPerKg ?? source.storedCostPerKg;
        correctedSourceCosts.set(source.sourceId, expected);
        totalWeight = totalWeight.plus(source.weightKg);
        totalCost = totalCost.plus(new Decimal(source.weightKg).times(expected));
      }
      if (totalWeight.lte(0)) {
        throw Object.assign(
          new Error(`HISTORICAL_REPLAY_SCOPE_VIOLATION: batch ${row.id} has no positive source weight`),
          { code: "HISTORICAL_REPLAY_SCOPE_VIOLATION" }
        );
      }
      additions.push({
        batchId: row.id,
        batchCode: row.batch_code,
        status: row.status,
        batchDate: row.batch_date,
        storedCostPerKg: Number(row.cost_per_kg || 0),
        expectedCostPerKg: totalCost.div(totalWeight).toDecimalPlaces(6).toNumber(),
        storedTotalCost: Number(row.total_cost || 0),
        expectedTotalCost: totalCost.toDecimalPlaces(6).toNumber(),
        correctedSourceCosts,
      });
    }

    base._batchCorrections = [...base._batchCorrections, ...additions].sort(
      (left, right) => left.batchId - right.batchId
    );
    base.batchIdsToUpdate = sortNumbers([...base.batchIdsToUpdate, ...missingBatchIds]);
  }

  const classification = await classifyReplayBalesForBatches(params.executor, params.companyId, base.batchIdsToUpdate);
  base.availableBaleIdsToUpdate = classification.availableIds;
  base.finalizedBaleIdsToUpdate = classification.finalizedIds;

  if (params.lockRows) {
    const baleIds = params.includeFinalizedBales
      ? sortNumbers([...classification.availableIds, ...classification.finalizedIds])
      : classification.availableIds;
    if (baleIds.length > 0) {
      await params.executor.query(
        `SELECT id
         FROM factory_bales
         WHERE id = ANY($1)
           AND company_id = $2
           AND deleted_at IS NULL
         ORDER BY id
         FOR UPDATE`,
        [baleIds, params.companyId]
      );
    }
  }

  return base;
}
