import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray, like } from "drizzle-orm";
import { db } from "../server/db";
import * as schema from "../shared/schema";
import { analyzeLastTwoMultiSourceTransfers } from "../server/services/smartTransferHistoryAnalysis";

// Branch coverage for the smart transfer history analyzer: input validation,
// the empty-history result, every explanation wording, the legacy voucher-level
// source fallback, the four-order window, and the supplemental sales-based
// candidates that were never transferred.
const RUN_ID = `sthb-${Date.now()}`;
const AS_OF = "2026-08-31";
let companyId = 0;
let destinationId = 0;
let fourOrderDestinationId = 0;
let emptyDestinationId = 0;
let otherDestinationId = 0;
let sourceIds: number[] = [];
let unselectedSourceId = 0;
let otherCompanyLocationId = 0;
const item: Record<string, number> = {};

async function cleanup(): Promise<void> {
  const companyRows = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(like(schema.companies.name, `${RUN_ID}%`));
  const companyIds = companyRows.map((row) => row.id);
  if (companyIds.length === 0) return;
  const voucherIds = (
    await db
      .select({ id: schema.vouchers.id })
      .from(schema.vouchers)
      .where(inArray(schema.vouchers.companyId, companyIds))
  ).map((row) => row.id);
  if (voucherIds.length > 0) {
    const transferIds = (
      await db
        .select({ id: schema.stockTransferVouchers.id })
        .from(schema.stockTransferVouchers)
        .where(inArray(schema.stockTransferVouchers.voucherId, voucherIds))
    ).map((row) => row.id);
    if (transferIds.length > 0) {
      await db.delete(schema.stockTransferItems).where(inArray(schema.stockTransferItems.transferId, transferIds));
      await db.delete(schema.stockTransferVouchers).where(inArray(schema.stockTransferVouchers.id, transferIds));
    }
    await db.delete(schema.salesItems).where(inArray(schema.salesItems.voucherId, voucherIds));
    await db.delete(schema.vouchers).where(inArray(schema.vouchers.id, voucherIds));
  }
  await db.delete(schema.inventory).where(inArray(schema.inventory.companyId, companyIds));
  await db.delete(schema.stockItems).where(inArray(schema.stockItems.companyId, companyIds));
  await db.delete(schema.stockGroups).where(inArray(schema.stockGroups.companyId, companyIds));
  await db.delete(schema.locations).where(inArray(schema.locations.companyId, companyIds));
  await db.delete(schema.companies).where(inArray(schema.companies.id, companyIds));
}

let voucherSeq = 0;
async function createVoucher(input: {
  voucherType: "Stock Transfer" | "Sales";
  voucherDate: string;
  locationId: number;
  optional?: boolean;
  label?: string;
}) {
  voucherSeq += 1;
  const [voucher] = await db
    .insert(schema.vouchers)
    .values({
      companyId,
      locationId: input.locationId,
      voucherNumber: input.label ?? `${RUN_ID}-V${voucherSeq}`,
      voucherType: input.voucherType,
      voucherDate: input.voucherDate,
      description: RUN_ID,
      totalAmount: "0",
      optional: input.optional ?? false,
    })
    .returning();
  return voucher;
}

async function createTransfer(input: {
  label: string;
  voucherDate: string;
  destinationLocationId: number;
  voucherSourceLocationId: number;
  items: Array<{ sourceLocationId: number | null; stockItemId: number; quantity: number }>;
}) {
  const voucher = await createVoucher({
    voucherType: "Stock Transfer",
    voucherDate: input.voucherDate,
    locationId: input.voucherSourceLocationId,
    label: input.label,
  });
  const [transfer] = await db
    .insert(schema.stockTransferVouchers)
    .values({
      voucherId: voucher.id,
      sourceLocationId: input.voucherSourceLocationId,
      destinationLocationId: input.destinationLocationId,
      notes: RUN_ID,
      inventoryApplied: true,
    })
    .returning();
  await db.insert(schema.stockTransferItems).values(
    input.items.map((line) => ({
      transferId: transfer.id,
      stockItemId: line.stockItemId,
      sourceLocationId: line.sourceLocationId,
      quantity: String(line.quantity),
      rate: "1",
      totalAmount: String(line.quantity),
    }))
  );
}

async function createSale(
  stockItemId: number,
  quantity: number,
  voucherDate: string,
  options: { locationId?: number; optional?: boolean } = {}
) {
  const voucher = await createVoucher({
    voucherType: "Sales",
    voucherDate,
    locationId: options.locationId ?? destinationId,
    optional: options.optional,
  });
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

async function setDestinationStock(stockItemId: number, quantity: number, locationId = destinationId) {
  await db.insert(schema.inventory).values({
    companyId,
    locationId,
    stockItemId,
    quantity: String(quantity),
    averageRate: "1",
    totalValue: String(quantity),
  });
}

beforeAll(async () => {
  await cleanup();
  const [company] = await db
    .insert(schema.companies)
    .values({ code: RUN_ID.toUpperCase(), name: `${RUN_ID}-company`, baseCurrency: "USD" })
    .returning();
  companyId = company.id;
  const [otherCompany] = await db
    .insert(schema.companies)
    .values({ code: `${RUN_ID}-X`.toUpperCase(), name: `${RUN_ID}-other`, baseCurrency: "USD" })
    .returning();
  const [foreignLocation] = await db
    .insert(schema.locations)
    .values({ companyId: otherCompany.id, code: `${RUN_ID}-FX`, name: "Foreign" })
    .returning();
  otherCompanyLocationId = foreignLocation.id;

  const names = ["Src 1", "Src 2", "Src 3", "Dest", "Dest Four", "Dest Empty", "Dest Other"];
  const created = await db
    .insert(schema.locations)
    .values(names.map((name, index) => ({ companyId, code: `${RUN_ID}-${index}`, name })))
    .returning();
  sourceIds = [created[0].id, created[1].id];
  unselectedSourceId = created[2].id;
  destinationId = created[3].id;
  fourOrderDestinationId = created[4].id;
  emptyDestinationId = created[5].id;
  otherDestinationId = created[6].id;

  const [group] = await db
    .insert(schema.stockGroups)
    .values({ companyId, code: `${RUN_ID}-G`, name: `${RUN_ID}-group` })
    .returning();
  const itemKeys = [
    "strong",
    "quick",
    "good",
    "normal",
    "slow",
    "overSold",
    "overIdle",
    "none",
    "legacy",
    "suppGood",
    "suppNormal",
    "suppSlow",
    "suppTiny",
    "suppOld",
    "suppOverstock",
    "suppInactive",
    "suppElsewhere",
    "suppAncient",
    "suppOptional",
  ];
  const createdItems = await db
    .insert(schema.stockItems)
    .values(
      itemKeys.map((key) => ({
        companyId,
        code: `${RUN_ID}-${key}`,
        name: `Item ${key}`,
        uom: "BALE",
        stockGroupId: group.id,
        active: key !== "suppInactive",
      }))
    )
    .returning();
  createdItems.forEach((row, index) => {
    item[itemKeys[index]] = row.id;
  });

  // One qualifying transfer: newer and older resolve to the same order.
  await createTransfer({
    label: `${RUN_ID}-ONLY`,
    voucherDate: "2026-08-01",
    destinationLocationId: destinationId,
    voucherSourceLocationId: sourceIds[1],
    items: [
      { sourceLocationId: sourceIds[0], stockItemId: item.strong, quantity: 100 },
      { sourceLocationId: sourceIds[0], stockItemId: item.quick, quantity: 10 },
      { sourceLocationId: sourceIds[0], stockItemId: item.good, quantity: 100 },
      { sourceLocationId: sourceIds[0], stockItemId: item.normal, quantity: 100 },
      { sourceLocationId: sourceIds[0], stockItemId: item.slow, quantity: 100 },
      { sourceLocationId: sourceIds[0], stockItemId: item.overSold, quantity: 100 },
      { sourceLocationId: sourceIds[0], stockItemId: item.overIdle, quantity: 100 },
      { sourceLocationId: unselectedSourceId, stockItemId: item.none, quantity: 100 },
      { sourceLocationId: null, stockItemId: item.legacy, quantity: 100 },
    ],
  });

  await createSale(item.strong, 90, "2026-08-10");
  await createSale(item.quick, 4, "2026-08-03");
  await createSale(item.quick, 6, "2026-08-05");
  await createSale(item.good, 70, "2026-08-10");
  await createSale(item.normal, 40, "2026-08-10");
  await createSale(item.slow, 10, "2026-08-10");
  await createSale(item.overSold, 10, "2026-08-10");
  await createSale(item.legacy, 50, "2026-08-10");
  await setDestinationStock(item.strong, 10);
  await setDestinationStock(item.slow, 5);
  await setDestinationStock(item.overSold, 90);
  await setDestinationStock(item.overIdle, 20);

  // Supplemental candidates: sold at the destination but never transferred.
  await createSale(item.suppGood, 100, "2026-08-10");
  await createSale(item.suppNormal, 15, "2026-08-10");
  await createSale(item.suppSlow, 3, "2026-08-10");
  await createSale(item.suppTiny, 1, "2026-08-10");
  await createSale(item.suppOld, 30, "2026-07-01");
  await createSale(item.suppOverstock, 15, "2026-08-10");
  await setDestinationStock(item.suppOverstock, 1000);
  await setDestinationStock(item.suppGood, 0);
  await createSale(item.suppInactive, 100, "2026-08-10");
  await createSale(item.suppElsewhere, 100, "2026-08-10", { locationId: otherDestinationId });
  await createSale(item.suppAncient, 100, "2026-05-01");
  await createSale(item.suppOptional, 100, "2026-08-10", { optional: true });
  await createSale(item.suppGood, 100, "2026-09-05"); // after asOf: ignored

  // Five transfers to a second destination: only the newest four are analyzed.
  const dates = ["2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01"];
  for (const [index, date] of dates.entries()) {
    await createTransfer({
      label: `${RUN_ID}-FOUR-${index + 1}`,
      voucherDate: date,
      destinationLocationId: fourOrderDestinationId,
      voucherSourceLocationId: sourceIds[0],
      items: [{ sourceLocationId: sourceIds[index % 2], stockItemId: item.strong, quantity: (index + 1) * 10 }],
    });
  }
  await createSale(item.strong, 25, "2026-04-15", { locationId: fourOrderDestinationId });
  await createSale(item.strong, 5, "2026-07-10", { locationId: fourOrderDestinationId });
  // Before the oldest of the newest four orders: outside every analysis window.
  await createSale(item.strong, 7, "2026-03-15", { locationId: fourOrderDestinationId });
});

afterAll(async () => {
  await cleanup();
});

describe("analyzeLastTwoMultiSourceTransfers input validation", () => {
  it("rejects invalid company and destination ids before touching the database", async () => {
    await expect(analyzeLastTwoMultiSourceTransfers(0, [1], 2)).rejects.toThrow("A valid company is required");
    await expect(analyzeLastTwoMultiSourceTransfers(1.5, [1], 2)).rejects.toThrow("A valid company is required");
    await expect(analyzeLastTwoMultiSourceTransfers(1, [1], 0)).rejects.toThrow(
      "A valid destination location is required"
    );
    await expect(analyzeLastTwoMultiSourceTransfers(1, [1], 2.5)).rejects.toThrow(
      "A valid destination location is required"
    );
  });

  it("requires at least one positive integer source that differs from the destination", async () => {
    await expect(analyzeLastTwoMultiSourceTransfers(1, [], 2)).rejects.toThrow(
      "At least one source location different from the destination is required"
    );
    await expect(analyzeLastTwoMultiSourceTransfers(1, [2, 2, 0, -3, 1.5], 2)).rejects.toThrow(
      "At least one source location different from the destination is required"
    );
  });

  it("rejects malformed and impossible asOfDate values", async () => {
    await expect(analyzeLastTwoMultiSourceTransfers(1, [1], 2, { asOfDate: "20260801" })).rejects.toThrow(
      "asOfDate must be a valid date in YYYY-MM-DD format"
    );
    await expect(analyzeLastTwoMultiSourceTransfers(1, [1], 2, { asOfDate: "2026-13-45" })).rejects.toThrow(
      "asOfDate must be a valid date in YYYY-MM-DD format"
    );
    // Parses as a real Date but is not plain YYYY-MM-DD.
    await expect(analyzeLastTwoMultiSourceTransfers(1, [1], 2, { asOfDate: "+002026-08-01" })).rejects.toThrow(
      "asOfDate must be a valid date in YYYY-MM-DD format"
    );
  });

  it("rejects a destination owned by another company", async () => {
    await expect(
      analyzeLastTwoMultiSourceTransfers(companyId, sourceIds, otherCompanyLocationId, { asOfDate: AS_OF })
    ).rejects.toThrow("Destination location was not found in the current company");
  });

  it("names every source location that is missing from the company", async () => {
    await expect(
      analyzeLastTwoMultiSourceTransfers(companyId, [sourceIds[0], otherCompanyLocationId], destinationId, {
        asOfDate: AS_OF,
      })
    ).rejects.toThrow(`Source location(s) not found in the current company: ${otherCompanyLocationId}`);
  });
});

describe("analyzeLastTwoMultiSourceTransfers results", () => {
  it("returns an empty, named result when the destination has no completed transfers", async () => {
    const result = await analyzeLastTwoMultiSourceTransfers(
      companyId,
      [sourceIds[1], sourceIds[0], sourceIds[1], emptyDestinationId],
      emptyDestinationId,
      { asOfDate: AS_OF }
    );
    expect(result).toEqual({
      companyId,
      destinationLocationId: emptyDestinationId,
      destinationLocationName: "Dest Empty",
      selectedSourceLocationIds: [sourceIds[1], sourceIds[0]],
      selectedSourceLocationNames: ["Src 2", "Src 1"],
      asOfDate: AS_OF,
      newerTransfer: null,
      olderTransfer: null,
      items: [],
      summary: "No completed stock transfer orders were found to Dest Empty.",
    });
  });

  it("defaults asOfDate to today when it is omitted", async () => {
    const result = await analyzeLastTwoMultiSourceTransfers(companyId, sourceIds, emptyDestinationId);
    expect(result.asOfDate).toBe(new Date().toISOString().slice(0, 10));
  });

  it("treats a single qualifying transfer as both the newer and older order", async () => {
    const result = await analyzeLastTwoMultiSourceTransfers(companyId, sourceIds, destinationId, { asOfDate: AS_OF });
    expect(result.newerTransfer?.voucherNumber).toBe(`${RUN_ID}-ONLY`);
    expect(result.olderTransfer).toBe(result.newerTransfer);
    expect(result.newerTransfer?.totalQuantity).toBe(810);
    expect(new Set(result.newerTransfer?.sourceLocationIds)).toEqual(
      new Set([sourceIds[0], sourceIds[1], unselectedSourceId])
    );
    expect(result.newerTransfer?.sourceLocationNames).toContain(`Location #${unselectedSourceId}`);
    expect(result.newerTransfer?.destinationLocationName).toBe("Dest");
    expect(result.summary).toBe(
      `Analyzed 1 of up to 4 completed transfer order(s) to Dest. ${result.items.length} item(s) considered (including sales-based candidates) through ${AS_OF}.`
    );

    const strong = result.items.find((row) => row.stockItemId === item.strong)!;
    expect(strong).toMatchObject({
      olderTransferQty: 0,
      newerTransferQty: 100,
      totalTransferredQty: 100,
      salesAfterOlderTransfer: 0,
      salesAfterNewerTransfer: 90,
      totalSalesSinceOlderTransfer: 90,
      olderSellThroughPercentage: 0,
      newerSellThroughPercentage: 90,
      overallSellThroughPercentage: 90,
      latestSalesPerDay: 2.903,
      averageSalesPerDay: 2.903,
      currentDestinationQty: 10,
      estimatedDaysOfStockRemaining: 3.4,
      daysToSellOlderTransfer: null,
      daysToSellNewerTransfer: null,
      classification: "strong_seller",
      classificationLabel: "Strong seller",
      explanation:
        "90 sold after 100 transferred in the last qualifying orders; demand is strong and current destination stock is 10.",
    });
  });

  it("counts the days it took to sell through the newer transfer", async () => {
    const result = await analyzeLastTwoMultiSourceTransfers(companyId, sourceIds, destinationId, { asOfDate: AS_OF });
    const quick = result.items.find((row) => row.stockItemId === item.quick)!;
    expect(quick.daysToSellNewerTransfer).toBe(5);
    expect(quick.estimatedDaysOfStockRemaining).toBe(0);
    expect(quick.classification).toBe("strong_seller");
  });

  it("explains every classification in its own words", async () => {
    const result = await analyzeLastTwoMultiSourceTransfers(companyId, sourceIds, destinationId, { asOfDate: AS_OF });
    const byKey = (key: string) => result.items.find((row) => row.stockItemId === item[key])!;

    expect(byKey("good")).toMatchObject({
      classification: "good_seller",
      explanation:
        "70 sold after 100 transferred in the last qualifying orders; the item has good repeat demand at the destination.",
    });
    expect(byKey("normal")).toMatchObject({
      classification: "normal_seller",
      explanation:
        "40 sold after 100 transferred in the last qualifying orders; sales are steady and should be balanced against current destination stock.",
    });
    expect(byKey("slow")).toMatchObject({
      classification: "slow_seller",
      classificationLabel: "Slow seller",
      explanation: "10 sold after 100 transferred in the last qualifying orders; recent sales are slow (0.32/day).",
    });
    expect(byKey("overSold")).toMatchObject({
      classification: "overstocked",
      estimatedDaysOfStockRemaining: 279,
      explanation:
        "10 sold after 100 transferred in the last qualifying orders; destination still holds 90, about 279 days of stock.",
    });
    expect(byKey("overIdle")).toMatchObject({
      classification: "overstocked",
      estimatedDaysOfStockRemaining: null,
      latestSalesPerDay: 0,
      explanation: "0 sold after 100 transferred in the last qualifying orders; destination still holds 20.",
    });
    expect(byKey("none")).toMatchObject({
      classification: "no_recent_sales",
      classificationLabel: "No recent sales",
      estimatedDaysOfStockRemaining: null,
      historicalSourceLocationIds: [unselectedSourceId],
      historicalSourceLocationNames: [`Location #${unselectedSourceId}`],
      explanation: "No qualifying destination sales were found after the recent transfer order(s).",
    });
  });

  it("falls back to the voucher-level source when a line has none", async () => {
    const result = await analyzeLastTwoMultiSourceTransfers(companyId, sourceIds, destinationId, { asOfDate: AS_OF });
    const legacy = result.items.find((row) => row.stockItemId === item.legacy)!;
    expect(legacy.historicalSourceLocationIds).toEqual([sourceIds[1]]);
    expect(legacy.historicalSourceLocationNames).toEqual(["Src 2"]);
    expect(legacy.classification).toBe("normal_seller");
  });

  it("adds sales-based candidates by daily-rate tier and skips negligible, overstocked, inactive and out-of-scope sales", async () => {
    const result = await analyzeLastTwoMultiSourceTransfers(companyId, sourceIds, destinationId, { asOfDate: AS_OF });
    const ids = new Set(result.items.map((row) => row.stockItemId));
    for (const skipped of [
      "suppTiny",
      "suppOverstock",
      "suppInactive",
      "suppElsewhere",
      "suppAncient",
      "suppOptional",
    ]) {
      expect(ids.has(item[skipped]), skipped).toBe(false);
    }

    const suppGood = result.items.find((row) => row.stockItemId === item.suppGood)!;
    expect(suppGood).toEqual({
      stockItemId: item.suppGood,
      stockItemName: "Item suppGood",
      stockItemCode: `${RUN_ID}-suppGood`,
      historicalSourceLocationIds: [],
      historicalSourceLocationNames: [],
      olderTransferQty: 0,
      newerTransferQty: 0,
      totalTransferredQty: 0,
      salesAfterOlderTransfer: 0,
      salesAfterNewerTransfer: 100,
      totalSalesSinceOlderTransfer: 100,
      olderSellThroughPercentage: 0,
      newerSellThroughPercentage: 0,
      overallSellThroughPercentage: 0,
      averageSalesPerDay: 1.111,
      latestSalesPerDay: 3.226,
      currentDestinationQty: 0,
      estimatedDaysOfStockRemaining: 0,
      daysToSellOlderTransfer: null,
      daysToSellNewerTransfer: null,
      classification: "good_seller",
      classificationLabel: "Good seller",
      explanation:
        "Sales-based candidate: 100 units sold at destination in last 90 days (3.23/day recently). Not in recent transfers.",
    });
    expect(result.items.find((row) => row.stockItemId === item.suppNormal)!.classification).toBe("normal_seller");
    expect(result.items.find((row) => row.stockItemId === item.suppSlow)).toMatchObject({
      classification: "slow_seller",
      estimatedDaysOfStockRemaining: 0,
    });

    // Sold only before the latest transfer: the 90-day average drives the tier.
    expect(result.items.find((row) => row.stockItemId === item.suppOld)).toMatchObject({
      classification: "normal_seller",
      latestSalesPerDay: 0,
      averageSalesPerDay: 0.333,
      salesAfterOlderTransfer: 30,
      salesAfterNewerTransfer: 0,
      totalSalesSinceOlderTransfer: 30,
    });
  });

  it("orders items by classification priority, then recent daily sales", async () => {
    const result = await analyzeLastTwoMultiSourceTransfers(companyId, sourceIds, destinationId, { asOfDate: AS_OF });
    const priority = ["strong_seller", "good_seller", "normal_seller", "slow_seller", "overstocked", "no_recent_sales"];
    const ranks = result.items.map((row) => priority.indexOf(row.classification));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(result.items[0].stockItemId).toBe(item.strong);
    expect(result.items[1].stockItemId).toBe(item.quick);
    const goods = result.items.filter((row) => row.classification === "good_seller").map((row) => row.stockItemId);
    expect(goods).toEqual([item.suppGood, item.good]);
    const overstocked = result.items
      .filter((row) => row.classification === "overstocked")
      .map((row) => row.stockItemId);
    expect(overstocked).toEqual([item.overSold, item.overIdle]);
    expect(result.items[result.items.length - 1].stockItemId).toBe(item.none);
  });

  it("analyzes only the newest four orders and sums the three prior ones as older quantity", async () => {
    const result = await analyzeLastTwoMultiSourceTransfers(companyId, sourceIds, fourOrderDestinationId, {
      asOfDate: AS_OF,
    });
    expect(result.newerTransfer?.voucherNumber).toBe(`${RUN_ID}-FOUR-5`);
    expect(result.olderTransfer?.voucherNumber).toBe(`${RUN_ID}-FOUR-2`);
    expect(result.summary).toMatch(/^Analyzed 4 of up to 4 completed transfer order\(s\) to Dest Four\./);
    const strong = result.items.find((row) => row.stockItemId === item.strong)!;
    // Prior orders 2..4 carry 20 + 30 + 40; the newest carries 50.
    expect(strong.olderTransferQty).toBe(90);
    expect(strong.newerTransferQty).toBe(50);
    expect(strong.salesAfterOlderTransfer).toBe(25);
    expect(strong.salesAfterNewerTransfer).toBe(5);
    expect(strong.daysToSellOlderTransfer).toBeNull();
    expect(strong.historicalSourceLocationIds.slice().sort()).toEqual(sourceIds.slice().sort());
  });

  it("ignores transfers dated after asOfDate", async () => {
    const result = await analyzeLastTwoMultiSourceTransfers(companyId, sourceIds, fourOrderDestinationId, {
      asOfDate: "2026-04-15",
    });
    expect(result.newerTransfer?.voucherNumber).toBe(`${RUN_ID}-FOUR-2`);
    expect(result.olderTransfer?.voucherNumber).toBe(`${RUN_ID}-FOUR-1`);
    const strong = result.items.find((row) => row.stockItemId === item.strong)!;
    expect(strong.olderTransferQty).toBe(10);
    expect(strong.newerTransferQty).toBe(20);
    // The 03-15 sale falls between the two orders; only one sale since the newer one.
    expect(strong.salesAfterOlderTransfer).toBe(7);
    expect(strong.salesAfterNewerTransfer).toBe(25);
    expect(strong.daysToSellNewerTransfer).toBe(15);
  });
});
