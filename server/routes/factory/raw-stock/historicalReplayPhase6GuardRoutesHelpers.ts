// Extracted from ./historicalReplayPhase6GuardRoutes.ts
import { pool } from "../../../db";
import {
  type HistoricalReplayPreviewResult,
  type ReplayFinancialImpact,
} from "../../../services/factory/historicalCostReplay";
import { toMoney } from "../../../lib/money";

export const APPLY_PATH = "/api/factory/raw-stock/recalc/historical-replay/apply";

export const PREVIEW_PATH = "/api/factory/raw-stock/recalc/historical-replay";

export const ADJUSTMENT_CLASSIFICATION_PATH =
  "/api/factory/raw-stock/recalc/historical-replay/adjustments/:id/valuation-basis";

export const ADMIN_ROLES = ["Admin", "Developer"] as const;

interface BatchCostImpact {
  batchId: number;
  batchCode: string;
  currentTotalCost: number;
  projectedTotalCost: number;
  valueDifference: number;
}

interface BalanceProjectionBase {
  totalMixWeightKg: number;
  balanceOnTableWeightKg: number;
  currentTotalMixCost: number;
  currentBalanceOnTableAsset: number;
  batchImpacts: BatchCostImpact[];
}

export interface SignedReplayScopeToken {
  scope?: {
    batchIdsToUpdate?: number[];
  };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export async function readCurrentNetPosition(req: import("express").Request): Promise<number | null> {
  try {
    const port = Number(process.env.PORT || 5000);
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || typeof fetch !== "function") {
      return null;
    }
    // Use a fixed loopback origin rather than the request Host header. This keeps the
    // read-only projection independent of proxy/Host input and preserves the user's
    // authenticated session through the forwarded cookie.
    const response = await fetch(`http://127.0.0.1:${port}/api/factory/net-position`, {
      method: "GET",
      headers: {
        cookie: String(req.headers?.cookie || ""),
        accept: "application/json",
      },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { netPosition?: unknown };
    const value = Number(payload.netPosition);
    return Number.isFinite(value) ? value : null;
  } catch {
    // Financial impact remains useful even when the independent Net Position route
    // cannot be reached (for example during isolated tests or before HTTP startup).
    return null;
  }
}

export async function loadBalanceProjectionBase(
  companyId: number,
  preview: HistoricalReplayPreviewResult
): Promise<BalanceProjectionBase> {
  const [mixResult, baleResult] = await Promise.all([
    pool.query<{
      total_mix_kg: string;
      total_mix_cost: string;
    }>(
      `SELECT COALESCE(SUM(total_weight_kg::numeric), 0) AS total_mix_kg,
              COALESCE(SUM(total_cost::numeric), 0) AS total_mix_cost
       FROM factory_mix_batches
       WHERE company_id = $1
         AND carry_forward_from_id IS NULL
         AND deleted_at IS NULL`,
      [companyId]
    ),
    pool.query<{ total_bale_kg: string }>(
      `SELECT COALESCE(SUM(weight_kg::numeric), 0) AS total_bale_kg
       FROM factory_bales
       WHERE company_id = $1
         AND status NOT IN ('DELETED', 'REMOVED')`,
      [companyId]
    ),
  ]);

  const totalMixWeightKg = toMoney(mixResult.rows[0]?.total_mix_kg).toNumber();
  const currentTotalMixCost = toMoney(mixResult.rows[0]?.total_mix_cost).toNumber();
  const totalBaleWeightKg = toMoney(baleResult.rows[0]?.total_bale_kg).toNumber();
  const balanceOnTableWeightKg = Math.max(totalMixWeightKg - totalBaleWeightKg, 0);
  const currentRate = totalMixWeightKg > 0 ? currentTotalMixCost / totalMixWeightKg : 0;
  const currentBalanceOnTableAsset = round2(balanceOnTableWeightKg * currentRate);

  const batchImpacts: BatchCostImpact[] = preview.batchRows.map((row) => ({
    batchId: row.batchId,
    batchCode: row.batchCode,
    currentTotalCost: row.storedTotalCost,
    projectedTotalCost: row.expectedTotalCost,
    valueDifference: round2(row.expectedTotalCost - row.storedTotalCost),
  }));

  return {
    totalMixWeightKg,
    balanceOnTableWeightKg,
    currentTotalMixCost,
    currentBalanceOnTableAsset,
    batchImpacts,
  };
}

function projectBalanceOnTable(
  base: BalanceProjectionBase,
  batchIds: number[]
): {
  currentBalanceOnTableAsset: number;
  projectedBalanceOnTableAsset: number;
  balanceOnTableDifference: number;
  otherNetPositionEffect: number;
  batchImpacts: BatchCostImpact[];
} {
  const selected = new Set(batchIds);
  const batchImpacts = base.batchImpacts.filter((row) => selected.has(row.batchId));
  const mixCostDifference = batchImpacts.reduce((sum, row) => sum + row.valueDifference, 0);
  const projectedTotalMixCost = base.currentTotalMixCost + mixCostDifference;
  const projectedRate = base.totalMixWeightKg > 0 ? projectedTotalMixCost / base.totalMixWeightKg : 0;
  const projectedBalanceOnTableAsset = round2(base.balanceOnTableWeightKg * projectedRate);
  const balanceOnTableDifference = round2(projectedBalanceOnTableAsset - base.currentBalanceOnTableAsset);

  return {
    currentBalanceOnTableAsset: base.currentBalanceOnTableAsset,
    projectedBalanceOnTableAsset,
    balanceOnTableDifference,
    otherNetPositionEffect: balanceOnTableDifference,
    batchImpacts,
  };
}

export function scopeFinancialImpact(
  preview: HistoricalReplayPreviewResult,
  supplierIds: number[],
  batchIds: number[],
  currentNetPosition: number | null,
  balanceBase: BalanceProjectionBase
): ReplayFinancialImpact | undefined {
  const base = preview.financialImpact;
  if (!base) return undefined;

  const selected = new Set(supplierIds);
  const supplierImpacts = base.supplierImpacts.filter((row) => selected.has(row.supplierId));
  const rawMaterialDifference = round2(supplierImpacts.reduce((sum, row) => sum + row.valueDifference, 0));
  const projectedRawMaterialAsset = round2(base.currentRawMaterialAsset + rawMaterialDifference);
  const balance = projectBalanceOnTable(balanceBase, batchIds);
  const totalNetPositionEffect = round2(rawMaterialDifference + balance.otherNetPositionEffect);

  return {
    ...base,
    supplierImpacts,
    rawMaterialDifference,
    projectedRawMaterialAsset,
    currentNetPosition,
    projectedNetPosition: currentNetPosition == null ? null : round2(currentNetPosition + totalNetPositionEffect),
    otherLedgerEffect: 0,
    ...balance,
    totalNetPositionEffect,
  } as ReplayFinancialImpact;
}
