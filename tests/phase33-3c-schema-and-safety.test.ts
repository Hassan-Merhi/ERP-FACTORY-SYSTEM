import { describe, expect, it } from "vitest";

import {
  insertFactoryMixBatchSchema,
  insertFactoryMixBatchSourceSchema,
  insertFactoryRawStockSchema,
} from "../shared/schema/factory/raw-stock-mix";
import {
  insertStockAdjustmentItemSchema,
  insertStockTransferItemSchema,
  insertStockTransferVoucherSchema,
  updateStockAdjustmentSchema,
  updateStockTransferSchema,
} from "../shared/schema/erp/stock-movements";
import {
  InvalidPostOffloadPhase6TokenError,
  StalePostOffloadPhase6TokenError,
  phase6ErrorStatus,
} from "../server/services/factory/postOffloadPhase6SafetyImpl";
import { RepairTokenConfigurationError } from "../server/services/factory/repairToken";

describe("Phase 33 3C schema validation", () => {
  it("accepts valid raw-stock input and rejects unsafe weight/cost values", () => {
    expect(
      insertFactoryRawStockSchema.safeParse({
        companyId: 7,
        containerId: 11,
        receivedKg: "20500.125",
        costPerKg: "0.4629910",
        costPerKgUsd: "0.4629910",
      }).success
    ).toBe(true);

    expect(
      insertFactoryRawStockSchema.safeParse({
        companyId: 7,
        containerId: 11,
        receivedKg: "0",
        costPerKg: "0.4629910",
      }).success
    ).toBe(false);

    expect(
      insertFactoryRawStockSchema.safeParse({
        companyId: 7,
        containerId: 11,
        receivedKg: "100",
        costPerKg: "-0.01",
      }).success
    ).toBe(false);
  });

  it("pins mix-batch status and positive weight/non-negative costing rules", () => {
    for (const status of ["ACTIVE", "COMPLETED", "OPEN", "CLOSED", "CARRY_FORWARD"] as const) {
      const parsed = insertFactoryMixBatchSchema.safeParse({
        companyId: 7,
        batchCode: `B-${status}`,
        totalWeightKg: "1000",
        usedKg: "0",
        costPerKg: "0.4640000",
        totalCost: "464.0000000",
        status,
      });
      expect(parsed.success).toBe(true);
    }

    expect(
      insertFactoryMixBatchSchema.safeParse({
        companyId: 7,
        totalWeightKg: "1000",
        costPerKg: "0.464",
        totalCost: "464",
        status: "BROKEN",
      }).success
    ).toBe(false);

    expect(
      insertFactoryMixBatchSourceSchema.safeParse({
        mixBatchId: 10,
        containerId: 11,
        supplierId: 12,
        weightKg: "250.500",
        costPerKg: "0.4640000",
        totalCost: "116.2320000",
      }).success
    ).toBe(true);

    expect(
      insertFactoryMixBatchSourceSchema.safeParse({
        mixBatchId: 10,
        weightKg: "0",
        costPerKg: "0.464",
        totalCost: "0",
      }).success
    ).toBe(false);
  });

  it("coerces safe stock-transfer edits while rejecting zero quantity and negative rates", () => {
    const transfer = updateStockTransferSchema.safeParse({
      destinationLocationId: "9",
      notes: "3C coverage",
      items: [{ sourceLocationId: "2", stockItemId: "15", quantity: "12.5", rate: "3.25" }],
    });
    expect(transfer.success).toBe(true);
    if (transfer.success) {
      expect(transfer.data.destinationLocationId).toBe(9);
      expect(transfer.data.items[0]).toEqual({
        sourceLocationId: 2,
        stockItemId: 15,
        quantity: 12.5,
        rate: 3.25,
      });
    }

    expect(
      updateStockTransferSchema.safeParse({
        destinationLocationId: 9,
        items: [{ sourceLocationId: 2, stockItemId: 15, quantity: 0, rate: 3.25 }],
      }).success
    ).toBe(false);

    expect(
      insertStockTransferVoucherSchema.safeParse({ voucherId: 0, destinationLocationId: 9 }).success
    ).toBe(false);
    expect(
      insertStockTransferItemSchema.safeParse({
        transferId: 1,
        stockItemId: 15,
        quantity: "1",
        rate: "-1",
      }).success
    ).toBe(false);
  });

  it("allows signed adjustment quantities but never zero", () => {
    expect(
      insertStockAdjustmentItemSchema.safeParse({
        adjustmentId: 1,
        stockItemId: 15,
        quantity: "-3",
        rate: "2.25",
      }).success
    ).toBe(true);

    expect(
      updateStockAdjustmentSchema.safeParse({
        locationId: "4",
        adjustmentType: "Consumption",
        items: [{ stockItemId: "15", quantity: "-3", rate: "2.25" }],
      }).success
    ).toBe(true);

    expect(
      updateStockAdjustmentSchema.safeParse({
        locationId: 4,
        adjustmentType: "Consumption",
        items: [{ stockItemId: 15, quantity: 0, rate: 2.25 }],
      }).success
    ).toBe(false);
  });
});

describe("Phase 33 3C post-offload Phase 6 error contract", () => {
  it("maps stale, invalid, configuration, and unknown failures to stable HTTP statuses", () => {
    expect(phase6ErrorStatus(new StalePostOffloadPhase6TokenError())).toBe(409);
    expect(phase6ErrorStatus({ code: "STALE_TOKEN" })).toBe(409);
    expect(phase6ErrorStatus({ code: "HISTORICAL_REPLAY_SCOPE_VIOLATION" })).toBe(409);
    expect(phase6ErrorStatus(new InvalidPostOffloadPhase6TokenError("bad token"))).toBe(400);
    expect(phase6ErrorStatus(new RepairTokenConfigurationError())).toBe(503);
    expect(phase6ErrorStatus(new Error("unexpected"))).toBe(500);
  });

  it("keeps the public safety errors machine-readable", () => {
    const invalid = new InvalidPostOffloadPhase6TokenError("bad payload");
    expect(invalid).toMatchObject({
      name: "InvalidPostOffloadPhase6TokenError",
      code: "POST_OFFLOAD_PHASE6_TOKEN_INVALID",
      statusCode: 400,
      message: "bad payload",
    });

    const stale = new StalePostOffloadPhase6TokenError();
    expect(stale).toMatchObject({
      name: "StalePostOffloadPhase6TokenError",
      code: "POST_OFFLOAD_PHASE6_TOKEN_STALE",
      statusCode: 409,
    });
  });
});
