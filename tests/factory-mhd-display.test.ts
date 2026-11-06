import { describe, expect, it } from "vitest";
import {
  factoryMhdLookup,
  factoryMhdName,
  normalizeFactoryMhdCode,
  sortFactoryMhdRows,
} from "../client/src/lib/factoryMhdDisplay";

describe("Factory MHD display-only view", () => {
  const entries = factoryMhdLookup([
    { articleCode: "HMD200", itemName: "Sorted first", sortOrder: 0 },
    { articleCode: "HMD100", itemName: "", sortOrder: 1 },
    { articleCode: "HMD300", itemName: "Sorted third", sortOrder: 2 },
  ]);

  it("matches article codes case-insensitively without changing the stored code", () => {
    expect(normalizeFactoryMhdCode(" hmd200 ")).toBe("HMD200");
    expect(factoryMhdName("mhd", entries, "hmd200", "Original")).toBe("Sorted first");
  });

  it("keeps the original name for blank or unlisted aliases", () => {
    expect(factoryMhdName("mhd", entries, "HMD100", "Original 100")).toBe("Original 100");
    expect(factoryMhdName("mhd", entries, "UNKNOWN", "Original unknown")).toBe("Original unknown");
  });

  it("does not change names in Standard View", () => {
    expect(factoryMhdName("standard", entries, "HMD200", "Original 200")).toBe("Original 200");
  });

  it("sorts by Excel row order and leaves unlisted products in their original relative order", () => {
    const original = [
      { articleCode: "EXTRA1", value: 1 },
      { articleCode: "HMD300", value: 3 },
      { articleCode: "HMD100", value: 2 },
      { articleCode: "EXTRA2", value: 4 },
      { articleCode: "HMD200", value: 5 },
    ];
    const mhd = sortFactoryMhdRows("mhd", entries, original, (row) => row.articleCode);
    expect(mhd.map((row) => row.articleCode)).toEqual(["HMD200", "HMD100", "HMD300", "EXTRA1", "EXTRA2"]);
    expect(sortFactoryMhdRows("standard", entries, original, (row) => row.articleCode)).toEqual(original);
    expect(original[0].articleCode).toBe("EXTRA1");
  });
});
