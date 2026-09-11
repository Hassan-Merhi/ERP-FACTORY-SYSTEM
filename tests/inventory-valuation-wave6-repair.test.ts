import { describe, expect, it } from "vitest";
import { classifyWave6InventoryState, parseWave6RepairConfig } from "../server/inventoryValuationWave6RepairBridge.mjs";

const REPAIR = {
  repairKey: "wave6-shmix3-20260911",
  companyId: 8,
  locationId: 122,
  stockItemId: 6374,
  expectedLastUpdated: "2026-09-11T12:43:29.159779Z",
  expectedQuantity: "17.000",
  expectedRate: "33.92",
  expectedValue: "576.56",
  targetRate: "66.65",
  targetValue: "1133.05",
  expectedNegativeLayerCount: 0,
};

const BEFORE = {
  id: 1,
  quantity: "17.000",
  average_rate: "33.92",
  total_value: "576.56",
  last_updated_text: "2026-09-11T12:43:29.159779Z",
};

describe("inventory valuation Wave 6 guarded repair", () => {
  it("stays disabled unless an explicit repair configuration is present", () => {
    expect(parseWave6RepairConfig(undefined)).toBeNull();
    expect(parseWave6RepairConfig("off")).toBeNull();
    expect(parseWave6RepairConfig("false")).toBeNull();
  });

  it("accepts the exact SH.MIX3 repair snapshot", () => {
    expect(parseWave6RepairConfig(JSON.stringify(REPAIR))).toEqual(REPAIR);
  });

  it("classifies only the exact pre-repair snapshot as ready", () => {
    const config = parseWave6RepairConfig(JSON.stringify(REPAIR));
    expect(config).not.toBeNull();
    expect(classifyWave6InventoryState(BEFORE, config!, 0)).toBe("ready");

    expect(classifyWave6InventoryState({ ...BEFORE, quantity: "16.000" }, config!, 0)).toBe("conflict");
    expect(classifyWave6InventoryState({ ...BEFORE, average_rate: "33.93" }, config!, 0)).toBe("conflict");
    expect(classifyWave6InventoryState({ ...BEFORE, total_value: "576.57" }, config!, 0)).toBe("conflict");
    expect(
      classifyWave6InventoryState({ ...BEFORE, last_updated_text: "2026-09-11T12:44:00.000000Z" }, config!, 0)
    ).toBe("conflict");
    expect(classifyWave6InventoryState(BEFORE, config!, 1)).toBe("conflict");
  });

  it("is idempotent after the exact target valuation is already present", () => {
    const config = parseWave6RepairConfig(JSON.stringify(REPAIR));
    expect(config).not.toBeNull();

    expect(
      classifyWave6InventoryState(
        {
          ...BEFORE,
          average_rate: REPAIR.targetRate,
          total_value: REPAIR.targetValue,
          last_updated_text: "2026-09-11T18:00:00.000000Z",
        },
        config!,
        0
      )
    ).toBe("already-applied");
  });

  it("fails configuration validation when the target value does not match quantity times target rate", () => {
    expect(() => parseWave6RepairConfig(JSON.stringify({ ...REPAIR, targetValue: "1133.06" }))).toThrow(/targetValue/);
  });
});
