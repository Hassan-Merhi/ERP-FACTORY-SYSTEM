import { describe, expect, it } from "vitest";
import { companyQueryKey } from "../client/src/lib/companyQueryScope";
import {
  toFactoryProformaAllocationArticles,
  FACTORY_V5_ALLOCATION_BASE,
  FACTORY_V5_CREATE_SNAPSHOT,
  FACTORY_V5_EDIT_SNAPSHOT,
} from "../client/src/lib/factoryAllocationReadModel";

describe("Factory Phase 6 V5 proforma read-only projection", () => {
  it("retains V5 server balances and does not round six-decimal values", () => {
    const source = [{
      articleCode: "B", productName: "Zulu", categoryName: "Raw",
      stockAvailable: 3.000001, totalLoaded: 2, expectedToLoad: 0.000001,
      freeToPromise: 1.000000, totalKg: 12.345678,
      proformaDetails: [],
    }, {
      articleCode: "A", productName: "Alpha",
      stockAvailable: 7, totalLoaded: 1, expectedToLoad: 3,
      freeToPromise: 3, totalKg: 20,
      proformaDetails: [],
    }];
    const before = JSON.stringify(source);
    const projected = toFactoryProformaAllocationArticles(source);
    expect(projected.map((row) => row.articleCode)).toEqual(["A", "B"]);
    expect(projected[1].stockAvailable).toBe(3.000001);
    expect(projected[1].expectedToLoad).toBe(0.000001);
    expect(projected[1].freeToPromise).toBe(1);
    expect(JSON.stringify(source)).toBe(before);
    expect(projected[1]).not.toHaveProperty("totalKg");
    expect(projected[1]).not.toHaveProperty("proformaDetails");
  });
  it("retains URL-first company scoped V5 keys for separate edit and create", () => {
    const c1 = companyQueryKey(FACTORY_V5_CREATE_SNAPSHOT, 1);
    const c2 = companyQueryKey(FACTORY_V5_CREATE_SNAPSHOT, 2);
    expect(c1).not.toEqual(c2);
    expect(companyQueryKey(FACTORY_V5_EDIT_SNAPSHOT, 1, 10)).not.toEqual(
      companyQueryKey(FACTORY_V5_EDIT_SNAPSHOT, 1, 11),
    );
    expect(FACTORY_V5_ALLOCATION_BASE).toBe("/api/factory/v5/stock-allocation");
  });
});
