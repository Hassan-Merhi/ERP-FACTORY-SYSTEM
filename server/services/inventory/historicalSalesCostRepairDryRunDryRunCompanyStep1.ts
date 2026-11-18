// Extracted from ./historicalSalesCostRepairDryRun.ts to keep that module under the source-size cap.
import type { PoolClient } from "pg";
import {
  historicalInventoryKey,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
  repairQuantity,
} from "./historicalSalesCostRepairEngine";
import {
  d,
  HISTORICAL_VALUATION_RESETS,
  InventoryRow,
  iso,
  LegacyRow,
  OFFLOAD_EVIDENCE_SOURCE_TYPES,
  offloadEvidenceKey,
  RepairCheck,
  REWIND_TRACE_LIMIT,
} from "./historicalSalesCostRepairTypes";
import {
  loadCanonicalMovements,
  loadCanonicalStart,
  loadHistoricalMerges,
  loadLegacyManualAdjustments,
  loadLegacyMovements,
  loadOffloadValueEvidence,
  loadSales,
  loadStockItems,
  loadValuationCheckpoint,
  loadValuationOverrides,
} from "./historicalSalesCostRepairLoaders";
import {
  activeCanonicalSaleEvidence,
  droppedPosLineMovements,
  historicalSalesCompanyEvidenceHash,
  journalWithoutOverriddenLocationUpdates,
} from "./historicalSalesCostRepairEvidence";
import { classifyCompanySales } from "./historicalSalesCostRepairSales";

export async function dryRunCompanyStep1(
  client: PoolClient,
  companyId: number,
  sourceCutoff: Date,
  options: { diagnoseKeys?: Set<string> } = {}
) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`historical-sales-cost-repair:${companyId}`]);
  // V40 diagnostics: the checkpoint rewind trace per item/location, newest
  // first, so a blocked group can be read movement by movement. Read-only.
  const rewindTrace = new Map<string, string[]>();
  const traceRewind = (key: string, line: string) => {
    const lines = rewindTrace.get(key) ?? [];
    lines.push(line);
    if (!options.diagnoseKeys?.has(key) && lines.length > REWIND_TRACE_LIMIT) lines.shift();
    rewindTrace.set(key, lines);
  };

  const [inventoryResult, stockItems, canonicalStart, sales, checkpoint, offloadEvidence, historicalMerges] =
    await Promise.all([
      client.query<InventoryRow>(
        `SELECT i.location_id,i.stock_item_id,i.quantity::text,i.average_rate::text,i.total_value::text
         FROM inventory i
         JOIN locations l
           ON l.id=i.location_id
          AND l.company_id=i.company_id
          AND l.deleted_at IS NULL
        WHERE i.company_id=$1
        ORDER BY i.location_id,i.stock_item_id`,
        [companyId]
      ),
      loadStockItems(client, companyId),
      loadCanonicalStart(client, companyId, sourceCutoff),
      loadSales(client, companyId, sourceCutoff),
      loadValuationCheckpoint(client, companyId),
      loadOffloadValueEvidence(client, companyId, sourceCutoff),
      loadHistoricalMerges(client, companyId),
    ]);

  const [loadedCanonical, legacy, manual, valuationOverrides] = await Promise.all([
    loadCanonicalMovements(client, companyId, canonicalStart, sourceCutoff),
    loadLegacyMovements(client, companyId, canonicalStart, sourceCutoff),
    loadLegacyManualAdjustments(client, companyId, canonicalStart, sourceCutoff),
    loadValuationOverrides(client, companyId, sourceCutoff),
  ]);
  const journalCanonical = journalWithoutOverriddenLocationUpdates(loadedCanonical, valuationOverrides);

  const sourceEvidenceHash = historicalSalesCompanyEvidenceHash({
    companyId,
    canonicalStart,
    checkpoint,
    canonical: journalCanonical,
    legacy,
    manual,
    sales,
    stockItems,
    offloadEvidence,
    historicalMerges,
    valuationOverrides,
  });
  // Derived from hashed evidence (the journal and the sales lines), so the
  // restored lines need no hash entry of their own.
  const droppedPosLines = droppedPosLineMovements(companyId, journalCanonical, sales);
  const canonical = [...journalCanonical, ...droppedPosLines.movements];
  const offloadEvidenceByKey = new Map(
    offloadEvidence.map((row) => [offloadEvidenceKey(row.offload_id, row.stock_item_id), row])
  );
  for (const movement of canonical) {
    if (!OFFLOAD_EVIDENCE_SOURCE_TYPES.has(movement.sourceType)) continue;
    const evidence = offloadEvidenceByKey.get(offloadEvidenceKey(movement.sourceId, movement.stockItemId));
    if (evidence) movement.exactValue = String(evidence.total_value);
  }

  const checks: RepairCheck[] = [
    ...manual.checks,
    ...droppedPosLines.checks,
    {
      companyId,
      locationId: null,
      stockItemId: null,
      code: "V2_SOURCE_EVIDENCE_HASH",
      status: "pass",
      expected: sourceEvidenceHash,
      actual: sourceEvidenceHash,
      detail:
        "Pins Phase 3 checkpoint rows/cutoff, canonical and legacy movements, historical merge aliases, source openings, and target sale originals",
    },
  ];
  const pinnedOffloadRows = legacy.filter((row) => row.source_type === "legacy-container-offload" && row.mutation_at);
  checks.push({
    companyId,
    locationId: null,
    stockItemId: null,
    code: "LEGACY_OFFLOAD_ENTRY_TIME_PINNED",
    status: "pass",
    expected: String(legacy.filter((row) => row.source_type === "legacy-container-offload").length),
    actual: String(pinnedOffloadRows.length),
    detail:
      "Legacy offload item rows ordered at their charge-voucher transaction time (unique container offload, single voucher group, millisecond stamp agrees with created_at); the rest keep offloaded_at",
  });
  for (const reset of HISTORICAL_VALUATION_RESETS.filter((candidate) => candidate.companyId === companyId)) {
    checks.push({
      companyId,
      locationId: reset.locationId,
      stockItemId: reset.stockItemId,
      code: "WAVE6_VALUATION_RESET_EVIDENCE",
      status: "pass",
      expected: reset.afterQuantity + "|" + reset.afterAverageRate + "|" + reset.afterTotalValue,
      actual: reset.beforeQuantity + "|" + reset.beforeAverageRate + "|" + reset.beforeTotalValue,
      detail:
        "Exact guarded Wave 6 production valuation reset is included as an immutable replay boundary and source-hash input.",
    });
  }

  const canonicalSaleEvidence = activeCanonicalSaleEvidence(canonical);
  const canonicalSaleKeys = new Set(canonicalSaleEvidence.keys());
  const toLegacyMovement = (row: LegacyRow): HistoricalSalesRepairMovement => ({
    movementId: row.movement_id,
    companyId,
    locationId: Number(row.location_id),
    stockItemId: Number(row.stock_item_id),
    occurredAt: iso(row.occurred_at),
    ...(row.mutation_at ? { createdAt: iso(row.mutation_at) } : {}),
    sequence: Number(row.sequence),
    quantityDelta: String(row.quantity_delta),
    unitCost: row.unit_cost === null ? null : String(row.unit_cost),
    exactValue: OFFLOAD_EVIDENCE_SOURCE_TYPES.has(row.source_type)
      ? (offloadEvidenceByKey.get(offloadEvidenceKey(row.source_id, row.stock_item_id))?.total_value ?? null)
      : null,
    sourceType: row.source_type,
    sourceId: row.source_id,
    evidence: "legacy" as const,
  });
  const legacyTransferFallbackMovements = legacy
    .filter((row) => row.source_type.endsWith("-flag-fallback"))
    .map(toLegacyMovement);
  const valuationResetMovements: HistoricalSalesRepairMovement[] = HISTORICAL_VALUATION_RESETS.filter(
    (reset) => reset.companyId === companyId
  ).map((reset, index) => ({
    movementId: `valuation-reset:${reset.sourceId}`,
    companyId: reset.companyId,
    locationId: reset.locationId,
    stockItemId: reset.stockItemId,
    occurredAt: reset.occurredAt,
    createdAt: reset.occurredAt,
    sequence: 900_000_000 + index,
    quantityDelta: "0.000",
    unitCost: null,
    valuationReset: {
      beforeQuantity: reset.beforeQuantity,
      beforeAverageRate: reset.beforeAverageRate,
      beforeTotalValue: reset.beforeTotalValue,
      afterQuantity: reset.afterQuantity,
      afterAverageRate: reset.afterAverageRate,
      afterTotalValue: reset.afterTotalValue,
    },
    sourceType: "inventory-valuation-wave6-reset",
    sourceId: reset.sourceId,
    evidence: "legacy" as const,
  }));
  valuationResetMovements.push(
    ...valuationOverrides.map((row) => ({
      movementId: `valuation-override:${row.id}`,
      companyId,
      locationId: Number(row.location_id),
      stockItemId: Number(row.stock_item_id),
      occurredAt: iso(row.created_at),
      createdAt: iso(row.created_at),
      sequence: Number(row.id) * 10 + 9,
      quantityDelta: repairQuantity(d(row.after_quantity).minus(d(row.before_quantity))).toFixed(3),
      unitCost: null,
      valuationReset: {
        beforeQuantity: String(row.before_quantity),
        beforeAverageRate: String(row.before_average_rate),
        beforeTotalValue: String(row.before_total_value),
        afterQuantity: String(row.after_quantity),
        afterAverageRate: String(row.after_average_rate),
        afterTotalValue: String(row.after_total_value),
      },
      sourceType: "inventory-valuation-override",
      sourceId: `${row.source_type}:${row.id}`,
      evidence: "legacy" as const,
    }))
  );

  const legacyMovements: HistoricalSalesRepairMovement[] = [
    ...legacy.filter((row) => !row.source_type.endsWith("-flag-fallback")).map(toLegacyMovement),
    ...valuationResetMovements,
    ...manual.movements.map((row) => ({
      movementId: row.movement_id,
      companyId,
      locationId: Number(row.location_id),
      stockItemId: Number(row.stock_item_id),
      occurredAt: iso(row.occurred_at),
      sequence: Number(row.sequence),
      quantityDelta: String(row.quantity_delta),
      unitCost: row.unit_cost === null ? null : String(row.unit_cost),
      sourceType: row.source_type,
      sourceId: row.source_id,
      evidence: "legacy" as const,
    })),
  ];

  const { directCanonicalProposals, canonicalForReplay, normalizedCanonicalPosReplay, legacySales } =
    classifyCompanySales({
      companyId,
      sales,
      canonicalStart,
      canonical,
      checks,
      canonicalSaleEvidence,
      canonicalSaleKeys,
      legacyMovements,
    });

  const proposalsBySaleId = new Map<number, HistoricalSalesRepairProposal>();
  const closedEraProvenSaleIds = new Set<number>();
  // V53: per-location opening states where the checkpoint-implied location
  // openings sum exactly to the pinned item opening (no negative location),
  // valued at the pinned item opening rate.
  const evidencedOpeningStates = new Map<string, HistoricalInventoryState>();
  const targetKeys = new Set(
    legacySales
      .filter((sale) => sale.location_id !== null)
      .map((sale) => historicalInventoryKey(companyId, Number(sale.location_id), Number(sale.stock_item_id)))
  );
  return {
    canonical,
    canonicalForReplay,
    canonicalStart,
    checkpoint,
    checks,
    closedEraProvenSaleIds,
    directCanonicalProposals,
    evidencedOpeningStates,
    historicalMerges,
    inventoryResult,
    legacy,
    legacyMovements,
    legacySales,
    legacyTransferFallbackMovements,
    manual,
    normalizedCanonicalPosReplay,
    offloadEvidence,
    proposalsBySaleId,
    rewindTrace,
    sales,
    sourceEvidenceHash,
    stockItems,
    targetKeys,
    traceRewind,
    valuationResetMovements,
  };
}
