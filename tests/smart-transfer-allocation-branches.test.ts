import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inArray, like } from "drizzle-orm";

// The history analyzer and the OTW loader have their own suites; here they are
// replaced so each allocation branch (classification, exclusion reason, source
// reserve, OTW, filters, targets) can be set up directly. Items, inventory and
// source-location sales stay real rows.
const historyMock = vi.hoisted(() => vi.fn());
const otwMock = vi.hoisted(() => vi.fn());
vi.mock("../server/services/smartTransferHistoryAnalysis", () => ({
  analyzeLastTwoMultiSourceTransfers: historyMock,
}));
vi.mock("../server/services/stockTransferAnalysis", () => ({
  loadOtwStockByItem: otwMock,
}));

import { db } from "../server/db";
import * as schema from "../shared/schema";
import { buildSmartTransferPreview } from "../server/services/smartTransferAllocation";
import type {
  HistoricalTransferItemPerformance,
  HistoricalTransferOrder,
  SmartTransferHistoryResult,
} from "../server/services/smartTransferHistoryAnalysis";
import type { OtwContainerDetail } from "../server/services/stockTransferAnalysis";

const RUN_ID = `stab-${Date.now()}`;
const AS_OF = "2026-08-31";
let companyId = 0;
let s1 = 0;
let s2 = 0;
let destinationId = 0;
let groupA = 0;
let groupB = 0;
let categoryA = 0;
const item: Record<string, number> = {};

async function cleanup(): Promise<void> {
  const companyIds = (
    await db
      .select({ id: schema.companies.id })
      .from(schema.companies)
      .where(like(schema.companies.name, `${RUN_ID}%`))
  ).map((row) => row.id);
  if (companyIds.length === 0) return;
  const voucherIds = (
    await db
      .select({ id: schema.vouchers.id })
      .from(schema.vouchers)
      .where(inArray(schema.vouchers.companyId, companyIds))
  ).map((row) => row.id);
  if (voucherIds.length > 0) {
    await db.delete(schema.salesItems).where(inArray(schema.salesItems.voucherId, voucherIds));
    await db.delete(schema.vouchers).where(inArray(schema.vouchers.id, voucherIds));
  }
  await db.delete(schema.inventory).where(inArray(schema.inventory.companyId, companyIds));
  await db.delete(schema.stockItems).where(inArray(schema.stockItems.companyId, companyIds));
  await db.delete(schema.stockCategories).where(inArray(schema.stockCategories.companyId, companyIds));
  await db.delete(schema.stockGroups).where(inArray(schema.stockGroups.companyId, companyIds));
  await db.delete(schema.locations).where(inArray(schema.locations.companyId, companyIds));
  await db.delete(schema.companies).where(inArray(schema.companies.id, companyIds));
}

let saleSeq = 0;
async function createSourceSale(stockItemId: number, locationId: number, quantity: number, voucherDate: string) {
  saleSeq += 1;
  const [voucher] = await db
    .insert(schema.vouchers)
    .values({
      companyId,
      locationId,
      voucherNumber: `${RUN_ID}-S${saleSeq}`,
      voucherType: "Sales",
      voucherDate,
      description: RUN_ID,
      totalAmount: "0",
    })
    .returning();
  await db.insert(schema.salesItems).values({
    voucherId: voucher.id,
    stockItemId,
    quantity: String(quantity),
    sellingPrice: "1",
    costPrice: "1",
    totalSales: String(quantity),
    totalCost: String(quantity),
    profit: "0",
  });
}

function perf(
  key: string,
  overrides: Partial<HistoricalTransferItemPerformance> & Pick<HistoricalTransferItemPerformance, "classification">
): HistoricalTransferItemPerformance {
  return {
    stockItemId: item[key],
    stockItemName: `History ${key}`,
    stockItemCode: `H-${key}`,
    historicalSourceLocationIds: [s1],
    historicalSourceLocationNames: ["Src One"],
    olderTransferQty: 0,
    newerTransferQty: 10,
    totalTransferredQty: 10,
    salesAfterOlderTransfer: 0,
    salesAfterNewerTransfer: 5,
    totalSalesSinceOlderTransfer: 5,
    olderSellThroughPercentage: 0,
    newerSellThroughPercentage: 50,
    overallSellThroughPercentage: 50,
    averageSalesPerDay: 0,
    latestSalesPerDay: 0,
    currentDestinationQty: 0,
    estimatedDaysOfStockRemaining: null,
    daysToSellOlderTransfer: null,
    daysToSellNewerTransfer: null,
    classificationLabel: `Label ${overrides.classification}`,
    explanation: "",
    ...overrides,
  };
}

function order(transferId: number): HistoricalTransferOrder {
  return {
    transferId,
    voucherId: transferId,
    voucherNumber: `T-${transferId}`,
    voucherDate: "2026-08-01",
    sourceLocationIds: [s1],
    sourceLocationNames: ["Src One"],
    destinationLocationId: destinationId,
    destinationLocationName: "Dest",
    totalQuantity: 0,
    items: [],
  };
}

function history(
  items: HistoricalTransferItemPerformance[],
  orders: { newer: HistoricalTransferOrder | null; older: HistoricalTransferOrder | null }
): SmartTransferHistoryResult {
  return {
    companyId,
    destinationLocationId: destinationId,
    destinationLocationName: "Dest",
    selectedSourceLocationIds: [s1, s2],
    selectedSourceLocationNames: ["Src One", "Src Two"],
    asOfDate: AS_OF,
    newerTransfer: orders.newer,
    olderTransfer: orders.older,
    items,
    summary: "mock history",
  };
}

function otwDetail(matchType: OtwContainerDetail["matchType"], quantity: number): OtwContainerDetail {
  return {
    containerNumber: `C-${matchType}`,
    quantity,
    eta: null,
    trackingStatus: null,
    currentLocation: null,
    shopName: matchType === "unknown" ? null : "Dest",
    supplierName: null,
    importDate: null,
    matchType,
  };
}

// Every non-excluded and excluded case at once.
function fullHistoryItems(): HistoricalTransferItemPerformance[] {
  return [
    // Need: max(ceil(5*21 - (10 + 5 OTW)), ceil(50*1.25 - 15)) = max(90, 48) = 90; capacity 40 + 25 = 65.
    perf("strong", {
      classification: "strong_seller",
      olderTransferQty: 30,
      newerTransferQty: 50,
      totalTransferredQty: 80,
      totalSalesSinceOlderTransfer: 70,
      latestSalesPerDay: 5,
      averageSalesPerDay: 4,
      currentDestinationQty: 10,
      estimatedDaysOfStockRemaining: 2,
      overallSellThroughPercentage: 87.5,
    }),
    // No recent rate and no newer quantity: falls back to the average rate and the older quantity.
    // Need: max(ceil(2*21), ceil(20*1)) = 42; Src One keeps a 42-unit local reserve out of 100.
    perf("good", {
      classification: "good_seller",
      olderTransferQty: 20,
      newerTransferQty: 0,
      latestSalesPerDay: 0,
      averageSalesPerDay: 2,
    }),
    // Need: max(21, ceil(40*0.75)) = 30; capacity limited by Src Two's 10 units.
    perf("normal", { classification: "normal_seller", latestSalesPerDay: 1, newerTransferQty: 40 }),
    // Low coverage slow seller: need is the coverage need only, ceil(0.5*21 - 2) = 9.
    perf("slowLow", {
      classification: "slow_seller",
      latestSalesPerDay: 0.5,
      currentDestinationQty: 2,
      estimatedDaysOfStockRemaining: 5,
    }),
    // Slow seller with plenty of coverage: need forced to zero.
    perf("slowHigh", {
      classification: "slow_seller",
      latestSalesPerDay: 0.05,
      currentDestinationQty: 2,
      estimatedDaysOfStockRemaining: 40,
    }),
    perf("covered", {
      classification: "good_seller",
      latestSalesPerDay: 2,
      currentDestinationQty: 61,
      estimatedDaysOfStockRemaining: 30.6,
    }),
    perf("over", { classification: "overstocked", currentDestinationQty: 50 }),
    perf("quiet", { classification: "no_recent_sales" }),
    perf("empty", { classification: "strong_seller", latestSalesPerDay: 3 }),
    perf("inactive", { classification: "strong_seller", latestSalesPerDay: 3 }),
    // Historical need dominates: max(ceil(1*21), ceil(40*1.25)) = 50.
    perf("strongHist", { classification: "strong_seller", latestSalesPerDay: 1, newerTransferQty: 40 }),
    // Historical need from the older quantity dominates: max(ceil(0.1*21), ceil(30*1)) = 30.
    perf("older", {
      classification: "good_seller",
      olderTransferQty: 30,
      newerTransferQty: 0,
      latestSalesPerDay: 0,
      averageSalesPerDay: 0.1,
    }),
    // An unrecognised classification ranks last, has no historical multiplier and a neutral confidence.
    perf("mystery", {
      classification: "mystery" as HistoricalTransferItemPerformance["classification"],
      latestSalesPerDay: 1,
    }),
  ];
}

beforeAll(async () => {
  await cleanup();
  const [company] = await db
    .insert(schema.companies)
    .values({ code: RUN_ID.toUpperCase(), name: `${RUN_ID}-company`, baseCurrency: "USD" })
    .returning();
  companyId = company.id;
  const locs = await db
    .insert(schema.locations)
    .values(["Src One", "Src Two", "Dest"].map((name, index) => ({ companyId, code: `${RUN_ID}-${index}`, name })))
    .returning();
  [s1, s2, destinationId] = locs.map((row) => row.id);
  const groups = await db
    .insert(schema.stockGroups)
    .values([
      { companyId, code: `${RUN_ID}-GA`, name: `${RUN_ID}-A` },
      { companyId, code: `${RUN_ID}-GB`, name: `${RUN_ID}-B` },
    ])
    .returning();
  [groupA, groupB] = groups.map((row) => row.id);
  const [category] = await db
    .insert(schema.stockCategories)
    .values({ companyId, name: `${RUN_ID}-cat` })
    .returning();
  categoryA = category.id;

  const keys = [
    "strong",
    "good",
    "normal",
    "slowLow",
    "slowHigh",
    "covered",
    "over",
    "quiet",
    "empty",
    "inactive",
    "mystery",
    "strongHist",
    "older",
  ];
  const rows = await db
    .insert(schema.stockItems)
    .values(
      keys.map((key) => ({
        companyId,
        code: `${RUN_ID}-${key}`,
        name: `Item ${key}`,
        uom: "BALE",
        stockGroupId: key === "good" ? groupB : key === "normal" ? null : groupA,
        categoryId: key === "strong" ? categoryA : null,
        active: key !== "inactive",
      }))
    )
    .returning();
  rows.forEach((row, index) => {
    item[keys[index]] = row.id;
  });

  const stock = (key: string, locationId: number, quantity: number, averageRate = 1) => ({
    companyId,
    locationId,
    stockItemId: item[key],
    quantity: String(quantity),
    averageRate: String(averageRate),
    totalValue: String(quantity * averageRate),
  });
  await db.insert(schema.inventory).values([
    stock("strong", s1, 40, 2.345),
    stock("strong", s2, 25),
    stock("good", s1, 100),
    stock("normal", s2, 10),
    stock("slowLow", s1, 20),
    stock("slowHigh", s1, 20),
    stock("covered", s1, 20),
    stock("over", s1, 5),
    stock("quiet", s1, 5),
    stock("empty", s1, 0),
    stock("inactive", s1, 50),
    stock("mystery", s2, 30),
    stock("strongHist", s2, 60),
    stock("older", s1, 50),
    stock("mystery", destinationId, 500), // destination stock is never a source
  ]);

  // 90 units in the last 30 days: 3/day, so 42 units are reserved at Src One.
  await createSourceSale(item.good, s1, 60, "2026-08-20");
  await createSourceSale(item.good, s1, 30, "2026-08-05");
  // Outside the 30-day window and after asOf: no reserve effect.
  await createSourceSale(item.good, s1, 500, "2026-07-15");
  await createSourceSale(item.good, s1, 500, "2026-09-02");
  // 2 units in 30 days is under 0.1/day: no reserve.
  await createSourceSale(item.normal, s2, 2, "2026-08-25");
});

afterAll(async () => {
  await cleanup();
});

beforeEach(() => {
  historyMock.mockReset();
  otwMock.mockReset();
  otwMock.mockResolvedValue({
    otwQtyByItem: new Map([[item.strong, 5.9]]),
    otwDetailsByItem: new Map([[item.strong, [otwDetail("unknown", 3), otwDetail("direct", 2)]]]),
  });
});

describe("buildSmartTransferPreview guards and empty history", () => {
  it("rejects an invalid company before reading history", async () => {
    await expect(buildSmartTransferPreview(0, [1], 2, 10)).rejects.toThrow("A valid company is required");
    await expect(buildSmartTransferPreview(-4, [1], 2, 10)).rejects.toThrow("A valid company is required");
    expect(historyMock).not.toHaveBeenCalled();
  });

  it("returns a read-only empty preview when history has no items", async () => {
    historyMock.mockResolvedValue(history([], { newer: null, older: null }));
    const result = await buildSmartTransferPreview(companyId, [s1, s2], destinationId, 25.7, {
      asOfDate: AS_OF,
      stockGroupIds: [groupA, groupA, 0],
      categoryIds: [categoryA, -1],
    });
    expect(historyMock).toHaveBeenCalledWith(companyId, [s1, s2], destinationId, { asOfDate: AS_OF });
    expect(otwMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      readOnly: true,
      targetQuantity: 25,
      achievedQuantity: 0,
      shortfallQuantity: 25,
      shortfall: true,
      includeOtw: true,
      targetCoverageDays: 21,
      stockGroupIds: [groupA],
      categoryIds: [categoryA],
      lines: [],
      excludedItems: [],
      totalsBySource: [],
      sourceLocationNames: ["Src One", "Src Two"],
      warnings: [
        "Only one completed historical transfer was found; the preview uses that transfer and later sales.",
        "No qualifying historical transfer items were available for allocation.",
      ],
      summary: "No smart transfer preview could be generated for Dest.",
    });
  });

  it("warns when the only history is a single order used as both newer and older", async () => {
    historyMock.mockResolvedValue(history([], { newer: order(7), older: order(7) }));
    const result = await buildSmartTransferPreview(companyId, [s1], destinationId, 0, { targetCoverageDays: 999 });
    expect(result.warnings[0]).toBe(
      "Fewer than 4 completed transfers were found; the preview uses all available history."
    );
    expect(result.targetCoverageDays).toBe(180);
    expect(result.targetQuantity).toBe(0);
    expect(historyMock.mock.calls[0][3].asOfDate).toBe(new Date().toISOString().slice(0, 10));
  });

  it("adds no history warning when distinct newer and older orders exist", async () => {
    historyMock.mockResolvedValue(history([], { newer: order(8), older: order(3) }));
    const result = await buildSmartTransferPreview(companyId, [s1], destinationId, 5, { targetCoverageDays: 0 });
    expect(result.warnings).toEqual(["No qualifying historical transfer items were available for allocation."]);
    expect(result.targetCoverageDays).toBe(1);
  });
});

describe("buildSmartTransferPreview allocation", () => {
  async function autoPreview(options: Parameters<typeof buildSmartTransferPreview>[4] = {}, target = 0) {
    historyMock.mockResolvedValue(history(fullHistoryItems(), { newer: order(8), older: order(3) }));
    return buildSmartTransferPreview(companyId, [s1, s2], destinationId, target, { asOfDate: AS_OF, ...options });
  }

  it("excludes every unsuitable item with its specific reason", async () => {
    const result = await autoPreview();
    const reasons = Object.fromEntries(
      result.excludedItems.map((row) => [Object.keys(item).find((key) => item[key] === row.stockItemId), row.reason])
    );
    expect(reasons).toEqual({
      slowHigh: "Current destination stock and OTW already cover the calculated demand.",
      covered: "Destination has 30 days of stock remaining and is actively selling.",
      over: "Destination stock is already high compared with recent sales.",
      quiet: "No qualifying sales were recorded after the recent transfer order(s).",
      empty:
        "No whole units remain across the selected sources (sources may be reserved for local sales or out of stock).",
      inactive: "The stock item is inactive, deleted or unavailable in the current company.",
    });
    const inactive = result.excludedItems.find((row) => row.stockItemId === item.inactive)!;
    // Unknown items keep the history's name and code.
    expect(inactive).toMatchObject({
      stockItemName: "History inactive",
      stockItemCode: "H-inactive",
      classificationLabel: "Label strong_seller",
      totalAvailableAcrossSources: 50,
      otwQty: 0,
    });
    const over = result.excludedItems.find((row) => row.stockItemId === item.over)!;
    expect(over).toMatchObject({ stockItemName: "Item over", destinationStock: 50, totalAvailableAcrossSources: 5 });
  });

  it("auto-targets the summed need and allocates it across sources", async () => {
    const result = await autoPreview();
    // Needs: strong 90, good 42, normal 30, slowLow 9, mystery 21, strongHist 50, older 30.
    expect(result.targetQuantity).toBe(90 + 42 + 30 + 9 + 21 + 50 + 30);
    const byItem = (key: string) => result.lines.filter((line) => line.stockItemId === item[key]);

    const strong = byItem("strong");
    expect(strong.map((line) => [line.sourceLocationName, line.suggestedQuantity])).toEqual([
      ["Src One", 40],
      ["Src Two", 25],
    ]);
    expect(strong[0]).toMatchObject({
      calculatedNeed: 90,
      itemSuggestedTotal: 65,
      otwQty: 5,
      effectiveDestinationStock: 15,
      sourceAverageRate: 2.35,
      sourceReserveQty: 0,
      confidence: 0.95,
      uom: "BALE",
      stockGroupId: groupA,
      categoryId: categoryA,
      reason:
        "Label strong_seller: 70 sold after 80 transferred across the last 4 qualifying order(s); destination stock 10; OTW 5 included; calculated need 90; Src One has 40 available after reserving 0; 40 allocated here (65 total for this item).",
    });

    const good = byItem("good");
    expect(good).toHaveLength(1);
    expect(good[0]).toMatchObject({
      sourceLocationId: s1,
      sourceCurrentStock: 100,
      sourceReserveQty: 42,
      availableAtSource: 58,
      calculatedNeed: 42,
      suggestedQuantity: 42,
      confidence: 0.82,
    });
    expect(good[0].reason).toContain("across the last 4 qualifying order(s); destination stock 0; calculated need 42");
    expect(good[0].reason).not.toContain("OTW");

    expect(byItem("normal")[0]).toMatchObject({
      calculatedNeed: 30,
      suggestedQuantity: 10,
      sourceReserveQty: 0,
      confidence: 0.68,
    });
    expect(byItem("normal")[0].reason).toContain("across the last 1 qualifying order(s)");
    expect(byItem("slowLow")[0]).toMatchObject({ calculatedNeed: 9, suggestedQuantity: 9, confidence: 0.48 });
    expect(byItem("mystery")[0]).toMatchObject({
      sourceLocationId: s2,
      calculatedNeed: 21,
      suggestedQuantity: 21,
      confidence: 0.5,
    });

    expect(byItem("strongHist")[0]).toMatchObject({ calculatedNeed: 50, suggestedQuantity: 50, sourceLocationId: s2 });
    expect(byItem("older")[0]).toMatchObject({ calculatedNeed: 30, suggestedQuantity: 30, sourceLocationId: s1 });

    expect(result.lines.map((line) => line.stockItemId)).toEqual([
      item.strong,
      item.strong,
      item.strongHist,
      item.good,
      item.older,
      item.normal,
      item.slowLow,
      item.mystery,
    ]);
    // strong is capped by 65 units of source stock, normal by 10.
    expect(result.achievedQuantity).toBe(65 + 42 + 10 + 9 + 21 + 50 + 30);
    expect(result.shortfallQuantity).toBe(45);
    expect(result.shortfall).toBe(true);
    expect(result.totalsBySource).toEqual([
      { sourceLocationId: s1, sourceLocationName: "Src One", suggestedQuantity: 40 + 42 + 30 + 9, lineCount: 4 },
      { sourceLocationId: s2, sourceLocationName: "Src Two", suggestedQuantity: 25 + 50 + 10 + 21, lineCount: 4 },
    ]);
    expect(result.warnings).toEqual([
      "The preview is short by 45 whole unit(s) because suitable calculated demand or source stock was insufficient.",
      "1 OTW item allocation(s) had no saved shop name and were conservatively counted toward destination stock.",
    ]);
    expect(result.summary).toBe(
      "Generated a read-only smart transfer preview for 227 of 272 requested whole unit(s) to Dest from 2 selected source location(s)."
    );
  });

  it("caps each item at three times its fair share of an explicit target", async () => {
    const result = await autoPreview({}, 20);
    // Seven candidates: cap is ceil(20 / 7 * 3) = 9 per item.
    const totals = new Map<number, number>();
    for (const line of result.lines) totals.set(line.stockItemId, line.itemSuggestedTotal);
    expect(result.targetQuantity).toBe(20);
    expect(result.achievedQuantity).toBe(20);
    expect(Math.max(...totals.values())).toBeLessThanOrEqual(9);
    expect(totals.get(item.strong)).toBe(9);
    expect(result.shortfall).toBe(false);
    expect(result.warnings.some((warning) => warning.startsWith("The preview is short"))).toBe(false);
  });

  it("skips OTW entirely when includeOtw is false", async () => {
    const result = await autoPreview({ includeOtw: false });
    expect(otwMock).not.toHaveBeenCalled();
    expect(result.includeOtw).toBe(false);
    const strong = result.lines.find((line) => line.stockItemId === item.strong)!;
    expect(strong.otwQty).toBe(0);
    expect(strong.effectiveDestinationStock).toBe(10);
    // ceil(5 * 21 - 10) = 95.
    expect(strong.calculatedNeed).toBe(95);
    expect(strong.reason).not.toContain("OTW");
    expect(result.warnings.some((warning) => warning.includes("OTW"))).toBe(false);
  });

  it("calls the OTW loader for the destination and stays silent when every OTW shop is known", async () => {
    otwMock.mockResolvedValue({
      otwQtyByItem: new Map([[item.strong, 2]]),
      otwDetailsByItem: new Map([[item.strong, [otwDetail("direct", 2)]]]),
    });
    const result = await autoPreview();
    expect(otwMock).toHaveBeenCalledWith(companyId, destinationId);
    expect(result.warnings.some((warning) => warning.includes("no saved shop name"))).toBe(false);
  });

  it("applies the stock-group filter, excluding items with no group", async () => {
    const result = await autoPreview({ stockGroupIds: [groupB] });
    const groupExcluded = result.excludedItems
      .filter((row) => row.reason === "Excluded by the selected stock-group filter.")
      .map((row) => row.stockItemId);
    expect(groupExcluded).toEqual(
      expect.arrayContaining([item.strong, item.normal, item.slowLow, item.mystery, item.over])
    );
    expect(new Set(result.lines.map((line) => line.stockItemId))).toEqual(new Set([item.good]));
    expect(result.stockGroupIds).toEqual([groupB]);
  });

  it("applies the category filter, excluding items with no category", async () => {
    const result = await autoPreview({ categoryIds: [categoryA] });
    const categoryExcluded = result.excludedItems
      .filter((row) => row.reason === "Excluded by the selected category filter.")
      .map((row) => row.stockItemId);
    expect(categoryExcluded).toEqual(expect.arrayContaining([item.good, item.normal, item.mystery]));
    expect(categoryExcluded).not.toContain(item.strong);
    expect(new Set(result.lines.map((line) => line.stockItemId))).toEqual(new Set([item.strong]));
  });
});
