import { beforeEach, describe, expect, it, vi } from "vitest";

const readModel = vi.hoisted(() => ({
  previewHistoricalCostReplayWithExecutor: vi.fn(),
  buildBatchConsumptionEvents: vi.fn(),
  loadContainerUniverse: vi.fn(),
  computeCanonicalCosts: vi.fn(),
  computeBatchCorrections: vi.fn(),
}));

vi.mock("../server/db", () => ({ pool: { query: vi.fn() } }));
vi.mock("../server/services/factory/historical-replay/read-model", () => readModel);

import {
  buildHistoricalReplayScope,
  classifyBalesByFinalization,
  computeReplayWriteScope,
} from "../server/services/factory/historical-replay/scope";

function previewFixture() {
  return {
    summary: {
      totalReceivedContainers: 2,
      containersScanned: 2,
      omittedContainers: 0,
      canonicalContainerMismatches: 1,
      suppliersScanned: 2,
      safeSuppliers: 1,
      manualReviewSuppliers: 1,
      supplierPricedSourcesScanned: 4,
      sourceMismatches: 3,
      batchesToUpdate: 2,
      completedBatchesToUpdate: 1,
      balesToUpdate: 4,
      finalizedBalesToUpdate: 1,
      unresolvedFx: 1,
      missingDates: 0,
      quantityTimelineMismatches: 0,
      ambiguousEventOrdering: 0,
      scanCoverageError: false,
    },
    supplierRows: [
      { supplierId: 1, safeToRepair: true, endingExpectedRate: 1.2, replayRemainingKg: 10, authoritativeRemainingKg: 10, currentStoredRate: 1 },
      { supplierId: 2, safeToRepair: false, endingExpectedRate: 9, replayRemainingKg: 1, authoritativeRemainingKg: 2, currentStoredRate: 8 },
    ],
    containerRows: [
      { containerId: 90, supplierId: 1, fxUnresolved: false, safeToRepair: true, storedCostPerKgUsd: 1, canonicalCostPerKgUsd: 1.2, storedTotalUsd: 10, canonicalTotalUsd: 12 },
      { containerId: 91, supplierId: 1, fxUnresolved: true, safeToRepair: false, storedCostPerKgUsd: 1, canonicalCostPerKgUsd: 1, storedTotalUsd: 10, canonicalTotalUsd: 10 },
      { containerId: 92, supplierId: 2, fxUnresolved: false, safeToRepair: true, storedCostPerKgUsd: 8, canonicalCostPerKgUsd: 9, storedTotalUsd: 8, canonicalTotalUsd: 9 },
    ],
    batchRows: [
      { batchId: 10, status: "ACTIVE", storedCostPerKg: 1, expectedCostPerKg: 1.2, storedTotalCost: 10, expectedTotalCost: 12 },
      { batchId: 11, status: "COMPLETED", storedCostPerKg: 1, expectedCostPerKg: 1.2, storedTotalCost: 10, expectedTotalCost: 12 },
    ],
    sourceRows: [
      { sourceId: 100, batchId: 10, pricingBasis: "SUPPLIER_LOCKED_RATE", supplierId: 1, containerId: null, expectedHistoricalCostPerKg: 1.2, storedCostPerKg: 1, weightKg: 5, safeToRepair: true },
      { sourceId: 101, batchId: 10, pricingBasis: "CONTAINER_DIRECT", supplierId: null, containerId: 90, expectedHistoricalCostPerKg: 1.2, storedCostPerKg: 1, weightKg: 5, safeToRepair: true },
      { sourceId: 102, batchId: 10, pricingBasis: "CONTAINER_DIRECT", supplierId: null, containerId: 91, expectedHistoricalCostPerKg: 1.2, storedCostPerKg: 1, weightKg: 5, safeToRepair: true },
      { sourceId: 103, batchId: 10, pricingBasis: "SUPPLIER_LOCKED_RATE", supplierId: 1, containerId: null, expectedHistoricalCostPerKg: 1.2, storedCostPerKg: 1, weightKg: 5, safeToRepair: false },
      { sourceId: 110, batchId: 11, pricingBasis: "SUPPLIER_LOCKED_RATE", supplierId: 1, containerId: null, expectedHistoricalCostPerKg: 1.2, storedCostPerKg: 1, weightKg: 5, safeToRepair: true },
    ],
  };
}

describe("Phase 33D historical replay scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readModel.buildBatchConsumptionEvents.mockResolvedValue({ sourceInfos: [], batchInfoMap: new Map() });
    readModel.loadContainerUniverse.mockResolvedValue([]);
    readModel.computeCanonicalCosts.mockResolvedValue([
      {
        fxUnresolved: false,
        universe: { container: { id: 90, supplierId: 1 } },
        canonicalCostPerKgUsd: 1.2,
        canonicalTotalUsd: 12,
      },
      {
        fxUnresolved: true,
        universe: { container: { id: 91, supplierId: 1 } },
        canonicalCostPerKgUsd: 1,
        canonicalTotalUsd: 10,
      },
      {
        fxUnresolved: false,
        universe: { container: { id: 92, supplierId: 2 } },
        canonicalCostPerKgUsd: 9,
        canonicalTotalUsd: 9,
      },
    ]);
    readModel.computeBatchCorrections.mockReturnValue({
      corrections: [
        { batchId: 10, status: "ACTIVE" },
        { batchId: 11, status: "COMPLETED" },
      ],
      blockedBatches: [],
    });
  });

  it("limits write scope to safe suppliers, resolved containers, active corrected batches, and repairable sources", async () => {
    const preview = previewFixture();
    const query = vi.fn(async (text: string) => {
      if (String(text).includes("COUNT(*)")) return { rows: [{ cnt: "4" }] };
      return { rows: [] };
    });

    const scope = await computeReplayWriteScope(
      7,
      [1, 2],
      preview as any,
      { includeCompletedBatches: false, includeFinalizedBales: false },
      { query } as any
    );

    expect([...scope.safeSupplierIds]).toEqual([1]);
    expect([...scope.containerIds]).toEqual([90]);
    expect([...scope.batchIdsToApply]).toEqual([10]);
    expect([...scope.sourceIds].sort((a, b) => a - b)).toEqual([100, 101]);
    expect(scope.baleCount).toBe(4);
    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0][0])).toContain("customer_order_bales");
  });

  it("can include completed corrected batches and finalized bales only when explicitly requested", async () => {
    const preview = previewFixture();
    const query = vi.fn(async () => ({ rows: [{ cnt: "7" }] }));

    const scope = await computeReplayWriteScope(
      7,
      [1],
      preview as any,
      { includeCompletedBatches: true, includeFinalizedBales: true },
      { query } as any
    );

    expect([...scope.batchIdsToApply].sort((a, b) => a - b)).toEqual([10, 11]);
    expect([...scope.sourceIds].sort((a, b) => a - b)).toEqual([100, 101, 110]);
    expect(scope.baleCount).toBe(7);
    expect(String(query.mock.calls[0][0])).not.toContain("dispatch_batch_id IS NULL");
  });

  it("builds the full public scope from canonical rows and separates finalized bales", async () => {
    const preview = previewFixture();
    readModel.previewHistoricalCostReplayWithExecutor.mockResolvedValue(preview);
    readModel.buildBatchConsumptionEvents.mockResolvedValue({
      sourceInfos: [
        { sourceId: 100, batchId: 10, pricingBasis: "SUPPLIER_LOCKED_RATE", supplierId: 1, containerId: null },
        { sourceId: 101, batchId: 10, pricingBasis: "CONTAINER_DIRECT", supplierId: null, containerId: 90 },
        { sourceId: 102, batchId: 10, pricingBasis: "CONTAINER_DIRECT", supplierId: null, containerId: 91 },
        { sourceId: 110, batchId: 11, pricingBasis: "SUPPLIER_LOCKED_RATE", supplierId: 1, containerId: null },
      ],
      batchInfoMap: new Map(),
    });

    const query = vi.fn(async (text: string) => {
      const sql = String(text);
      if (sql.includes("FROM factory_raw_stock") && sql.includes("container_id = ANY")) {
        return { rows: [{ id: 500, container_id: 90 }] };
      }
      if (sql.includes("FROM factory_bales")) {
        return { rows: [{ id: 700, is_finalized: false }, { id: 701, is_finalized: true }] };
      }
      return { rows: [] };
    });

    const scope = await buildHistoricalReplayScope({
      companyId: 7,
      selectedSupplierIds: new Set([1, 2]),
      includeCompletedBatches: false,
      includeFinalizedBales: false,
      executor: { query } as any,
    });

    expect(scope).toEqual({
      supplierIds: [1],
      containerIdsToUpdate: [90],
      rawStockIdsToUpdate: [500],
      sourceIdsToUpdate: [100, 101],
      batchIdsToUpdate: [10],
      availableBaleIdsToUpdate: [700],
      finalizedBaleIdsToUpdate: [701],
      blockedBatches: [],
    });
  });

  it("classifies finalization markers without querying for an empty bale set", async () => {
    const query = vi.fn();
    await expect(classifyBalesByFinalization([], false, { query } as any)).resolves.toEqual({
      availableIds: [],
      finalizedIds: [],
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps finalized bales out of the available set unless the caller opts in", async () => {
    const rows = [{ id: 1, is_finalized: false }, { id: 2, is_finalized: true }, { id: 3, is_finalized: false }];
    const excludedQuery = vi.fn(async () => ({ rows }));
    const includedQuery = vi.fn(async () => ({ rows }));

    await expect(classifyBalesByFinalization([1, 2, 3], false, { query: excludedQuery } as any)).resolves.toEqual({
      availableIds: [1, 3],
      finalizedIds: [2],
    });
    await expect(classifyBalesByFinalization([1, 2, 3], true, { query: includedQuery } as any)).resolves.toEqual({
      availableIds: [1, 2, 3],
      finalizedIds: [2],
    });
  });
});