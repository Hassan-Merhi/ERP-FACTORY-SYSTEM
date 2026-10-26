/**
 * Shared read-only Balance on Table as-of valuation for Production Overview
 * and Factory Net Position. Each remaining batch (including carry-forwards)
 * retains its own stored cost basis. The original cumulative batch rate is
 * returned separately for the legacy production-profit computation.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { netPositionRecordedThrough } from "./netPositionAsOf";
import { resultRows } from "../../lib/queryResult";
import {
  BatchRateDecimal,
  calculateBatchRemainingValuation,
  calculateCumulativeBatchRate,
  resolveProductionBalanceWeight,
} from "../../routes/factory/bale-exports/production-value-math";

type MixRow = {
  id: number;
  total_weight_kg: string;
  total_cost: string;
  used_kg: string;
  needs_replay: boolean;
  carry_forward_from_id: number | null;
};

type ConsumptionRow = {
  batch_id: number;
  used_kg: string;
  has_carry: boolean;
};

export async function getFactoryBalanceOnTableSnapshot(
  companyId: number,
  throughDate?: string | null,
  knownAt?: FactoryNetPositionAsOf
) {
  const recorded = (column: string) =>
    knownAt ? netPositionRecordedThrough(sql.raw(column), knownAt, "utc-naive-timestamp") : sql`TRUE`;
  const throughRecorded = (column: string) =>
    knownAt
      ? netPositionRecordedThrough(sql.raw(column), knownAt, "utc-naive-timestamp")
      : throughDate
        ? sql`${sql.raw(column)} < (${throughDate}::date + INTERVAL '1 day')`
        : sql`TRUE`;
  const notDeleted = (column: string) =>
    knownAt ? sql`(${sql.raw(column)} IS NULL OR NOT ${recorded(column)})` : sql`${sql.raw(column)} IS NULL`;

  // Keep the existing historical correction for top-ups written after the
  // selected cutoff. These adjusted totals define the batch's cost basis.
  const lateSources = knownAt
    ? sql`
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(ms.weight_kg::numeric) FILTER (WHERE NOT ${recorded("ms.created_at")}), 0) AS late_kg,
                 COALESCE(SUM(ms.total_cost::numeric) FILTER (WHERE NOT ${recorded("ms.created_at")}), 0) AS late_cost,
                 COUNT(*) FILTER (WHERE ${recorded("ms.created_at")}) AS known_rows
            FROM factory_mix_batch_sources ms
           WHERE ms.mix_batch_id = factory_mix_batches.id
        ) late ON TRUE`
    : sql``;
  const mixKgExpr = knownAt
    ? sql`total_weight_kg::numeric - CASE WHEN late.known_rows > 0 THEN late.late_kg ELSE 0 END`
    : sql`total_weight_kg::numeric`;
  const mixCostExpr = knownAt
    ? sql`total_cost::numeric - CASE WHEN late.known_rows > 0 THEN late.late_cost ELSE 0 END`
    : sql`total_cost::numeric`;

  // Read original + carry-forward batches for physical remaining inventory.
  // Only originals count as fresh input in the old cumulative-rate baseline.
  const [mixResult, baleResult] = await Promise.all([
    db.execute(sql`
      SELECT factory_mix_batches.id,
             ${mixKgExpr} AS total_weight_kg,
             ${mixCostExpr} AS total_cost,
             used_kg::numeric AS used_kg,
             carry_forward_from_id,
             NOT ${throughRecorded("factory_mix_batches.updated_at")} AS needs_replay
      FROM factory_mix_batches
      ${lateSources}
      WHERE company_id = ${companyId}
        AND ${notDeleted("factory_mix_batches.deleted_at")}
        ${throughDate ? sql`AND COALESCE(batch_date, DATE(created_at)) <= ${throughDate}
          AND ${throughRecorded("factory_mix_batches.created_at")}` : sql``}
    `),
    db.execute(sql`
      SELECT COALESCE(SUM(b.weight_kg::numeric), 0) AS total_kg
      FROM factory_bales b
      WHERE b.company_id = ${companyId}
        ${
          knownAt
            ? sql`AND NOT (b.status IN ('DELETED', 'REMOVED', 'REPACKED') AND ${recorded("b.updated_at")})
                AND ${notDeleted("b.deleted_at")} AND ${recorded("b.created_at")}`
            : sql`AND b.status NOT IN ('DELETED', 'REMOVED', 'REPACKED')`
        }
        ${throughDate ? sql`AND COALESCE(DATE(b.stock_entry_date), DATE(b.created_at)) <= ${throughDate}
          AND ${throughRecorded("b.created_at")}` : sql``}
    `),
  ]);

  const batches = resultRows<MixRow>(mixResult);
  const baleKg = new BatchRateDecimal(String((resultRows(baleResult)[0] ?? {}).total_kg ?? "0"));
  const cumulativeOriginalWeight = batches
    .filter((batch) => batch.carry_forward_from_id == null)
    .reduce((sum, row) => sum.plus(row.total_weight_kg), new BatchRateDecimal(0));
  const cumulativeOriginalCost = batches
    .filter((batch) => batch.carry_forward_from_id == null)
    .reduce((sum, row) => sum.plus(row.total_cost), new BatchRateDecimal(0));
  const cumulativeRate = calculateCumulativeBatchRate({
    cumulativeMixCost: cumulativeOriginalCost,
    cumulativeMixWeightKg: cumulativeOriginalWeight,
  });

  // A batch changed after the cutoff must not use its current used_kg as a
  // historical quantity. Reconstruct recorded production/transfer/usage up to
  // the cutoff. Legacy edits without event history are flagged as inferred.
  const inferredIds = batches.filter((row) => row.needs_replay).map((row) => Number(row.id));
  let consumption = new Map<number, ConsumptionRow>();
  if (inferredIds.length && throughDate) {
    const ids = sql.join(inferredIds.map((id) => sql`${id}`), sql`, `);
    const replayResult = await db.execute(sql`
      SELECT batch_id, COALESCE(SUM(kg), 0) AS used_kg,
             BOOL_OR(is_carry) AS has_carry
      FROM (
        SELECT b.mix_batch_id AS batch_id, SUM(b.weight_kg::numeric) AS kg, FALSE AS is_carry
        FROM factory_bales b
        WHERE b.company_id = ${companyId} AND b.mix_batch_id IN (${ids})
          ${knownAt
            ? sql`AND NOT (b.status IN ('DELETED', 'REMOVED', 'REPACKED') AND ${recorded("b.updated_at")})
              AND ${notDeleted("b.deleted_at")} AND ${recorded("b.created_at")}`
            : sql`AND b.status NOT IN ('DELETED', 'REMOVED', 'REPACKED')`}
          AND COALESCE(DATE(b.stock_entry_date), DATE(b.created_at)) <= ${throughDate}
          AND ${throughRecorded("b.created_at")}
        GROUP BY b.mix_batch_id
        UNION ALL
        SELECT ms.source_batch_id AS batch_id, SUM(ms.weight_kg::numeric) AS kg, FALSE AS is_carry
        FROM factory_mix_batch_sources ms
        INNER JOIN factory_mix_batches child ON child.id = ms.mix_batch_id AND child.company_id = ${companyId}
        WHERE ms.source_batch_id IN (${ids})
          AND ${throughRecorded("ms.created_at")}
          AND ${throughRecorded("child.created_at")}
          AND COALESCE(child.batch_date, DATE(child.created_at)) <= ${throughDate}
          AND ${notDeleted("child.deleted_at")}
        GROUP BY ms.source_batch_id
        UNION ALL
        SELECT u.mix_batch_id AS batch_id, SUM(u.kg_used::numeric) AS kg, FALSE AS is_carry
        FROM factory_daily_usages u
        WHERE u.company_id = ${companyId} AND u.mix_batch_id IN (${ids})
          AND u.used_date <= ${throughDate} AND ${throughRecorded("u.created_at")}
        GROUP BY u.mix_batch_id
        UNION ALL
        SELECT cf.carry_forward_from_id AS batch_id, 0::numeric AS kg, TRUE AS is_carry
        FROM factory_mix_batches cf
        WHERE cf.company_id = ${companyId} AND cf.carry_forward_from_id IN (${ids})
          AND ${throughRecorded("cf.created_at")}
          AND COALESCE(cf.batch_date, DATE(cf.created_at)) <= ${throughDate}
          AND ${notDeleted("cf.deleted_at")}
      ) events
      GROUP BY batch_id
    `);
    consumption = new Map(
      resultRows<ConsumptionRow>(replayResult).map((row) => [Number(row.batch_id), row])
    );
  }

  const reconciledRows = batches.map((batch) => {
    const event = consumption.get(Number(batch.id));
    const reconstructedUsed =
      batch.needs_replay && throughDate
        ? event?.has_carry
          ? batch.total_weight_kg // parent was closed when its carried child was created
          : (event?.used_kg ?? "0")
        : batch.used_kg;
    return {
      id: Number(batch.id),
      totalWeightKg: String(batch.total_weight_kg),
      totalCost: String(batch.total_cost),
      usedKg: String(reconstructedUsed),
    };
  });
  const valuation = calculateBatchRemainingValuation(reconciledRows);
  const legacyPhysicalKg = resolveProductionBalanceWeight({
    cumulativeMixWeightKg: cumulativeOriginalWeight,
    cumulativeBaleWeightKg: baleKg,
  });
  const diagnostics = {
    basis: "remaining-batch-cost" as const,
    valuedBatchCount: valuation.batches.length,
    inferredHistoricalBatchCount: inferredIds.length,
    invalidBatchCount: valuation.negativeOrOverusedBatches + valuation.invalidCostBatches,
    legacyWeightKg: legacyPhysicalKg.toNumber(),
    weightDifferenceKg: valuation.remainingWeight.minus(legacyPhysicalKg).toNumber(),
  };
  const warnings = [
    ...(inferredIds.length ? ["WIP_HISTORICAL_USAGE_INFERRED_FROM_EVENTS"] : []),
    ...(diagnostics.invalidBatchCount ? ["WIP_INVALID_BATCH_COST_OR_WEIGHT"] : []),
    ...(valuation.remainingWeight.minus(legacyPhysicalKg).abs().gt("0.001")
      ? ["WIP_BATCH_BALANCE_DIFFERS_FROM_LEGACY_GLOBAL_WEIGHT"] : []),
  ];

  return {
    weightKg: valuation.remainingWeight.toNumber(),
    costPerKg: valuation.weightedRate.toNumber(),
    value: valuation.remainingValue.toDecimalPlaces(2).toNumber(),
    // This retained cumulative rate remains the basis of the unchanged
    // Production Weight Cost/Profit calculation, not the Balance on Table rate.
    batchRateDecimal: cumulativeRate,
    baleWeightKg: baleKg.toNumber(),
    diagnostics,
    warnings,
  };
}
