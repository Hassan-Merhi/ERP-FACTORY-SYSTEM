import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = { selectResults: [] as unknown[][] };
  const select = vi.fn(() => {
    const result = state.selectResults.shift() ?? [];
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "leftJoin", "innerJoin", "where", "limit", "orderBy"]) {
      builder[method] = vi.fn(() => builder);
    }
    builder.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return builder;
  });
  return { state, db: { select } };
});

vi.mock("../server/db", () => ({ db: harness.db }));

import {
  buildStockTransferByTargetQuantityContext,
  buildStockTransferSuggestionContext,
} from "../server/services/stockTransferAnalysis";

const SOURCE = { id: 1, name: "Hadi 1" };
const DEST = { id: 2, name: "Kolwezi" };

type Otw = {
  containers: Array<Record<string, unknown>>;
  suppliers?: Array<Record<string, unknown>>;
  pos?: Array<{ id: number; containerId: number }>;
  lines?: Array<Record<string, unknown>>;
  stockItems?: Array<{ id: number; code: string | null; name: string }>;
};

function queueSuggestion(input: {
  inventory?: Array<{ stockItemId: number; locationId: number; quantity: string }>;
  sales?: Array<{ stockItemId: number; locationId: number | null; quantity: string }>;
  items: Array<{ id: number; name: string; code: string }>;
  old?: Array<{ stockItemId: number; quantity: string; voucherDate: string }>;
  otw?: Otw;
}) {
  const queue = harness.state.selectResults;
  queue.push([SOURCE], [DEST], input.inventory ?? [], input.sales ?? [], input.items, input.old ?? []);
  const otw = input.otw ?? { containers: [] };
  queue.push(otw.containers);
  if (otw.containers.length === 0) return;
  queue.push([{ name: "Kolwezi", code: "KLZ" }], otw.suppliers ?? [], otw.pos ?? []);
  if ((otw.pos ?? []).length > 0) queue.push(otw.lines ?? []);
  queue.push(otw.stockItems ?? []);
}

const inv = (stockItemId: number, locationId: number, quantity: number) => ({
  stockItemId,
  locationId,
  quantity: String(quantity),
});

// Ten-day window: a sales total of N is N/10 units per day.
const window = ["2026-03-01", "2026-03-10"] as const;

beforeEach(() => {
  vi.clearAllMocks();
  harness.state.selectResults.splice(0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  expect(harness.state.selectResults).toEqual([]);
});

describe("buildStockTransferSuggestionContext", () => {
  it("rejects same-location transfers and unknown locations", async () => {
    await expect(buildStockTransferSuggestionContext(3, 1, 1, ...window)).rejects.toThrow(
      "Source and destination locations must be different"
    );
    harness.state.selectResults.push([], [DEST]);
    await expect(buildStockTransferSuggestionContext(3, 1, 2, ...window)).rejects.toThrow(
      "Source location not found for this company"
    );
    harness.state.selectResults.push([SOURCE], []);
    await expect(buildStockTransferSuggestionContext(3, 1, 2, ...window)).rejects.toThrow(
      "Destination location not found for this company"
    );
  });

  it("suggests moving surplus toward faster-selling or understocked locations", async () => {
    queueSuggestion({
      inventory: [
        inv(10, 1, 100),
        inv(10, 2, 2),
        inv(11, 2, 50),
        inv(12, 1, 50),
        inv(13, 1, 40),
        inv(13, 2, 20),
        inv(14, 1, 30),
        inv(15, 1, 10),
      ],
      sales: [
        { stockItemId: 10, locationId: 1, quantity: "6" },
        { stockItemId: 10, locationId: 1, quantity: "4" },
        { stockItemId: 10, locationId: 2, quantity: "30" },
        { stockItemId: 10, locationId: null, quantity: "999" },
        { stockItemId: 13, locationId: 2, quantity: "5" },
        { stockItemId: 14, locationId: 2, quantity: "10" },
        { stockItemId: 15, locationId: 1, quantity: "100" },
        { stockItemId: 15, locationId: 2, quantity: "200" },
      ],
      items: [
        { id: 10, name: "Rice", code: "RICE" },
        { id: 11, name: "Oil", code: "OIL" }, // nothing at the source
        { id: 12, name: "Salt", code: "SALT" }, // no demand anywhere
        { id: 13, name: "Beans", code: "BEAN" }, // destination already covered
        { id: 14, name: "Sugar", code: "SUG" },
        { id: 15, name: "Flour", code: "FLR" }, // source has no surplus over its own sales
      ],
      old: [
        { stockItemId: 10, quantity: "7", voucherDate: "2026-02-15" },
        { stockItemId: 10, quantity: "5", voucherDate: "2026-02-01" },
        { stockItemId: 10, quantity: "1", voucherDate: "2026-02-20" },
      ],
    });

    const result = await buildStockTransferSuggestionContext(3, 1, 2, ...window);
    expect(result).toMatchObject({
      sourceLocationId: 1,
      sourceLocationName: "Hadi 1",
      destinationLocationId: 2,
      destinationLocationName: "Kolwezi",
      dateFrom: "2026-03-01",
      dateTo: "2026-03-10",
      days: 10,
      aggressiveness: "normal",
      otwAvailable: false,
      otwSkippedReason: "No OTW found for these suggested items.",
      oldTransferSummary: "3 previous transfer line(s) found from Hadi 1 to Kolwezi.",
    });
    expect(result.analysisSummary).toBe(
      "Analyzed 6 active item(s) over 2026-03-01 to 2026-03-10 (10 day(s), normal mode). Found 2 item(s) worth " +
        "transferring from Hadi 1 to Kolwezi. 3 previous transfer line(s) found from Hadi 1 to Kolwezi. " +
        "No OTW found for these suggested items."
    );

    // Rice: source keeps 14 days × 1/day; destination wants 21 days × 3/day = 63, holds 2.
    // Sugar: source has no sales so keeps nothing; destination wants 21 × 1 = 21.
    expect(result.items).toEqual([
      {
        stockItemId: 10,
        stockItemName: "Rice",
        stockItemCode: "RICE",
        sourceQty: 100,
        destinationQty: 2,
        sourceSalesQty: 10,
        destinationSalesQty: 30,
        sourceSalesRate: 1,
        destinationSalesRate: 3,
        otwQty: 0,
        otwDetails: undefined,
        otwSummary: undefined,
        suggestedQty: 61,
        reason:
          "Rice sells faster in Kolwezi (3.00/day) than in Hadi 1 (1.00/day); Kolwezi stock (2) covers less than 21 " +
          "days of sales; Hadi 1 has surplus of 86 above its safety stock; Transferred 3 time(s) before, 13 total " +
          "units, last on 2026-02-20. Destination sold this item well after previous transfers.",
        confidence: 0.75,
        previousTransferQty: 13,
        previousTransferCount: 3,
        lastTransferDate: "2026-02-20",
        oldTransferSummary:
          "Transferred 3 time(s) before, 13 total units, last on 2026-02-20. Destination sold this item well after previous transfers.",
      },
      expect.objectContaining({
        stockItemId: 14,
        suggestedQty: 21,
        sourceSalesRate: 0,
        destinationSalesRate: 1,
        confidence: 0.55,
        previousTransferQty: 0,
        previousTransferCount: 0,
        lastTransferDate: null,
        oldTransferSummary: "No previous transfers found between these locations for this item.",
        reason:
          "Sugar sells faster in Kolwezi (1.00/day) than in Hadi 1 (0.00/day); Kolwezi stock (0) covers less than 21 " +
          "days of sales; Hadi 1 has surplus of 30 above its safety stock",
      }),
    ]);
  });

  it("scales safety days with aggressiveness", async () => {
    const scenario = () =>
      queueSuggestion({
        inventory: [inv(10, 1, 100)],
        sales: [
          { stockItemId: 10, locationId: 1, quantity: "10" },
          { stockItemId: 10, locationId: 2, quantity: "20" },
        ],
        items: [{ id: 10, name: "Rice", code: "RICE" }],
      });

    // Destination target: 2/day × {14, 21, 30} days; the source keeps 1/day × {21, 14, 7}.
    scenario();
    let result = await buildStockTransferSuggestionContext(3, 1, 2, ...window, { aggressiveness: "conservative" });
    expect(result.items[0]).toMatchObject({ suggestedQty: 28 });
    expect(result.items[0].reason).toContain("covers less than 14 days");
    expect(result.items[0].reason).toContain("surplus of 79");
    expect(result.analysisSummary).toContain("conservative mode");

    scenario();
    result = await buildStockTransferSuggestionContext(3, 1, 2, ...window, { aggressiveness: "aggressive" });
    expect(result.items[0]).toMatchObject({ suggestedQty: 60 });
    expect(result.items[0].reason).toContain("surplus of 93");

    scenario();
    result = await buildStockTransferSuggestionContext(3, 1, 2, ...window);
    expect(result.items[0]).toMatchObject({ suggestedQty: 42 });
    expect(result.items[0].reason).toContain("surplus of 86");
  });

  it("caps the suggestion at the source surplus and keeps a unit back when the source sells", async () => {
    queueSuggestion({
      inventory: [inv(10, 1, 3), inv(11, 1, 1), inv(12, 1, 2.8)],
      sales: [
        { stockItemId: 10, locationId: 1, quantity: "1" },
        { stockItemId: 10, locationId: 2, quantity: "300" },
        { stockItemId: 11, locationId: 1, quantity: "1" },
        { stockItemId: 11, locationId: 2, quantity: "300" },
        { stockItemId: 12, locationId: 1, quantity: "0.5" },
        { stockItemId: 12, locationId: 2, quantity: "300" },
      ],
      items: [
        { id: 10, name: "Rice", code: "RICE" },
        { id: 11, name: "Oil", code: "OIL" },
        { id: 12, name: "Salt", code: "SALT" },
      ],
    });
    // Rice: 0.1/day × 14 = 1.4 kept, surplus 1.6 → 1. Oil keeps its single unit.
    // Salt sells 0.05/day (0.7 over 14 days) but still keeps one whole unit back.
    const result = await buildStockTransferSuggestionContext(3, 1, 2, ...window);
    expect(result.items.map((item) => [item.stockItemId, item.suggestedQty])).toEqual([
      [10, 1],
      [12, 1],
    ]);
  });

  it("flags destination stockout risk even when the source sells faster", async () => {
    queueSuggestion({
      inventory: [inv(10, 1, 500), inv(10, 2, 10), inv(11, 1, 500), inv(11, 2, 30), inv(12, 1, 500), inv(12, 2, 5)],
      sales: [
        { stockItemId: 10, locationId: 1, quantity: "100" },
        { stockItemId: 10, locationId: 2, quantity: "10" },
        { stockItemId: 11, locationId: 1, quantity: "100" },
        { stockItemId: 11, locationId: 2, quantity: "10" },
        { stockItemId: 12, locationId: 1, quantity: "10" },
        { stockItemId: 12, locationId: 2, quantity: "10" },
      ],
      items: [
        { id: 10, name: "Rice", code: "RICE" },
        { id: 11, name: "Oil", code: "OIL" },
        { id: 12, name: "Salt", code: "SALT" },
      ],
    });
    // Destination sells 1/day: 10 on hand is under 21 days, 30 is not.
    // Salt sells at the same rate in both places, so only the stockout is cited.
    const result = await buildStockTransferSuggestionContext(3, 1, 2, ...window);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ stockItemId: 12, suggestedQty: 16 });
    expect(result.items[0].reason).toBe(
      "Kolwezi stock (5) covers less than 21 days of sales; Hadi 1 has surplus of 486 above its safety stock"
    );
    expect(result.items[1]).toMatchObject({ stockItemId: 10, suggestedQty: 11 });
    expect(result.items[1].reason).toBe(
      "Kolwezi stock (10) covers less than 21 days of sales; Hadi 1 has surplus of 360 above its safety stock"
    );
  });

  it("orders suggestions by confidence, then by quantity", async () => {
    queueSuggestion({
      inventory: [inv(10, 1, 100), inv(11, 1, 100), inv(12, 1, 100)],
      sales: [
        { stockItemId: 10, locationId: 2, quantity: "10" },
        { stockItemId: 11, locationId: 2, quantity: "30" },
        { stockItemId: 12, locationId: 2, quantity: "20" },
      ],
      items: [
        { id: 12, name: "C", code: "C" },
        { id: 10, name: "A", code: "A" },
        { id: 11, name: "B", code: "B" },
      ],
      old: [{ stockItemId: 10, quantity: "2", voucherDate: "2026-01-01" }],
    });
    const result = await buildStockTransferSuggestionContext(3, 1, 2, ...window);
    expect(result.items.map((item) => [item.stockItemId, item.confidence, item.suggestedQty])).toEqual([
      [10, 0.75, 21],
      [11, 0.55, 63],
      [12, 0.55, 42],
    ]);
  });

  it("explains when nothing qualifies and counts a single-day window", async () => {
    queueSuggestion({ items: [{ id: 10, name: "Rice", code: "RICE" }] });
    const result = await buildStockTransferSuggestionContext(3, 1, 2, "2026-03-05", "2026-03-05", { itemLimit: 5 });
    expect(result.days).toBe(1);
    expect(result.items).toEqual([]);
    expect(result.analysisSummary).toBe(
      "Analyzed 1 active item(s) over 2026-03-05 to 2026-03-05 (1 day(s), normal mode). No items currently qualify " +
        "for transfer from Hadi 1 to Kolwezi (no surplus, or destination demand does not justify a move, or Stock OTW " +
        "already covers the need). No previous transfers found from Hadi 1 to Kolwezi. No OTW found for these suggested items."
    );
    // A reversed range still counts as one day rather than a negative window.
    queueSuggestion({ items: [] });
    await expect(buildStockTransferSuggestionContext(3, 1, 2, "2026-03-10", "2026-03-01")).resolves.toMatchObject({
      days: 1,
    });
  });

  it("subtracts on-the-way stock for this destination and trims for an arrival within a week", async () => {
    queueSuggestion({
      inventory: [inv(10, 1, 100), inv(10, 2, 2)],
      sales: [
        { stockItemId: 10, locationId: 1, quantity: "10" },
        { stockItemId: 10, locationId: 2, quantity: "30" },
      ],
      items: [{ id: 10, name: "Rice", code: "RICE" }],
      otw: {
        containers: [
          {
            id: 1,
            containerNumber: "DIRECT1",
            supplierId: 8,
            shopName: " kolwezi ",
            eta: "2026-03-13",
            importDate: "2026-02-01",
          },
          { id: 2, containerNumber: "UNKNOWN2", supplierId: 8, shopName: null, eta: null, trackingLocation: "Durban" },
          {
            id: 3,
            containerNumber: "OTHER3",
            supplierId: 9,
            shopName: "Hadi 4",
            eta: "2026-03-11",
            trackingLastStatus: "Sailing",
          },
        ],
        suppliers: [{ id: 8, legalName: "Acme Foods" }],
        pos: [
          { id: 21, containerId: 1 },
          { id: 22, containerId: 2 },
          { id: 23, containerId: 3 },
        ],
        lines: [
          { poId: 21, stockItemId: 10, stockItemCode: "RICE", itemName: "Rice", quantity: "20" },
          { poId: 22, stockItemId: null, stockItemCode: null, itemName: "  RICE ", quantity: "5" },
          { poId: 23, stockItemId: null, stockItemCode: " rice ", itemName: null, quantity: "100" },
          { poId: 22, stockItemId: null, stockItemCode: null, itemName: "Unknown thing", quantity: "9" },
          { poId: 22, stockItemId: 10, stockItemCode: null, itemName: null, quantity: "0" },
        ],
        stockItems: [{ id: 10, code: "RICE", name: "Rice" }],
      },
    });

    const result = await buildStockTransferSuggestionContext(3, 1, 2, ...window);
    expect(result.otwAvailable).toBe(true);
    expect(result.otwSkippedReason).toBe("Included Stock OTW from Inventory.");
    const [rice] = result.items;
    // Need 63 − (2 on hand + 25 counted OTW) = 36, trimmed by 20% for the 3-day ETA.
    expect(rice.otwQty).toBe(25);
    expect(rice.suggestedQty).toBe(28);
    expect(rice.otwDetails).toEqual([
      {
        containerNumber: "DIRECT1",
        quantity: 20,
        eta: "2026-03-13",
        trackingStatus: null,
        currentLocation: null,
        shopName: " kolwezi ",
        supplierName: "Acme Foods",
        importDate: "2026-02-01",
        matchType: "direct",
      },
      expect.objectContaining({
        containerNumber: "UNKNOWN2",
        matchType: "unknown",
        currentLocation: "Durban",
        shopName: null,
      }),
      expect.objectContaining({
        containerNumber: "OTHER3",
        matchType: "other",
        trackingStatus: "Sailing",
        supplierName: null,
      }),
    ]);
    expect(rice.otwSummary).toBe(
      "OTW 25 across 2 containers (some shop unknown); OTW exists but assigned to another shop, not counted for this destination"
    );
    expect(rice.reason).toContain(`${rice.otwSummary}; OTW arriving soon, reduced suggested qty accordingly`);
  });

  it("describes a single counted container and ignores far, past or invalid ETAs", async () => {
    const run = async (container: Record<string, unknown>) => {
      queueSuggestion({
        inventory: [inv(10, 1, 100)],
        sales: [{ stockItemId: 10, locationId: 2, quantity: "30" }],
        items: [{ id: 10, name: "Rice", code: "RICE" }],
        otw: {
          containers: [{ id: 1, containerNumber: "C1", supplierId: 8, ...container }],
          pos: [{ id: 21, containerId: 1 }],
          lines: [{ poId: 21, stockItemId: 10, quantity: "10" }],
          stockItems: [{ id: 10, code: null, name: "Rice" }],
        },
      });
      return (await buildStockTransferSuggestionContext(3, 1, 2, ...window)).items[0];
    };

    let rice = await run({ shopName: "KLZ", eta: "2026-04-30" });
    expect(rice.otwSummary).toBe("OTW 10 in container C1 for Kolwezi, ETA 2026-04-30");
    expect(rice.suggestedQty).toBe(53);
    expect(rice.reason).not.toContain("arriving soon");

    rice = await run({ shopName: "", eta: "2026-03-01" });
    expect(rice.otwSummary).toBe("OTW 10 in container C1, shop unknown, ETA 2026-03-01");
    expect(rice.suggestedQty).toBe(53);

    rice = await run({ shopName: "Kolwezi", eta: "not a date" });
    expect(rice.suggestedQty).toBe(53);

    rice = await run({ shopName: null, eta: null });
    expect(rice.otwSummary).toBe("OTW 10 in container C1, shop unknown");

    rice = await run({ shopName: "Kolwezi", eta: "2026-03-17T12:00:00Z" });
    expect(rice.suggestedQty).toBe(42);
  });

  it("notes other-shop containers without counting them", async () => {
    queueSuggestion({
      inventory: [inv(10, 1, 100)],
      sales: [{ stockItemId: 10, locationId: 2, quantity: "30" }],
      items: [{ id: 10, name: "Rice", code: "RICE" }],
      otw: {
        containers: [{ id: 1, containerNumber: "C1", supplierId: 8, shopName: "Likasi", eta: "2026-03-11" }],
        pos: [{ id: 21, containerId: 1 }],
        lines: [{ poId: 21, stockItemId: 10, quantity: "40" }],
        stockItems: [],
      },
    });
    const [rice] = (await buildStockTransferSuggestionContext(3, 1, 2, ...window)).items;
    expect(rice.otwQty).toBe(0);
    expect(rice.suggestedQty).toBe(63);
    expect(rice.otwSummary).toBe("OTW exists but assigned to another shop, not counted for this destination");
    expect(rice.reason).not.toContain("arriving soon");
  });

  it("only lets a counted container's ETA trim the suggestion", async () => {
    queueSuggestion({
      inventory: [inv(10, 1, 100)],
      sales: [{ stockItemId: 10, locationId: 2, quantity: "30" }],
      items: [{ id: 10, name: "Rice", code: "RICE" }],
      otw: {
        containers: [
          { id: 1, containerNumber: "C1", supplierId: 8, shopName: "Likasi", eta: "2026-03-11" },
          { id: 2, containerNumber: "C2", supplierId: 8, shopName: "Kolwezi", eta: "2026-04-30" },
        ],
        pos: [
          { id: 21, containerId: 1 },
          { id: 22, containerId: 2 },
        ],
        lines: [
          { poId: 21, stockItemId: 10, quantity: "40" },
          { poId: 22, stockItemId: 10, quantity: "10" },
        ],
        stockItems: [],
      },
    });
    const [rice] = (await buildStockTransferSuggestionContext(3, 1, 2, ...window)).items;
    expect(rice.otwQty).toBe(10);
    expect(rice.suggestedQty).toBe(53);
    expect(rice.otwSummary).toBe(
      "OTW 10 in container C2 for Kolwezi, ETA 2026-04-30; OTW exists but assigned to another shop, not counted for this destination"
    );
  });

  it("skips an item whose need is fully covered by OTW, and one trimmed to nothing", async () => {
    queueSuggestion({
      inventory: [inv(10, 1, 100), inv(11, 1, 100)],
      sales: [
        { stockItemId: 10, locationId: 2, quantity: "10" },
        { stockItemId: 11, locationId: 2, quantity: "10" },
      ],
      items: [
        { id: 10, name: "Rice", code: "RICE" },
        { id: 11, name: "Oil", code: "OIL" },
      ],
      otw: {
        containers: [{ id: 1, containerNumber: "C1", supplierId: 8, shopName: "Kolwezi", eta: "2026-03-12" }],
        pos: [{ id: 21, containerId: 1 }],
        lines: [
          { poId: 21, stockItemId: 10, quantity: "25" },
          { poId: 21, stockItemId: 11, quantity: "20" },
        ],
        stockItems: [],
      },
    });
    // Rice: need 21 − 25 ≤ 0. Oil: need 1, trimmed to floor(0.8) = 0.
    const result = await buildStockTransferSuggestionContext(3, 1, 2, ...window);
    expect(result.items).toEqual([]);
    expect(result.otwAvailable).toBe(true);
    expect(result.analysisSummary).toContain("Included Stock OTW from Inventory.");
  });

  it("skips OTW containers whose purchase orders have no lines", async () => {
    queueSuggestion({
      inventory: [inv(10, 1, 100)],
      sales: [{ stockItemId: 10, locationId: 2, quantity: "30" }],
      items: [{ id: 10, name: "Rice", code: "RICE" }],
      otw: {
        containers: [{ id: 1, containerNumber: "C1", supplierId: 8, shopName: "Kolwezi" }],
        pos: [],
        stockItems: [],
      },
    });
    const result = await buildStockTransferSuggestionContext(3, 1, 2, ...window);
    expect(result.otwAvailable).toBe(false);
    expect(result.items[0]).toMatchObject({ otwQty: 0, suggestedQty: 63 });
  });
});

describe("buildStockTransferByTargetQuantityContext", () => {
  const row = (stockItemId: number, locationId: number, quantity: number | string, stockGroupId: number | null) => ({
    stockItemId,
    locationId,
    quantity: String(quantity),
    stockItemName: `Item ${stockItemId}`,
    stockItemCode: `I${stockItemId}`,
    stockGroupId,
  });

  it("needs at least one source other than the destination", async () => {
    await expect(buildStockTransferByTargetQuantityContext(3, [9, 9], 9, 10)).rejects.toThrow(
      "No valid source locations provided"
    );
    expect(harness.db.select).not.toHaveBeenCalled();
  });

  it("fills the target from sources in order, using only groups the destination carries", async () => {
    harness.state.selectResults.push(
      [
        { id: 1, name: "Hadi 1" },
        { id: 2, name: "Hadi 2" },
        { id: 9, name: "Kolwezi" },
      ],
      [
        row(10, 9, 3, 1),
        row(11, 9, 0, 2),
        row(10, 1, 4, 1),
        row(12, 1, "7.6", 1),
        row(13, 1, 50, 1),
        row(14, 1, 100, 3),
        row(15, 1, 20, null),
        row(16, 1, 0, 1),
        row(17, 1, "0.4", 1),
        row(18, 2, 30, 1),
      ],
      [
        { id: 1, name: "Bales A" },
        { id: 3, name: "Bales C" },
      ]
    );
    const result = await buildStockTransferByTargetQuantityContext(3, [1, 9, 1, 2], 9, 60.9);
    expect(result).toEqual({
      destinationLocationId: 9,
      destinationLocationName: "Kolwezi",
      targetQty: 60,
      achievedQty: 60,
      shortfall: false,
      noEligibleStock: false,
      // Group 2 is listed at the destination but with no stock.
      eligibleStockGroupCount: 1,
      drafts: [
        {
          sourceLocationId: 1,
          sourceLocationName: "Hadi 1",
          destinationLocationId: 9,
          destinationLocationName: "Kolwezi",
          totalQty: 60,
          items: [
            {
              stockItemId: 12,
              stockItemName: "Item 12",
              stockItemCode: "I12",
              quantity: 7,
              currentStock: 7,
              destinationQty: 0,
              stockGroupId: 1,
              stockGroupName: "Bales A",
              reason: 'Stock group "Bales A" already carried at Kolwezi; destination currently holds 0.',
            },
            expect.objectContaining({ stockItemId: 13, quantity: 50, currentStock: 50, destinationQty: 0 }),
            expect.objectContaining({
              stockItemId: 10,
              quantity: 3,
              currentStock: 4,
              destinationQty: 3,
              reason: 'Stock group "Bales A" already carried at Kolwezi; destination currently holds 3.',
            }),
          ],
        },
      ],
    });
  });

  it("can use any stock and reports a shortfall across several sources", async () => {
    harness.state.selectResults.push(
      [{ id: 1, name: "Hadi 1" }],
      [row(12, 1, 5, null), row(13, 2, 8, 4), row(13, 9, 1, null)],
      [{ id: 4, name: "Bales D" }]
    );
    const result = await buildStockTransferByTargetQuantityContext(3, [1, 2], 9, 20, {
      onlyDestinationStockGroups: false,
    });
    expect(result).toMatchObject({
      destinationLocationName: "Location #9",
      targetQty: 20,
      achievedQty: 13,
      shortfall: true,
      noEligibleStock: false,
      eligibleStockGroupCount: 0,
    });
    expect(result.drafts.map((draft) => [draft.sourceLocationName, draft.totalQty])).toEqual([
      ["Hadi 1", 5],
      ["Location #2", 8],
    ]);
    expect(result.drafts[0].items[0]).toMatchObject({
      stockGroupId: null,
      stockGroupName: null,
      reason: "Available at Hadi 1; destination currently holds 0.",
    });
    expect(result.drafts[1].items[0]).toMatchObject({
      stockGroupName: "Bales D",
      reason: "Available at Location #2; destination currently holds 1.",
    });
  });

  it("reports when no eligible stock exists and never queries groups without any", async () => {
    harness.state.selectResults.push([], [row(12, 1, 5, null)]);
    const result = await buildStockTransferByTargetQuantityContext(3, [1], 9, 10);
    expect(result).toMatchObject({ achievedQty: 0, shortfall: true, noEligibleStock: true, drafts: [] });
    expect(harness.db.select).toHaveBeenCalledTimes(2);
  });

  it("treats a non-positive target as already met", async () => {
    harness.state.selectResults.push([], [row(12, 1, 5, 1), row(13, 9, 2, 1)], [{ id: 1, name: "Bales A" }]);
    const result = await buildStockTransferByTargetQuantityContext(3, [1], 9, -4);
    expect(result).toMatchObject({ targetQty: 0, achievedQty: 0, shortfall: false, noEligibleStock: true, drafts: [] });
  });

  it("labels groups whose name is missing as unassigned", async () => {
    harness.state.selectResults.push([], [row(12, 1, 5, 7), row(13, 9, 2, 7)], []);
    const result = await buildStockTransferByTargetQuantityContext(3, [1], 9, 5);
    expect(result.drafts[0].items[0]).toMatchObject({
      stockGroupName: null,
      reason: 'Stock group "Unassigned" already carried at Location #9; destination currently holds 0.',
    });
  });
});
