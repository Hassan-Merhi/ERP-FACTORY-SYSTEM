import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  poolQuery: vi.fn(),
}));

vi.mock("../server/db", () => ({
  pool: { query: harness.poolQuery },
}));

import {
  buildHistoricalReplayScope,
  buildNotFinalizedClause,
  computeReplayFingerprint,
  normalizeReplayWriteScope,
  replayWriteScopesEqual,
} from "../server/services/factory/historical-replay/selectedScope";

describe("phase 31 selected historical replay scope function gaps", () => {
  it("builds the finalized-bale SQL clause for both replay modes", () => {
    expect(buildNotFinalizedClause(true)).toBe("status NOT IN ('DELETED','REMOVED')");

    const availableOnly = buildNotFinalizedClause(false);
    expect(availableOnly).toContain("dispatch_batch_id IS NULL");
    expect(availableOnly).toContain("customer_order_bales");
    expect(availableOnly).toContain("factory_invoice_loading_bales");
    expect(availableOnly).toContain("status NOT IN ('DELETED','REMOVED'");
  });

  it("normalizes write scopes deterministically and compares equivalent scopes", () => {
    const unordered = {
      supplierIds: [9, 2, 9],
      containerIdsToUpdate: [30, 10, 30],
      rawStockIdsToUpdate: [8, 3, 8],
      sourceIdsToUpdate: [22, 11, 22],
      batchIdsToUpdate: [6, 4, 6],
      availableBaleIdsToUpdate: [1002, 1001, 1002],
      finalizedBaleIdsToUpdate: [2002, 2001, 2002],
      blockedBatches: [
        { batchId: 8, batchCode: "B-8", reasons: ["z", "a", "a"] },
        { batchId: 3, batchCode: "B-3", reasons: ["manual", "manual"] },
      ],
    };

    const normalized = normalizeReplayWriteScope(unordered);
    expect(normalized).toEqual({
      supplierIds: [2, 9],
      containerIdsToUpdate: [10, 30],
      rawStockIdsToUpdate: [3, 8],
      sourceIdsToUpdate: [11, 22],
      batchIdsToUpdate: [4, 6],
      availableBaleIdsToUpdate: [1001, 1002],
      finalizedBaleIdsToUpdate: [2001, 2002],
      blockedBatches: [
        { batchId: 3, batchCode: "B-3", reasons: ["manual"] },
        { batchId: 8, batchCode: "B-8", reasons: ["a", "z"] },
      ],
    });

    expect(replayWriteScopesEqual(unordered, normalized)).toBe(true);
    expect(
      replayWriteScopesEqual(normalized, {
        ...normalized,
        sourceIdsToUpdate: [11, 23],
      })
    ).toBe(false);
  });

  it("fingerprints only the selected/scope rows and stays stable across input ordering", () => {
    const supplierRows = [
      {
        supplierId: 9,
        endingExpectedRate: 0.62,
        replayRemainingKg: 90,
        authoritativeRemainingKg: 90,
        currentStoredRate: 0.61,
        safeToRepair: true,
      },
      {
        supplierId: 2,
        endingExpectedRate: 0.51,
        replayRemainingKg: 120,
        authoritativeRemainingKg: 120,
        currentStoredRate: 0.5,
        safeToRepair: true,
      },
      {
        supplierId: 77,
        endingExpectedRate: 9,
        replayRemainingKg: 1,
        authoritativeRemainingKg: 1,
        currentStoredRate: 9,
        safeToRepair: false,
      },
    ];
    const sourceRows = [
      {
        sourceId: 22,
        batchId: 6,
        supplierId: 9,
        containerId: 30,
        pricingBasis: "SUPPLIER_LOCKED_RATE",
        weightKg: 20,
        storedCostPerKg: 0.61,
        expectedHistoricalCostPerKg: 0.62,
      },
      {
        sourceId: 11,
        batchId: 4,
        supplierId: 2,
        containerId: 10,
        pricingBasis: "SUPPLIER_LOCKED_RATE",
        weightKg: 10,
        storedCostPerKg: 0.5,
        expectedHistoricalCostPerKg: 0.51,
      },
      {
        sourceId: 99,
        batchId: 99,
        supplierId: 77,
        containerId: 99,
        pricingBasis: "SUPPLIER_LOCKED_RATE",
        weightKg: 1,
        storedCostPerKg: 9,
        expectedHistoricalCostPerKg: 9,
      },
    ];
    const batchRows = [
      {
        batchId: 6,
        status: "ACTIVE",
        storedCostPerKg: 0.61,
        expectedCostPerKg: 0.62,
        storedTotalCost: 61,
        expectedTotalCost: 62,
      },
      {
        batchId: 4,
        status: "COMPLETED",
        storedCostPerKg: 0.5,
        expectedCostPerKg: 0.51,
        storedTotalCost: 50,
        expectedTotalCost: 51,
      },
    ];
    const containerRows = [
      {
        containerId: 30,
        supplierId: 9,
        storedCostPerKgUsd: 0.61,
        canonicalCostPerKgUsd: 0.62,
        storedTotalUsd: 610,
        canonicalTotalUsd: 620,
        safeToRepair: true,
      },
      {
        containerId: 10,
        supplierId: 2,
        storedCostPerKgUsd: 0.5,
        canonicalCostPerKgUsd: 0.51,
        storedTotalUsd: 500,
        canonicalTotalUsd: 510,
        safeToRepair: true,
      },
    ];

    const preview = {
      summary: {},
      supplierRows,
      sourceRows,
      batchRows,
      containerRows,
    };
    const scope = normalizeReplayWriteScope({
      supplierIds: [9, 2],
      containerIdsToUpdate: [30, 10],
      rawStockIdsToUpdate: [8, 3],
      sourceIdsToUpdate: [22, 11],
      batchIdsToUpdate: [6, 4],
      availableBaleIdsToUpdate: [1002, 1001],
      finalizedBaleIdsToUpdate: [2002, 2001],
      blockedBatches: [{ batchId: 6, batchCode: "B-6", reasons: ["rate"] }],
    });

    const first = computeReplayFingerprint(
      7,
      [9, 2, 9],
      preview as never,
      { includeCompletedBatches: true, includeFinalizedBales: false },
      scope
    );
    const reorderedPreview = {
      ...preview,
      supplierRows: [...supplierRows].reverse(),
      sourceRows: [...sourceRows].reverse(),
      batchRows: [...batchRows].reverse(),
      containerRows: [...containerRows].reverse(),
    };
    const second = computeReplayFingerprint(
      7,
      [2, 9],
      reorderedPreview as never,
      { includeCompletedBatches: true, includeFinalizedBales: false },
      { ...scope, supplierIds: [2, 9], sourceIdsToUpdate: [11, 22] }
    );

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);

    const changedPreview = {
      ...reorderedPreview,
      supplierRows: supplierRows.map((row) => (row.supplierId === 2 ? { ...row, endingExpectedRate: 0.52 } : row)),
    };
    const changed = computeReplayFingerprint(
      7,
      [2, 9],
      changedPreview as never,
      { includeCompletedBatches: true, includeFinalizedBales: false },
      scope
    );
    expect(changed).not.toBe(first);
  });

  it("returns the canonical empty write scope without querying when no suppliers are selected", async () => {
    const executor = { query: vi.fn() };

    await expect(
      buildHistoricalReplayScope({
        companyId: 7,
        selectedSupplierIds: new Set<number>(),
        includeCompletedBatches: false,
        includeFinalizedBales: false,
        executor: executor as never,
      })
    ).resolves.toEqual({
      supplierIds: [],
      containerIdsToUpdate: [],
      rawStockIdsToUpdate: [],
      sourceIdsToUpdate: [],
      batchIdsToUpdate: [],
      availableBaleIdsToUpdate: [],
      finalizedBaleIdsToUpdate: [],
      blockedBatches: [],
    });
    expect(executor.query).not.toHaveBeenCalled();
  });
});
