import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "itemmkt";

let ctx: TestContext;
let agent: request.SuperAgentTest;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);

  const selectCompany = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(selectCompany.status).toBe(200);
}, 60_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30_000);

describe("Item Market Analysis calculations", () => {
  it("nets customer credit-note returns from sales and excludes supplier debit notes", async () => {
    const stockItemId = ctx.stockItemIds[0];

    const [saleVoucher] = await db
      .insert(schema.vouchers)
      .values({
        companyId: ctx.companyId,
        locationId: ctx.locationId,
        voucherNumber: `${TEST_PREFIX}-SALE-1`,
        voucherType: "Sales",
        voucherDate: "2030-01-10",
        totalAmount: "200.00",
        currency: "USD",
        optional: false,
      })
      .returning();

    await db.insert(schema.salesItems).values({
      voucherId: saleVoucher.id,
      stockItemId,
      quantity: "10.000",
      sellingPrice: "20.000000",
      costPrice: "10.00",
      totalSales: "200.00",
      totalCost: "100.00",
      profit: "100.00",
    });

    const creditNote = await agent.post("/api/credit-notes").send({
      noteType: "Credit Note",
      voucherDate: "2030-01-11",
      cashAccountType: "ledger",
      cashAccountId: ctx.cashAccountId,
      description: "Item Market customer return fixture",
      items: [
        {
          stockItemId,
          locationId: ctx.locationId,
          quantity: "2",
          refundRate: "20.00",
          inventoryCost: "10.00",
        },
      ],
    });
    expect(creditNote.status).toBeGreaterThanOrEqual(200);
    expect(creditNote.status).toBeLessThan(300);

    // Debit Notes are supplier returns. They are outbound stock movements, but
    // they are not customer sales and must not inflate market revenue/profit.
    const debitNote = await agent.post("/api/credit-notes").send({
      noteType: "Debit Note",
      voucherDate: "2030-01-12",
      cashAccountType: "ledger",
      cashAccountId: ctx.cashAccountId,
      description: "Item Market supplier return fixture",
      items: [
        {
          stockItemId,
          locationId: ctx.locationId,
          quantity: "1",
          refundRate: "30.00",
          inventoryCost: "10.00",
        },
      ],
    });
    expect(debitNote.status).toBeGreaterThanOrEqual(200);
    expect(debitNote.status).toBeLessThan(300);

    const report = await agent.get(
      `/api/reports/item-market-analysis?companyIds=${ctx.companyId}&startDate=2030-01-01&endDate=2030-12-31`
    );
    expect(report.status).toBe(200);

    const row = report.body.rows.find((entry: { stockItemId: number }) => entry.stockItemId === stockItemId);
    expect(row).toBeTruthy();

    // Sale: 10 @ $20, cost $10. Credit return removes 2. Debit Note is ignored.
    expect(row.soldQty).toBeCloseTo(8, 6);
    expect(row.revenue).toBeCloseTo(160, 2);
    expect(row.historicalCost).toBeCloseTo(80, 2);
    expect(row.profit).toBeCloseTo(80, 2);
    expect(row.avgSellingPrice).toBeCloseTo(20, 6);
    expect(row.profitPerUnit).toBeCloseTo(10, 6);
    expect(row.marginPct).toBeCloseTo(50, 2);

    expect(report.body.summary.soldQty).toBeCloseTo(8, 6);
    expect(report.body.summary.revenue).toBeCloseTo(160, 2);
    expect(report.body.summary.profit).toBeCloseTo(80, 2);

    const priceBreakdown = await agent.get(
      `/api/reports/item-market-analysis/sale-prices?companyId=${ctx.companyId}&stockItemId=${stockItemId}&startDate=2030-01-01&endDate=2030-12-31`
    );
    expect(priceBreakdown.status).toBe(200);

    const salePrice = priceBreakdown.body.rows.find(
      (entry: { activityType: string; unitPrice: number }) => entry.activityType === "sale" && entry.unitPrice === 20
    );
    const returnPrice = priceBreakdown.body.rows.find(
      (entry: { activityType: string; unitPrice: number }) => entry.activityType === "return" && entry.unitPrice === 20
    );

    expect(salePrice).toMatchObject({
      activityType: "sale",
      unitPrice: 20,
      quantity: 10,
      totalSales: 200,
      transactionCount: 1,
    });
    expect(returnPrice).toMatchObject({
      activityType: "return",
      unitPrice: 20,
      quantity: -2,
      totalSales: -40,
      transactionCount: 1,
    });
  }, 60_000);

  it("returns purchase cost both with and without offloading cost", async () => {
    const stockItemId = ctx.stockItemIds[0];
    const suffix = Date.now().toString();

    const supplier = await pool.query<{ id: number }>(
      `INSERT INTO suppliers (company_id, code, legal_name, email, active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id`,
      [
        ctx.companyId,
        `${TEST_PREFIX}-SUP-${suffix}`.slice(0, 50),
        `${TEST_PREFIX} offloading supplier`,
        `${TEST_PREFIX}-${suffix}@example.test`,
      ]
    );

    const container = await pool.query<{ id: number }>(
      `INSERT INTO containers
         (company_id, container_number, supplier_id, status, import_date, offload_date, items_total, charges_total, grand_total)
       VALUES ($1, $2, $3, 'OFFLOADED', '2031-02-01', '2031-02-02', '50.00', '20.00', '70.00')
       RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-CONT-${suffix}`, Number(supplier.rows[0].id)]
    );

    const po = await pool.query<{ id: number }>(
      `INSERT INTO purchase_orders
         (company_id, po_number, container_id, supplier_id, currency, items_total, status)
       VALUES ($1, $2, $3, $4, 'USD', '50.00', 'Open')
       RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-PO-${suffix}`, Number(container.rows[0].id), Number(supplier.rows[0].id)]
    );

    await pool.query(
      `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
       VALUES ($1, $2, 'Item Market landed cost fixture', '10.000', '5.00', '50.00')`,
      [Number(po.rows[0].id), stockItemId]
    );

    await pool.query(
      `INSERT INTO container_offloads
         (container_id, location_id, total_bales, additional_cost_per_bale, offloaded_at, optional)
       VALUES ($1, $2, '10.000', '2.00', '2031-02-02T12:00:00Z', false)`,
      [Number(container.rows[0].id), ctx.locationId]
    );

    const report = await agent.get(
      `/api/reports/item-market-analysis?companyIds=${ctx.companyId}&startDate=2031-02-01&endDate=2031-02-28`
    );
    expect(report.status).toBe(200);

    const row = report.body.rows.find((entry: { stockItemId: number }) => entry.stockItemId === stockItemId);
    expect(row).toBeTruthy();

    expect(row.purchaseValue).toBeCloseTo(50, 2);
    expect(row.weightedPurchaseCost).toBeCloseTo(5, 2);
    expect(row.purchaseValueWithOffloading).toBeCloseTo(70, 2);
    expect(row.weightedPurchaseCostWithOffloading).toBeCloseTo(7, 2);
  }, 60_000);
});
