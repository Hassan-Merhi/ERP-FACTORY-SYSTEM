/**
 * Read-only valuation helpers for historical Factory mix batches.
 *
 * IMPORTANT: the batch's saved total_cost is authoritative for display.
 * Never rebuild historical values using today's supplier locked rate.
 * New/edit source pricing is a separate prospective calculation.
 */
export type RecordedNumber = number | string | null | undefined;

export interface RecordedMixBatchInput {
  totalWeightKg: RecordedNumber;
  totalCost: RecordedNumber;
  costPerKg?: RecordedNumber;
}

export interface RecordedCostSummary {
  totalWeightKg: number;
  totalCost: number;
  costPerKg: number;
}

function amount(value: RecordedNumber): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Stored total cost / stored weight, never current supplier rates. */
export function recordedMixBatchCost(batch: RecordedMixBatchInput): RecordedCostSummary {
  const totalWeightKg = amount(batch.totalWeightKg);
  const totalCost = amount(batch.totalCost);
  return {
    totalWeightKg,
    totalCost,
    costPerKg: totalWeightKg > 0 ? totalCost / totalWeightKg : amount(batch.costPerKg),
  };
}

/** Sum recorded batch total costs, avoiding rounded rate × kg accumulation. */
export function summarizeRecordedMixBatches(batches: readonly RecordedMixBatchInput[]): RecordedCostSummary {
  let totalWeightKg = 0;
  let totalCost = 0;
  for (const batch of batches) {
    totalWeightKg += amount(batch.totalWeightKg);
    totalCost += amount(batch.totalCost);
  }
  return { totalWeightKg, totalCost, costPerKg: totalWeightKg > 0 ? totalCost / totalWeightKg : 0 };
}

/** For showing the recorded source breakdown, including historical zero-rate sources. */
export function summarizeRecordedMixSources(
  sources: readonly { weightKg: RecordedNumber; totalCost: RecordedNumber }[]
): RecordedCostSummary {
  let totalWeightKg = 0;
  let totalCost = 0;
  for (const source of sources) {
    totalWeightKg += amount(source.weightKg);
    totalCost += amount(source.totalCost);
  }
  return { totalWeightKg, totalCost, costPerKg: totalWeightKg > 0 ? totalCost / totalWeightKg : 0 };
}
