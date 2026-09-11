import { describe, expect, it } from "vitest";
import {
  buildInventoryValuationReconciliation,
  inventorySnapshotFromStoredValues,
} from "../server/services/inventory/inventoryValuationSnapshot";

describe("Wave 4 monthly-summary valuation reconciliation", () => {
  it("uses stored total_value when average_rate is stale", () => {
    const snapshot = inventorySnapshotFromStoredValues("18", "1224.41", "33.92");

    expect(snapshot.quantity).toBe(18);
    expect(snapshot.totalValue).toBe(1224.41);
    expect(snapshot.rate).toBeCloseTo(68.0227777778, 8);
    expect(snapshot.totalValue).not.toBeCloseTo(18 * 33.92, 2);
  });

  it("preserves exact cents that cannot be reconstructed from a rounded average rate", () => {
    const snapshot = inventorySnapshotFromStoredValues("18", "1224.41", "68.02");

    expect(snapshot.totalValue).toBe(1224.41);
    expect(snapshot.totalValue).not.toBe(1224.36);
    expect(snapshot.rate).toBeCloseTo(1224.41 / 18, 8);
  });

  it("falls back to quantity times average rate only for legacy rows without a usable total value", () => {
    const snapshot = inventorySnapshotFromStoredValues("18", null, "33.92");

    expect(snapshot.quantity).toBe(18);
    expect(snapshot.totalValue).toBeCloseTo(610.56, 2);
    expect(snapshot.rate).toBeCloseTo(33.92, 2);
  });

  it("reports current-month drift without changing the derived month", () => {
    const live = inventorySnapshotFromStoredValues("18", "1224.41", "33.92");
    const derived = inventorySnapshotFromStoredValues("18", "1224.41", "68.02");
    const reconciliation = buildInventoryValuationReconciliation(9, live, derived);

    expect(reconciliation.asOfMonth).toBe(9);
    expect(reconciliation.liveValue).toBe(1224.41);
    expect(reconciliation.derivedValue).toBe(1224.41);
    expect(reconciliation.quantityDelta).toBe(0);
    expect(reconciliation.valueDelta).toBe(0);
    expect(reconciliation.inSync).toBe(true);
  });

  it("surfaces a real quantity or value mismatch instead of hiding it", () => {
    const live = inventorySnapshotFromStoredValues("18", "1224.41", "68.02");
    const derived = inventorySnapshotFromStoredValues("19", "1292.43", "68.02");
    const reconciliation = buildInventoryValuationReconciliation(9, live, derived);

    expect(reconciliation.quantityDelta).toBe(-1);
    expect(reconciliation.valueDelta).toBeCloseTo(-68.02, 2);
    expect(reconciliation.inSync).toBe(false);
  });
});
