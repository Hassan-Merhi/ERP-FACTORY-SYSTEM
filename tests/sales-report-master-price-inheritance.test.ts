import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "salhassan";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let testVoucherId: number;
let companyCode: string;

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);

  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(selected.status).toBe(200);

  const [company] = await db
    .select({ code: schema.companies.code })
    .from(schema.companies)
    .where(eq(schema.companies.id, ctx.companyId));
  companyCode = company.code;

  // Inherit master price without physically copying it to the follower.
  await db.insert(schema.locationPriceGroups).values({
    companyId: ctx.companyId,
    masterLocationId: ctx.locationId,
    followerLocationId: ctx.location2Id,
  });
  await db.insert(schema.stockItemLocationPrices).values([
    { stockItemId: ctx.stockItemIds[0], locationId: ctx.locationId, sellingPrice: "320.00" },
    { stockItemId: ctx.stockItemIds[1], locationId: ctx.locationId, sellingPrice: "200.00" },
    // A stale direct follower price should not override its master's latest price.
    { stockItemId: ctx.stockItemIds[1], locationId: ctx.location2Id, sellingPrice: "250.00" },
  ]);
  await db.update(schema.stockItems).set({ sellingPrice: "150.00" })
    .where(eq(schema.stockItems.id, ctx.stockItemIds[2]));

  const [voucher] = await db.insert(schema.vouchers).values({
    companyId: ctx.companyId,
    locationId: ctx.location2Id,
    voucherNumber: `${PREFIX}-SALE-1`,
    voucherType: "Sales",
    voucherDate: "2026-10-15",
    description: "Hassan Price List master inheritance regression",
    totalAmount: "1601.59",
    currency: "USD",
    optional: false,
  }).returning();
  testVoucherId = voucher.id;

  await db.insert(schema.salesItems).values([
    {
      voucherId: testVoucherId,
      stockItemId: ctx.stockItemIds[0],
      quantity: "3.000",
      sellingPrice: "335.530000",
      costPrice: "183.740000",
      totalSales: "1006.59",
      totalCost: "551.22",
      profit: "455.37",
    },
    {
      voucherId: testVoucherId,
      stockItemId: ctx.stockItemIds[1],
      quantity: "2.000",
      sellingPrice: "215.000000",
      costPrice: "150.000000",
      totalSales: "430.00",
      totalCost: "300.00",
      profit: "130.00",
    },
    {
      voucherId: testVoucherId,
      stockItemId: ctx.stockItemIds[2],
      quantity: "1.000",
      sellingPrice: "165.000000",
      costPrice: "120.000000",
      totalSales: "165.00",
      totalCost: "120.00",
      profit: "45.00",
    },
  ]);
}, 120_000);

afterAll(async () => {
  await cleanupTestData(PREFIX);
  await closeTestServer();
}, 120_000);

function verifyHassanPrices(rows: Array<Record<string, unknown>>) {
  const byStockItem = (id: number) => {
    const item = rows.find((row) =>
      Number(row.voucherId) === testVoucherId && Number(row.stockItemId) === id
    );
    expect(item).toBeDefined();
    return item!;
  };

  const inherited = byStockItem(ctx.stockItemIds[0]);
  expect(Number(inherited.actualSellingPrice)).toBeCloseTo(335.53);
  expect(Number(inherited.configuredSellingPrice)).toBeCloseTo(320);
  expect(Number(inherited.totalConfiguredCost)).toBeCloseTo(960);
  expect(Number(inherited.configuredProfit)).toBeCloseTo(46.59);
  expect(Number(inherited.costProfit)).toBeCloseTo(455.37);

  const masterWins = byStockItem(ctx.stockItemIds[1]);
  expect(Number(masterWins.configuredSellingPrice)).toBeCloseTo(200);
  expect(Number(masterWins.configuredProfit)).toBeCloseTo(30);
  expect(Number(masterWins.totalConfiguredCost)).toBeCloseTo(400);

  const baseFallback = byStockItem(ctx.stockItemIds[2]);
  expect(Number(baseFallback.configuredSellingPrice)).toBeCloseTo(150);
  expect(Number(baseFallback.configuredProfit)).toBeCloseTo(15);
}

describe("Sales Report inherits the Price List master price", () => {
  it("returns corrected Hassan prices and profits for the single-company report", async () => {
    const response = await agent.get("/api/sales-report?startDate=2026-10-15&endDate=2026-10-15");
    expect(response.status).toBe(200);
    verifyHassanPrices(response.body);
  });

  it("resolves the same prices in the All Companies report", async () => {
    const response = await agent.get(
      `/api/dashboard/sales-report-all?startDate=2026-10-15&endDate=2026-10-15&companyFilter=${encodeURIComponent(companyCode)}`
    );
    expect(response.status).toBe(200);
    verifyHassanPrices(response.body);
  });

  it("uses the same inherited prices in single and all-company summary KPI totals", async () => {
    const urls = [
      "/api/sales-report/summary?startDate=2026-10-15&endDate=2026-10-15",
      `/api/dashboard/sales-report-all/summary?startDate=2026-10-15&endDate=2026-10-15&companyFilter=${encodeURIComponent(companyCode)}`,
    ];
    for (const url of urls) {
      const response = await agent.get(url);
      expect(response.status).toBe(200);
      expect(Number(response.body.totals.totalSales)).toBeCloseTo(1601.59);
      expect(Number(response.body.totals.totalConfiguredCost)).toBeCloseTo(1510);
      expect(Number(response.body.totals.configuredProfit)).toBeCloseTo(91.59);
      expect(Number(response.body.totals.costProfit)).toBeCloseTo(630.37);
    }
  });

  it("does not overwrite historical sales or create follower price rows while reading reports", async () => {
    const [sale] = await db.select().from(schema.salesItems).where(
      eq(schema.salesItems.voucherId, testVoucherId)
    ).limit(1);
    expect(sale).toBeDefined();

    const locationPrices = await db.select().from(schema.stockItemLocationPrices)
      .where(eq(schema.stockItemLocationPrices.stockItemId, ctx.stockItemIds[0]));
    expect(locationPrices).toHaveLength(1);
    expect(locationPrices[0].locationId).toBe(ctx.locationId);
    expect(locationPrices[0].sellingPrice).toBe("320.00");
  });
});
