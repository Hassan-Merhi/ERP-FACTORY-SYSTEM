/**
 * Authoritative Balance on Table snapshot for both Overview → Production and
 * Factory Net Position. Keep the same company/date, status exclusions, batch
 * cutoff and 10-decimal historical batch rate in every consumer.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { netPositionRecordedThrough } from "./netPositionAsOf";
import { resultRows } from "../../lib/queryResult";
import {
  BatchRateDecimal,
  calculateCumulativeBatchRate,
  resolveProductionBalanceWeight,
} from "../../routes/factory/bale-exports/production-value-math";

export async function getFactoryBalanceOnTableSnapshot(
  companyId: number,
  throughDate?: string | null,
  knownAt?: FactoryNetPositionAsOf
) {
  const recorded = (column: string) =>
    knownAt ? netPositionRecordedThrough(sql.raw(column), knownAt, "utc-naive-timestamp") : sql`TRUE`;
  const notDeleted = (column: string) =>
    knownAt ? sql`(${sql.raw(column)} IS NULL OR NOT ${recorded(column)})` : sql`${sql.raw(column)} IS NULL`;
  // Historical dates: a top-up or edit recorded after the cutoff added source
  // rows to an existing batch and raised its stored totals; take those rows
  // back out. A batch whose every source row post-dates the cutoff was
  // re-created by an edit and keeps its (edited) stored totals.
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
  const [mixResult, baleResult] = await Promise.all([
    db.execute(sql`
      SELECT
        COALESCE(SUM(${mixKgExpr}), 0) AS total_mix_kg,
        COALESCE(SUM(${mixCostExpr}), 0) AS total_mix_cost
      FROM factory_mix_batches
      ${lateSources}
      WHERE company_id = ${companyId}
        AND carry_forward_from_id IS NULL
        AND ${notDeleted("factory_mix_batches.deleted_at")}
        ${knownAt ? sql`AND ${recorded("factory_mix_batches.created_at")}` : sql``}
        ${throughDate ? sql`AND COALESCE(batch_date, DATE(created_at)) <= ${throughDate}` : sql``}
    `),
    db.execute(sql`
      SELECT COALESCE(SUM(b.weight_kg::numeric), 0) AS total_kg
      FROM factory_bales b
      WHERE b.company_id = ${companyId}
        ${
          knownAt
            ? // Same exclusions as today, applied to bales whose status was
              // already set by the cutoff (every status change writes
              // updated_at). A later repack/removal was still on the books then;
              // its replacement bale is created later and is not counted.
              sql`AND NOT (b.status IN ('DELETED', 'REMOVED', 'REPACKED') AND ${recorded("b.updated_at")})
                AND ${notDeleted("b.deleted_at")} AND ${recorded("b.created_at")}`
            : sql`AND b.status NOT IN ('DELETED', 'REMOVED', 'REPACKED')`
        }
        ${throughDate ? sql`AND COALESCE(DATE(b.stock_entry_date), DATE(b.created_at)) <= ${throughDate}` : sql``}
    `),
  ]);

  const mix = resultRows(mixResult)[0] ?? {};
  const bales = resultRows(baleResult)[0] ?? {};
  const mixKg = new BatchRateDecimal(String(mix.total_mix_kg ?? "0"));
  const mixCost = new BatchRateDecimal(String(mix.total_mix_cost ?? "0"));
  const baleKg = new BatchRateDecimal(String(bales.total_kg ?? "0"));
  const batchRateDecimal = calculateCumulativeBatchRate({
    cumulativeMixCost: mixCost,
    cumulativeMixWeightKg: mixKg,
  });
  const weightDecimal = resolveProductionBalanceWeight({
    cumulativeMixWeightKg: mixKg,
    cumulativeBaleWeightKg: baleKg,
  });

  return {
    weightKg: weightDecimal.toNumber(),
    costPerKg: batchRateDecimal.toNumber(),
    value: weightDecimal.times(batchRateDecimal).toDecimalPlaces(2).toNumber(),
    batchRateDecimal,
    baleWeightKg: baleKg.toNumber(),
  };
}
