import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = { selectResults: [] as unknown[][] };

  const select = vi.fn(() => {
    const result = state.selectResults.shift() ?? [];
    const builder: any = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      groupBy: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });

  return { state, db: { select } };
});

vi.mock("../server/db", () => ({ db: harness.db }));

import { loadOtwStockByItem, matchLocationByName } from "../server/services/stockTransferAnalysis";

describe("Phase 33 3C stock-transfer location matching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.selectResults.splice(0);
  });

  it("does not hit the database for an empty location name", async () => {
    await expect(matchLocationByName(3, "   ")).resolves.toEqual({ matched: null, candidates: [] });
    expect(harness.db.select).not.toHaveBeenCalled();
  });

  it("matches exact name/code case-insensitively and surfaces duplicate exact matches", async () => {
    harness.state.selectResults.push([
      { id: 1, name: "Kolwezi", code: "KLZ" },
      { id: 2, name: "Hadi 1", code: "H1" },
    ]);
    await expect(matchLocationByName(3, " klz ")).resolves.toEqual({
      matched: { id: 1, name: "Kolwezi", code: "KLZ" },
      candidates: [],
    });

    harness.state.selectResults.push([
      { id: 1, name: "Kolwezi", code: "KLZ" },
      { id: 9, name: "KLZ", code: "ALT" },
    ]);
    const duplicate = await matchLocationByName(3, "KLZ");
    expect(duplicate.matched).toBeNull();
    expect(duplicate.candidates).toHaveLength(2);
  });

  it("keeps strict destination matching ambiguous while non-strict matching may resolve one partial", async () => {
    harness.state.selectResults.push([
      { id: 1, name: "Kolwezi", code: "KLZ" },
      { id: 2, name: "Kolwezi 2", code: "KLZ2" },
    ]);
    const strict = await matchLocationByName(3, "Kol", { strict: true });
    expect(strict.matched).toBeNull();
    expect(strict.candidates.map((row) => row.id)).toEqual([1, 2]);

    harness.state.selectResults.push([
      { id: 1, name: "Kolwezi", code: "KLZ" },
      { id: 2, name: "Hadi 1", code: "H1" },
    ]);
    await expect(matchLocationByName(3, "kol")).resolves.toEqual({
      matched: { id: 1, name: "Kolwezi", code: "KLZ" },
      candidates: [],
    });
  });

  it("returns no match instead of inventing a location", async () => {
    harness.state.selectResults.push([{ id: 1, name: "Kolwezi", code: "KLZ" }]);
    await expect(matchLocationByName(3, "Lubumbashi")).resolves.toEqual({ matched: null, candidates: [] });
  });
});

describe("Phase 33 3C OTW stock analysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.selectResults.splice(0);
  });

  it("returns empty maps immediately when the company has no OTW containers", async () => {
    harness.state.selectResults.push([]);
    const result = await loadOtwStockByItem(7, 99);
    expect([...result.otwQtyByItem.entries()]).toEqual([]);
    expect([...result.otwDetailsByItem.entries()]).toEqual([]);
    expect(harness.db.select).toHaveBeenCalledTimes(1);
  });

  it("counts direct and unknown-shop OTW stock, excludes other shops, and resolves item fallbacks conservatively", async () => {
    harness.state.selectResults.push(
      [
        {
          id: 101,
          containerNumber: "MSKU-DIRECT",
          supplierId: 1,
          importDate: "2026-09-01",
          shopName: "  KOLWEZI  ",
          eta: "2026-09-20",
          trackingLastStatus: "IN_TRANSIT",
          trackingLastLocation: "Dar es Salaam",
          trackingLocation: "Fallback location",
        },
        {
          id: 102,
          containerNumber: "MSKU-OTHER",
          supplierId: 2,
          importDate: "2026-09-02",
          shopName: "Hadi 1",
          eta: null,
          trackingLastStatus: null,
          trackingLastLocation: null,
          trackingLocation: "Lusaka",
        },
        {
          id: 103,
          containerNumber: "MSKU-UNKNOWN",
          supplierId: 1,
          importDate: null,
          shopName: null,
          eta: "2026-09-22",
          trackingLastStatus: "BOOKED",
          trackingLastLocation: null,
          trackingLocation: null,
        },
      ],
      [{ name: "Kolwezi", code: "KLZ" }],
      [
        { id: 1, legalName: "Supplier A" },
        { id: 2, legalName: "Supplier B" },
      ],
      [
        { id: 201, containerId: 101 },
        { id: 202, containerId: 102 },
        { id: 203, containerId: 103 },
      ],
      [
        { poId: 201, stockItemId: 501, stockItemCode: "B-1", itemName: "Red Bale", quantity: "10" },
        { poId: 201, stockItemId: null, stockItemCode: " b-2 ", itemName: "Ignored name", quantity: "5" },
        { poId: 202, stockItemId: 501, stockItemCode: "B-1", itemName: "Red Bale", quantity: "7" },
        { poId: 203, stockItemId: null, stockItemCode: null, itemName: "  Blue   Bale ", quantity: "3" },
        { poId: 203, stockItemId: null, stockItemCode: "NOPE", itemName: "Unknown", quantity: "4" },
        { poId: 203, stockItemId: 501, stockItemCode: "B-1", itemName: "Red Bale", quantity: "0" },
      ],
      [
        { id: 501, code: "B-1", name: "Red Bale" },
        { id: 502, code: "B-2", name: "Blue Bale" },
      ]
    );

    const result = await loadOtwStockByItem(7, 99);

    expect(result.otwQtyByItem.get(501)).toBe(10);
    expect(result.otwQtyByItem.get(502)).toBe(8);

    expect(result.otwDetailsByItem.get(501)).toEqual([
      expect.objectContaining({
        containerNumber: "MSKU-DIRECT",
        quantity: 10,
        matchType: "direct",
        supplierName: "Supplier A",
        currentLocation: "Dar es Salaam",
      }),
      expect.objectContaining({
        containerNumber: "MSKU-OTHER",
        quantity: 7,
        matchType: "other",
        supplierName: "Supplier B",
        currentLocation: "Lusaka",
      }),
    ]);

    expect(result.otwDetailsByItem.get(502)).toEqual([
      expect.objectContaining({ containerNumber: "MSKU-DIRECT", quantity: 5, matchType: "direct" }),
      expect.objectContaining({ containerNumber: "MSKU-UNKNOWN", quantity: 3, matchType: "unknown" }),
    ]);
    expect(result.otwDetailsByItem.has(999)).toBe(false);
  });

  it("counts all OTW containers when no destination is supplied", async () => {
    harness.state.selectResults.push(
      [
        {
          id: 101,
          containerNumber: "MSKU-ANY",
          supplierId: 1,
          importDate: null,
          shopName: "Somewhere Else",
          eta: null,
          trackingLastStatus: null,
          trackingLastLocation: null,
          trackingLocation: null,
        },
      ],
      [{ id: 1, legalName: "Supplier A" }],
      [{ id: 201, containerId: 101 }],
      [{ poId: 201, stockItemId: 501, stockItemCode: "B-1", itemName: "Red Bale", quantity: "6" }],
      [{ id: 501, code: "B-1", name: "Red Bale" }]
    );

    const result = await loadOtwStockByItem(7);
    expect(result.otwQtyByItem.get(501)).toBe(6);
    expect(result.otwDetailsByItem.get(501)?.[0].matchType).toBe("unknown");
  });
});
