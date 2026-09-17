import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "phase33bvr";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let sequence = 0;

async function makeVoucher(
  voucherType: string,
  options: { companyId?: number; locationId?: number | null; totalAmount?: string } = {},
) {
  sequence += 1;
  const [voucher] = await db
    .insert(schema.vouchers)
    .values({
      companyId: options.companyId ?? ctx.companyId,
      locationId: options.locationId ?? null,
      voucherNumber: `P33B-READ-${sequence}`,
      voucherType,
      voucherDate: "2026-09-17",
      description: `${TEST_PREFIX} ${voucherType} ${sequence}`,
      totalAmount: options.totalAmount ?? "100.00",
      currency: "USD",
      optional: false,
    })
    .returning();
  return voucher;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);

  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(selected.status).toBe(200);
}, 120_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  await closeTestServer();
}, 120_000);

describe("Phase 33B voucher entry finance reads", () => {
  it("validates voucher ids and returns ledger entries with editor account metadata", async () => {
    const invalid = await agent.get("/api/vouchers/not-a-number/entries");
    expect(invalid.status).toBe(400);

    const missing = await agent.get("/api/vouchers/2147482500/entries");
    expect(missing.status).toBe(404);

    const voucher = await makeVoucher("Journal");
    await db.insert(schema.voucherEntries).values([
      {
        voucherId: voucher.id,
        ledgerAccountId: ctx.salesAccountId,
        debitAmount: "100.00",
        creditAmount: "0",
        narration: "Phase 33B debit",
      },
      {
        voucherId: voucher.id,
        ledgerAccountId: ctx.cashAccountId,
        debitAmount: "0",
        creditAmount: "100.00",
        narration: "Phase 33B credit",
      },
    ]);

    const response = await agent.get(`/api/vouchers/${voucher.id}/entries`);
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ledgerAccountId: ctx.salesAccountId,
          accountType: "ledger",
          accountId: ctx.salesAccountId,
        }),
        expect.objectContaining({
          ledgerAccountId: ctx.cashAccountId,
          accountType: "ledger",
          accountId: ctx.cashAccountId,
        }),
      ]),
    );
  });

  it("does not expose voucher entries from another company", async () => {
    const [foreignCompany] = await db
      .insert(schema.companies)
      .values({
        code: `P33BFR${sequence}`,
        name: `${TEST_PREFIX}_Foreign_${sequence}`,
        companyType: "erp",
        active: true,
        baseCurrency: "USD",
      })
      .returning();
    const foreignVoucher = await makeVoucher("Journal", { companyId: foreignCompany.id });

    const response = await agent.get(`/api/vouchers/${foreignVoucher.id}/entries`);
    expect([403, 404]).toContain(response.status);
    expect(response.body).not.toEqual(expect.arrayContaining([expect.objectContaining({ voucherId: foreignVoucher.id })]));
  });

  it("returns Sales item detail for finance users and hides cost/profit when ERP field policy requires it", async () => {
    const voucher = await makeVoucher("Sales", {
      locationId: ctx.locationId,
      totalAmount: "10.00",
    });

    await db.insert(schema.salesItems).values({
      voucherId: voucher.id,
      stockItemId: ctx.stockItemIds[0],
      quantity: "2.000",
      sellingPrice: "5.000000",
      costPrice: "3.000000",
      totalSales: "10.00",
      totalCost: "6.00",
      profit: "4.00",
    });

    const visible = await agent.get(`/api/vouchers/${voucher.id}/view-entries`);
    expect(visible.status).toBe(200);
    expect(Array.isArray(visible.body)).toBe(true);
    const visibleItem = visible.body.find((row: Record<string, unknown>) => row.isStockItem === true);
    expect(visibleItem).toBeTruthy();
    expect(Number(visibleItem.costPrice)).toBe(3);
    expect(Number(visibleItem.profit)).toBe(4);
    expect(Number(visibleItem.sellingPrice)).toBe(5);

    await db
      .update(schema.users)
      .set({ hiddenErpCostFields: ["sales_profit_cost"] })
      .where(eq(schema.users.id, ctx.userId));

    const hidden = await agent.get(`/api/vouchers/${voucher.id}/view-entries`);
    expect(hidden.status).toBe(200);
    const hiddenItem = hidden.body.find((row: Record<string, unknown>) => row.isStockItem === true);
    expect(hiddenItem).toMatchObject({
      costPrice: null,
      profit: null,
      configuredPrice: null,
      hassansPrice: null,
      hassansProfit: null,
      hassansPercentage: null,
    });
  });
});
