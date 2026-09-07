import { describe, expect, it } from "vitest";
import {
  buildAdjustmentEvents,
  buildBatchConsumptionEvents,
  buildReceiptEvents,
} from "../server/services/factory/historical-replay/read-model/events";
import { replaySupplierTimeline, sortEvents } from "../server/services/factory/historical-replay/read-model/timeline";
import {
  computeCanonicalCosts,
  loadContainerUniverse,
} from "../server/services/factory/historical-replay/read-model/universe-costs";
import type { factoryContainers, factoryRawStock } from "@shared/schema";
import type {
  CanonicalContainer,
  ContainerUniverse,
  ReplayQueryExecutor,
  SupplierEvent,
} from "../server/services/factory/historical-replay/types";

type FactoryContainerRow = typeof factoryContainers.$inferSelect;
type FactoryRawStockRow = typeof factoryRawStock.$inferSelect;

function executor(responses: Array<unknown[]>): ReplayQueryExecutor {
  let index = 0;
  return {
    async query() {
      return { rows: responses[index++] ?? [] };
    },
  };
}

// The read model only reads a handful of columns off these rows, but the shared
// Drizzle row types carry the full table. Building the fixture from a typed
// Partial and widening once keeps the overrides type-checked without an `any`.
function container(overrides: Partial<FactoryContainerRow> = {}): FactoryContainerRow {
  const base: Partial<FactoryContainerRow> = {
    id: 10,
    companyId: 7,
    containerNumber: "C-10",
    supplierId: 3,
    actualReceivedKg: "100",
    status: "RECEIVED",
    ratePerKg: "2",
    ratePerKgUsd: "2",
    currencyCode: "USD",
    ...overrides,
  };
  return base as FactoryContainerRow;
}

function rawStock(overrides: Partial<FactoryRawStockRow> = {}): FactoryRawStockRow {
  const base: Partial<FactoryRawStockRow> = {
    id: 1,
    companyId: 7,
    containerId: 10,
    receivedKg: "80",
    usedKg: "0",
    costPerKg: "2",
    costPerKgUsd: "2",
    offloadedAt: new Date("2026-01-04T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
  return base as FactoryRawStockRow;
}

function universe(overrides: Partial<ContainerUniverse> = {}): ContainerUniverse {
  return {
    container: container(),
    supplierName: "Supplier",
    activeRawStock: null,
    deletedRawStockExists: false,
    receiptHistoryExists: false,
    offloadDaybookExists: false,
    mixSourceLinkExists: false,
    scanReason: "CONTAINER_RECEIVED_FIELD",
    offloadDate: "2026-01-01",
    ...overrides,
  };
}

function canonical(overrides: Partial<CanonicalContainer> = {}): CanonicalContainer {
  return {
    universe: universe(),
    canonicalCostPerKgUsd: 2.5,
    canonicalTotalUsd: 200,
    storedCostPerKgUsd: 2,
    storedTotalUsd: 160,
    fxUnresolved: false,
    safeToRepair: true,
    reason: null,
    ...overrides,
  };
}

describe("historical replay timeline", () => {
  it("sorts dated events before undated events and detects unresolved same-day ordering", () => {
    const receipt: SupplierEvent = {
      kind: "RECEIPT",
      effectiveDate: "2026-01-01",
      createdAt: 0,
      stableId: 2,
      receiptKg: 10,
      canonicalRateUsd: 2,
    };
    const consumption: SupplierEvent = {
      kind: "BATCH_CONSUMPTION",
      effectiveDate: "2026-01-01",
      createdAt: 0,
      stableId: 3,
      batchId: 11,
      consumptionKg: 1,
    };
    const undated: SupplierEvent = {
      kind: "REMOVE_ADJUSTMENT",
      effectiveDate: "",
      createdAt: 1,
      stableId: 1,
      adjustKg: 1,
    };
    const result = sortEvents([undated, consumption, receipt]);
    expect(result.ambiguous).toBe(true);
    expect(result.sorted.map((event) => event.kind)).toEqual(["RECEIPT", "BATCH_CONSUMPTION", "REMOVE_ADJUSTMENT"]);
  });

  it("replays receipts, valued/opening/quantity adjustments, removals, deductions, and batches", async () => {
    const result = await replaySupplierTimeline(
      7,
      3,
      "Supplier",
      1.5,
      [
        {
          kind: "RECEIPT",
          effectiveDate: "2026-01-01",
          createdAt: 1,
          stableId: 1,
          containerId: 10,
          receiptKg: 100,
          canonicalRateUsd: 2,
        },
        {
          kind: "ADD_ADJUSTMENT",
          effectiveDate: "2026-01-02",
          createdAt: 2,
          stableId: 2,
          adjustKg: 20,
          costPerKgUsd: 8,
          valuationBasis: "VALUED_TRANSFER",
        },
        {
          kind: "ADD_ADJUSTMENT",
          effectiveDate: "2026-01-03",
          createdAt: 3,
          stableId: 3,
          adjustKg: 10,
          costPerKgUsd: 99,
          valuationBasis: "QUANTITY_ONLY",
        },
        { kind: "REMOVE_ADJUSTMENT", effectiveDate: "2026-01-04", createdAt: 4, stableId: 4, adjustKg: 5 },
        {
          kind: "DEDUCT_ADJUSTMENT",
          effectiveDate: "2026-01-05",
          createdAt: 5,
          stableId: 5,
          removeKg: 5,
          adjustKg: 999,
        },
        {
          kind: "BATCH_CONSUMPTION",
          effectiveDate: "2026-01-06",
          createdAt: 6,
          stableId: 6,
          batchId: 20,
          batchCode: "B20",
          consumptionKg: 20,
          sourceIds: [1],
        },
        {
          kind: "ADD_ADJUSTMENT",
          effectiveDate: "2026-01-07",
          createdAt: 7,
          stableId: 7,
          adjustKg: 10,
          costPerKgUsd: 4,
          valuationBasis: "OPENING_BALANCE",
        },
        {
          kind: "RECEIPT",
          effectiveDate: "2026-01-08",
          createdAt: 8,
          stableId: 8,
          receiptKg: 0,
          canonicalRateUsd: 100,
        },
        { kind: "RECEIPT", effectiveDate: "", createdAt: 9, stableId: 9, receiptKg: 1, canonicalRateUsd: 3 },
      ],
      111
    );

    expect(result.eventCount).toBe(9);
    expect(result.missingDates).toBe(1);
    expect(result.expectedRateAtBatch.get(20)).toBeCloseTo(3, 7);
    expect(result.replayRemainingKg).toBe(111);
    expect(result.endingRate).toBeCloseTo(3.09009009, 7);
    expect(result.safeToRepair).toBe(false);
    expect(result.reasons).toContain("MISSING_EVENT_DATES");
    expect(result.affectedContainerCount).toBe(1);
  });

  it("flags quantity drift and only clamps tiny residuals", async () => {
    const tiny = await replaySupplierTimeline(
      7,
      3,
      "Supplier",
      0,
      [
        { kind: "RECEIPT", effectiveDate: "2026-01-01", createdAt: 1, stableId: 1, receiptKg: 10, canonicalRateUsd: 2 },
        {
          kind: "BATCH_CONSUMPTION",
          effectiveDate: "2026-01-02",
          createdAt: 2,
          stableId: 2,
          batchId: 1,
          consumptionKg: 10.0005,
        },
      ],
      0
    );
    const real = await replaySupplierTimeline(
      7,
      3,
      "Supplier",
      0,
      [
        { kind: "RECEIPT", effectiveDate: "2026-01-01", createdAt: 1, stableId: 1, receiptKg: 10, canonicalRateUsd: 2 },
        {
          kind: "BATCH_CONSUMPTION",
          effectiveDate: "2026-01-02",
          createdAt: 2,
          stableId: 2,
          batchId: 1,
          consumptionKg: 11,
        },
      ],
      0
    );

    expect(tiny.replayRemainingKg).toBe(0);
    expect(tiny.quantityMismatch).toBe(false);
    expect(real.replayRemainingKg).toBe(-1);
    expect(real.reasons).toContain("TIMELINE_QUANTITY_MISMATCH");
  });
});

describe("historical replay event builders", () => {
  it("builds one event per receipt row for containers that have receipt history", async () => {
    const withReceipts = canonical({
      universe: universe({
        container: container({ id: 10 }),
        receiptHistoryExists: true,
        scanReason: "RECEIPT_HISTORY",
      }),
      canonicalCostPerKgUsd: 2.5,
    });
    const unresolvedFx = canonical({
      universe: universe({ container: container({ id: 11 }), offloadDate: "2026-01-02" }),
      canonicalCostPerKgUsd: 4,
      fxUnresolved: true,
      safeToRepair: false,
      reason: "UNRESOLVED_FX",
    });
    const containerFieldOnly = canonical({
      universe: universe({ container: container({ id: 12 }), offloadDate: "2026-01-03" }),
      canonicalCostPerKgUsd: 5,
    });

    const events = await buildReceiptEvents(
      executor([
        [
          {
            id: 98,
            container_id: 10,
            receipt_date: "2026-01-05",
            received_kg: "25",
            created_at: "2026-01-05T00:00:00Z",
          },
          {
            id: 99,
            container_id: 10,
            receipt_date: "2026-01-07",
            received_kg: "30",
            created_at: "2026-01-07T00:00:00Z",
          },
        ],
      ]),
      7,
      [withReceipts, unresolvedFx, containerFieldOnly]
    );

    // Container 11 is skipped entirely because its FX is unresolved; container 12
    // has neither receipts nor active stock, so it falls back to the container field.
    expect(events.map((event) => event.stableId)).toEqual([98, 99, -12]);
    expect(events[0]).toMatchObject({ containerId: 10, supplierId: 3, receiptKg: 25, effectiveDate: "2026-01-05" });
    expect(events[1]).toMatchObject({ containerId: 10, receiptKg: 30, effectiveDate: "2026-01-07" });
    expect(events[2]).toMatchObject({ containerId: 12, receiptKg: 100, effectiveDate: "2026-01-03" });
  });

  it("values a container with active raw stock but no receipt history from the active stock row", async () => {
    // The container field says 100 kg and the active raw-stock row says 80 kg.
    // Only the active-stock fallback produces 80, so this fails if the branch is
    // dropped or starts reading container.actualReceivedKg instead.
    const activeStockOnly = canonical({
      universe: universe({
        container: container({ id: 13, actualReceivedKg: "100" }),
        activeRawStock: rawStock({
          id: 55,
          containerId: 13,
          receivedKg: "80",
          offloadedAt: new Date("2026-01-06T00:00:00.000Z"),
        }),
        scanReason: "ACTIVE_RAW_STOCK",
        offloadDate: "2026-01-06",
      }),
      canonicalCostPerKgUsd: 3.25,
    });

    // No receipt rows exist for container 13 at all.
    const events = await buildReceiptEvents(executor([[]]), 7, [activeStockOnly]);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      containerId: 13,
      supplierId: 3,
      effectiveDate: "2026-01-06",
      receiptKg: 80,
      canonicalRateUsd: 3.25,
      createdAt: Date.parse("2026-01-06T00:00:00.000Z"),
      stableId: -13,
    });
  });

  it("emits no receipt event when the active raw-stock row carries no weight", async () => {
    const zeroWeight = canonical({
      universe: universe({
        container: container({ id: 14, actualReceivedKg: "100" }),
        activeRawStock: rawStock({ id: 56, containerId: 14, receivedKg: "0" }),
        scanReason: "ACTIVE_RAW_STOCK",
        offloadDate: "2026-01-06",
      }),
    });

    expect(await buildReceiptEvents(executor([[]]), 7, [zeroWeight])).toEqual([]);
  });

  it("classifies adjustment valuation and counts unclassified valued additions", async () => {
    const result = await buildAdjustmentEvents(
      executor([
        [
          {
            id: 1,
            supplier_id: 3,
            date: "2026-01-01",
            type: "ADD",
            kg: "5",
            cost_per_kg: "2",
            currency_code: "USD",
            valuation_basis: null,
          },
          {
            id: 2,
            supplier_id: 3,
            date: "2026-01-02",
            type: "ADD",
            kg: "4",
            cost_per_kg: "7",
            currency_code: "EUR",
            valuation_basis: "VALUED_TRANSFER",
          },
          {
            id: 3,
            supplier_id: 3,
            date: "2026-01-03",
            type: "REMOVE",
            kg: "2",
            cost_per_kg: "0",
            currency_code: "USD",
            valuation_basis: null,
          },
          {
            id: 4,
            supplier_id: 4,
            date: null,
            type: "DEDUCT",
            kg: "1",
            cost_per_kg: "0",
            currency_code: "USD",
            valuation_basis: "QUANTITY_ONLY",
          },
        ],
      ]),
      7
    );

    expect(result.unclassifiedCount).toBe(1);
    expect(result.events.map((event) => event.kind)).toEqual([
      "ADD_ADJUSTMENT",
      "ADD_ADJUSTMENT",
      "REMOVE_ADJUSTMENT",
      "DEDUCT_ADJUSTMENT",
    ]);
    expect(result.events[0].costPerKgUsd).toBe(2);
    expect(result.events[1].costPerKgUsd).toBeNull();
    expect(result.events[3].effectiveDate).toBe("");
  });

  it("resolves source ownership, skips non-consuming bases, and aggregates supplier consumption", async () => {
    const result = await buildBatchConsumptionEvents(
      executor([
        [
          {
            id: 20,
            batch_code: "B20",
            batch_date: "2026-01-05",
            status: "OPEN",
            created_at: "2026-01-05",
            cost_per_kg: "3",
            total_cost: "30",
            total_weight_kg: "10",
          },
        ],
        [
          {
            id: 1,
            mix_batch_id: 20,
            supplier_id: 3,
            container_id: null,
            source_batch_id: null,
            weight_kg: "4",
            cost_per_kg: "2",
            total_cost: "8",
            inventory_supplier_id: null,
          },
          {
            id: 2,
            mix_batch_id: 20,
            supplier_id: null,
            container_id: 10,
            source_batch_id: null,
            weight_kg: "3",
            cost_per_kg: "4",
            total_cost: "12",
            inventory_supplier_id: null,
          },
          {
            id: 3,
            mix_batch_id: 20,
            supplier_id: null,
            container_id: null,
            source_batch_id: 19,
            weight_kg: "2",
            cost_per_kg: "1",
            total_cost: "2",
            inventory_supplier_id: null,
          },
          {
            id: 4,
            mix_batch_id: 20,
            supplier_id: 3,
            container_id: null,
            source_batch_id: null,
            weight_kg: "1",
            cost_per_kg: "2",
            total_cost: "2",
            inventory_supplier_id: null,
          },
          {
            id: 5,
            mix_batch_id: 20,
            supplier_id: 99,
            container_id: null,
            source_batch_id: null,
            weight_kg: "1",
            cost_per_kg: "2",
            total_cost: "2",
            inventory_supplier_id: null,
          },
        ],
        [{ id: 10, supplier_id: 3 }],
      ]),
      7,
      new Set([3])
    );

    expect(result.sourceInfos).toHaveLength(5);
    expect(result.sourceInfos[1].inventorySupplierId).toBe(3);
    expect(result.sourceInfos[2].pricingBasis).toBe("BATCH");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ supplierId: 3, batchId: 20, consumptionKg: 8, sourceIds: [1, 2, 4] });
  });
});

describe("historical replay universe read model", () => {
  it("selects the strongest scan reason and keeps the newest active raw-stock row", async () => {
    const result = await loadContainerUniverse(
      executor([
        [
          {
            id: 10,
            supplier_name: "S",
            has_active_rs: true,
            has_deleted_rs: true,
            has_receipt_history: true,
            has_offload_daybook: true,
            has_mix_source: true,
            earliest_offload_date: "2026-01-02",
            offloaded_at: null,
          },
          {
            id: 11,
            supplier_name: "S",
            has_active_rs: false,
            has_deleted_rs: true,
            has_receipt_history: false,
            has_offload_daybook: false,
            has_mix_source: false,
            earliest_offload_date: null,
            offloaded_at: "2026-01-03",
          },
          {
            id: 12,
            supplier_name: "S",
            has_active_rs: false,
            has_deleted_rs: false,
            has_receipt_history: true,
            has_offload_daybook: false,
            has_mix_source: false,
            earliest_offload_date: null,
            offloaded_at: null,
          },
          {
            id: 13,
            supplier_name: "S",
            has_active_rs: false,
            has_deleted_rs: false,
            has_receipt_history: false,
            has_offload_daybook: true,
            has_mix_source: false,
            earliest_offload_date: "2026-01-04",
            offloaded_at: null,
          },
          {
            id: 14,
            supplier_name: "S",
            has_active_rs: false,
            has_deleted_rs: false,
            has_receipt_history: false,
            has_offload_daybook: false,
            has_mix_source: true,
            earliest_offload_date: null,
            offloaded_at: null,
          },
        ],
        [
          {
            id: 10,
            company_id: 7,
            container_id: 10,
            actual_received_kg: "100",
            rate_per_kg: "2",
            rate_per_kg_usd: "2",
          },
          {
            id: 11,
            company_id: 7,
            container_id: 11,
            actual_received_kg: "100",
            rate_per_kg: "2",
            rate_per_kg_usd: "2",
          },
          {
            id: 12,
            company_id: 7,
            container_id: 12,
            actual_received_kg: "100",
            rate_per_kg: "2",
            rate_per_kg_usd: "2",
          },
          {
            id: 13,
            company_id: 7,
            container_id: 13,
            actual_received_kg: "100",
            rate_per_kg: "2",
            rate_per_kg_usd: "2",
          },
          {
            id: 14,
            company_id: 7,
            container_id: 14,
            actual_received_kg: "100",
            rate_per_kg: "2",
            rate_per_kg_usd: "2",
          },
        ],
        [
          { id: 1, container_id: 10, received_kg: "80", offloaded_at: "2026-01-01", deleted_at: null },
          { id: 2, container_id: 10, received_kg: "90", offloaded_at: "2026-01-02", deleted_at: null },
          { id: 3, container_id: 11, received_kg: "50", offloaded_at: "2026-01-01", deleted_at: "2026-01-02" },
        ],
      ]),
      7
    );

    expect(result).toHaveLength(5);
    expect(result[0].scanReason).toBe("ACTIVE_RAW_STOCK");
    expect(result[0].activeRawStock?.id).toBe(2);
    expect(result[0].offloadDate).toBe("2026-01-02");
    expect(result[1].scanReason).toBe("DELETED_RAW_STOCK");
    expect(result[2].scanReason).toBe("RECEIPT_HISTORY");
    expect(result[3].scanReason).toBe("OFFLOAD_DAYBOOK");
    expect(result[4].scanReason).toBe("MIX_SOURCE_LINK");
  });

  it("returns no canonical costs for an empty universe", async () => {
    expect(await computeCanonicalCosts(executor([]), 7, [])).toEqual([]);
  });
});
