// Extracted from ./baleRecost.ts to keep that module under the source-size cap.
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { FACTORY_COST_SCALE } from "./baleCostBasis";

export const FACTORY_BALE_RECOST_MOVED_MESSAGE =
  "Bale costs are now changed only through the reviewed re-cost: preview the plan, then an Owner confirms it.";

/** `POST /api/factory/raw-stock/update-cost` retired (accounting audit phase 19 C). */
export const FACTORY_RAW_COST_UPDATE_RETIRED_MESSAGE =
  "A supplier's cost per kg is no longer changed here. Bale and mix costs are changed only through the reviewed re-cost: preview the plan, then an Owner confirms it.";

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
  eligibility: "unsold-stock" | "sold-on-uninvoiced-verified-order";
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
    readonly code: "PLAN_CHANGED" | "NOTHING_TO_APPLY" | "VERIFIED_SOLD_CONFIRM_REQUIRED",
    message: string
  ) {
    super(message);
    this.name = "BaleRecostRefusal";
  }
}

export const todayUtc = () => new Date().toISOString().slice(0, 10);

export const fixed = (value: Decimal) => value.toDecimalPlaces(FACTORY_COST_SCALE).toFixed(FACTORY_COST_SCALE);

export async function rows<T>(tx: DbTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(query)).rows as unknown as T[];
}

export interface SourceRow {
  id: number;
  mix_batch_id: number;
  container_id: number | null;
  supplier_id: number | null;
  source_batch_id: number | null;
  weight_kg: string;
  cost_per_kg: string;
}

export interface MixRow {
  id: number;
  batch_code: string;
  status: string;
  total_weight_kg: string;
  used_kg: string;
  cost_per_kg: string;
  total_cost: string;
}
