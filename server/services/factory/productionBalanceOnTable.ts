/**
 * Authoritative Balance on Table snapshot for both Overview → Production and
 * Factory Net Position. Keep the same company/date, status exclusions, batch
 * cutoff and 10-decimal historical batch rate in every consumer.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import {
  BatchRateDecimal,
  calculateCumulativeBatchRate,
  resolveProductionBalanceWeight,
} from "../../routes/factory/bale-exports/production-value-math";

export async function getFactoryBalanceOnTableSnapshot(companyId: number, throughDate?: string | null) {
  const [mixResult, baleResult] = await Promise.all([
    db.execute(sql`
      SELECT
        COALESCE(SUM(total_weight_kg::numeric), 0) AS total_mix_kg,
        COALESCE(SUM(total_cost::numeric), 0) AS total_mix_cost
      FROM factory_mix_batches
      WHERE company_id = ${companyId}
        AND carry_forward_from_id IS NULL
        AND deleted_at IS NULL
        ${throughDate ? sql`AND COALESCE(batch_date, DATE(created_at)) <= ${throughDate}` : sql``}
    `),
    db.execute(sql`
      SELECT COALESCE(SUM(b.weight_kg::numeric), 0) AS total_kg
      FROM factory_bales b
      WHERE b.company_id = ${companyId}
        AND b.status NOT IN ('DELETED', 'REMOVED', 'REPACKED')
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
