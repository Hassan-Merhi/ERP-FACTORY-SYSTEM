import Decimal from "decimal.js";
import { pool } from "../../../db";
import type { ReplayQueryExecutor, ReplaySafetyGateDetails } from "./types";
import { previewHistoricalCostReplayWithExecutor as previewHistoricalCostReplayWithExecutorBase } from "./read-model";
import { loadReplayAuthoritativeInputDigest, type ReplayPreviewWithAuthoritativeDigest } from "./fingerprint";
import { normalizePreviewPersistedContainerTotals } from "./canonicalCostsV6";
import {
  applyReceiptAdjustmentAmbiguityBlocks,
  findReceiptAdjustmentAmbiguitySupplierIds,
} from "./timelineAmbiguityV6";
import { loadV7SafetyState } from "./securePreviewHelpers";

async function computeManualRawMaterialAsset(executor: ReplayQueryExecutor, companyId: number): Promise<number> {
  const [rawResult, adjustmentResult] = await Promise.all([
    executor.query<{ remaining_value_usd: string }>(
      `SELECT COALESCE(SUM(
          (frs.received_kg::numeric - frs.used_kg::numeric) *
          COALESCE(NULLIF(frs.cost_per_kg_usd::numeric, 0), frs.cost_per_kg::numeric, 0)
        ), 0) AS remaining_value_usd
       FROM factory_raw_stock frs
       JOIN factory_containers fc ON fc.id = frs.container_id
       WHERE frs.company_id = $1
         AND fc.company_id = $1
         AND fc.supplier_id IS NULL
         AND fc.status != 'DELETED'
         AND frs.deleted_at IS NULL
         AND fc.deleted_at IS NULL`,
      [companyId]
    ),
    executor.query<{
      id: number;
      type: string;
      kg: string;
      cost_per_kg: string;
      material_label: string | null;
    }>(
      `SELECT id, type, kg, cost_per_kg, material_label
       FROM factory_raw_material_adjustments
       WHERE company_id = $1
         AND supplier_id IS NULL
         AND deleted_at IS NULL
       ORDER BY date, created_at, id`,
      [companyId]
    ),
  ]);

  let total = new Decimal(rawResult.rows[0]?.remaining_value_usd ?? 0);
  const buckets = new Map<string, { kg: Decimal; value: Decimal }>();

  for (const row of adjustmentResult.rows) {
    const type = String(row.type).toUpperCase();
    if (type === "DEDUCT") continue;
    const key = row.material_label || "unknown";
    const bucket = buckets.get(key) ?? { kg: new Decimal(0), value: new Decimal(0) };
    const kg = new Decimal(row.kg ?? 0);
    const cost = new Decimal(row.cost_per_kg ?? 0);

    if (type === "ADD") {
      bucket.kg = bucket.kg.plus(kg);
      bucket.value = bucket.value.plus(kg.times(cost));
    } else if (kg.gt(0)) {
      const average = bucket.kg.gt(0) ? bucket.value.div(bucket.kg) : new Decimal(0);
      bucket.kg = bucket.kg.minus(kg);
      bucket.value = bucket.value.minus(kg.times(average));
    }
    buckets.set(key, bucket);
  }

  for (const bucket of buckets.values()) total = total.plus(bucket.value);
  return total.toDecimalPlaces(2).toNumber();
}

function allSafetyGatesPassed(details: ReplaySafetyGateDetails): boolean {
  return (
    details.unresolvedInventorySupplierSources === 0 &&
    details.unclassifiedValuedAdjustments === 0 &&
    details.unresolvedFx === 0 &&
    details.missingDates === 0 &&
    details.quantityTimelineMismatches === 0 &&
    details.ambiguousEventOrdering === 0 &&
    details.incompleteMixedBatchSupplierScopes === 0 &&
    details.missingSupplierTimelines === 0 &&
    details.blockedBatches === 0 &&
    details.scanCoverageError === false
  );
}

export async function previewHistoricalCostReplayWithExecutor(
  executor: ReplayQueryExecutor,
  companyId: number
): Promise<ReplayPreviewWithAuthoritativeDigest> {
  const [basePreview, authoritative, ambiguousSupplierIds] = await Promise.all([
    previewHistoricalCostReplayWithExecutorBase(executor, companyId),
    loadReplayAuthoritativeInputDigest(executor, companyId),
    findReceiptAdjustmentAmbiguitySupplierIds(executor, companyId),
  ]);
  const persistedTargetPreview = await normalizePreviewPersistedContainerTotals(executor, companyId, basePreview);
  const preview = applyReceiptAdjustmentAmbiguityBlocks(persistedTargetPreview, ambiguousSupplierIds);

  const [safety, manualRawMaterialAsset] = await Promise.all([
    loadV7SafetyState(executor, companyId, preview),
    computeManualRawMaterialAsset(executor, companyId),
  ]);
  preview.summary.unresolvedInventorySupplierSources = safety.gateDetails.unresolvedInventorySupplierSources;
  preview.summary.unclassifiedValuedAdjustments = safety.gateDetails.unclassifiedValuedAdjustments;
  preview.summary.incompleteMixedBatchSupplierScopes = safety.gateDetails.incompleteMixedBatchSupplierScopes;
  preview.summary.missingSupplierTimelines = safety.gateDetails.missingSupplierTimelines;
  preview.summary.blockedBatches = safety.gateDetails.blockedBatches;
  preview.blockedBatches = safety.blockedBatches;
  preview.unclassifiedAdjustmentRows = safety.unclassifiedAdjustmentRows;
  preview.missingSupplierTimelineRows = safety.missingSupplierTimelineRows;

  if (preview.financialImpact) {
    const supplierImpacts = preview.supplierRows.map((row) => {
      const currentValue = new Decimal(row.authoritativeRemainingKg)
        .times(row.currentStoredRate)
        .toDecimalPlaces(2)
        .toNumber();
      const projectedValue = new Decimal(row.replayRemainingKg)
        .times(row.endingExpectedRate)
        .toDecimalPlaces(2)
        .toNumber();
      return {
        supplierId: row.supplierId,
        supplierName: row.supplierName,
        authoritativeRemainingKg: row.authoritativeRemainingKg,
        replayRemainingKg: row.replayRemainingKg,
        currentStoredRate: row.currentStoredRate,
        endingExpectedRate: row.endingExpectedRate,
        currentValue,
        projectedValue,
        valueDifference: new Decimal(projectedValue).minus(currentValue).toDecimalPlaces(2).toNumber(),
      };
    });
    const currentSupplierAsset = supplierImpacts.reduce((sum, row) => sum.plus(row.currentValue), new Decimal(0));
    const projectedSupplierAsset = supplierImpacts.reduce((sum, row) => sum.plus(row.projectedValue), new Decimal(0));
    const currentRawMaterialAsset = currentSupplierAsset.plus(manualRawMaterialAsset).toDecimalPlaces(2).toNumber();
    const projectedRawMaterialAsset = projectedSupplierAsset.plus(manualRawMaterialAsset).toDecimalPlaces(2).toNumber();
    const rawMaterialDifference = new Decimal(projectedRawMaterialAsset)
      .minus(currentRawMaterialAsset)
      .toDecimalPlaces(2)
      .toNumber();

    preview.financialImpact.supplierImpacts = supplierImpacts;
    preview.financialImpact.currentRawMaterialAsset = currentRawMaterialAsset;
    preview.financialImpact.projectedRawMaterialAsset = projectedRawMaterialAsset;
    preview.financialImpact.rawMaterialDifference = rawMaterialDifference;
    preview.financialImpact.safetyGateDetails = safety.gateDetails;
    preview.financialImpact.allSafetyGatesPassed = allSafetyGatesPassed(safety.gateDetails);
    preview.financialImpact.otherLedgerEffect = 0;
    if (preview.financialImpact.currentNetPosition != null) {
      preview.financialImpact.projectedNetPosition = new Decimal(preview.financialImpact.currentNetPosition)
        .plus(rawMaterialDifference)
        .toDecimalPlaces(2)
        .toNumber();
    }
  }

  return Object.assign(preview, {
    authoritativeInputDigest: authoritative.digest,
    authoritativeInputCounts: authoritative.counts,
  });
}

export async function previewHistoricalCostReplay(companyId: number): Promise<ReplayPreviewWithAuthoritativeDigest> {
  return previewHistoricalCostReplayWithExecutor(pool as ReplayQueryExecutor, companyId);
}
