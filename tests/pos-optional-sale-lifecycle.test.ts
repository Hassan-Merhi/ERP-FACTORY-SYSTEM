import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../server/db";
import { and, eq } from "drizzle-orm";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, getInventoryQty, seedTestData, type TestContext } from "./setup";
import { posOptionalLinkedSettlementBlocked } from "../server/services/pos/posOptionalSafety";

describe("ERP POS optional status safety policy", () => {
  it("allows ordinary ERP itemized sales and excludes unrelated voucher types", () => {
    expect(posOptionalLinkedSettlementBlocked("Sales", true, "standard", false)).toBe(false);
    expect(posOptionalLinkedSettlementBlocked("Journal", true, "supplier_partner", true)).toBe(false);
    expect(posOptionalLinkedSettlementBlocked("Sales", false, "supplier_partner", true)).toBe(false);
  });
  it("blocks supplier partner settlements and all configured intercompany mirror setups", () => {
    expect(posOptionalLinkedSettlementBlocked("Sales", true, "supplier_partner", false)).toBe(true);
    expect(posOptionalLinkedSettlementBlocked("Sales", true, "standard", true)).toBe(true);
  });
});

describe("ERP POS optional stock and accounting lifecycle", () => {
  const prefix = "posoptsafe";
  let ctx: TestContext;
  let agent: request.SuperAgentTest;

  beforeAll(async () => {
    ctx = await seedTestData(prefix);
    agent = request.agent(ctx.app);
    const login = await agent.post("/api/auth/login")
      .send({ username: `${prefix}_testuser`, password: "testpassword123" });
    expect(login.status).toBe(200);
    expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await cleanupTestData(prefix);
    closeTestServer();
  }, 120_000);

  async function createSale(quantity: number) {
    const response = await agent.post("/api/pos/sales").send({
      locationId: ctx.locationId,
      items: [{ stockItemId: ctx.stockItemIds[0], quantity, rate: 20 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: new Date().toISOString().slice(0, 10),
      clientSaleId: `pos-optional-${Date.now()}-${Math.random()}`,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return Number(response.body.voucher.id);
  }

  it("returns exactly the issued quantity and original value once, then deducts only once on reactivation", async () => {
    const stockItemId = ctx.stockItemIds[0];
    const beforeQty = await getInventoryQty(ctx.locationId, stockItemId);
    const [beforeStock] = await db.select().from(schema.inventory)
      .where(eq(schema.inventory.stockItemId, stockItemId));
    const voucherId = await createSale(3);
    expect(await getInventoryQty(ctx.locationId, stockItemId)).toBe(beforeQty - 3);

    const [afterSaleStock] = await db.select().from(schema.inventory)
      .where(eq(schema.inventory.stockItemId, stockItemId));
    const makeOptional = await agent.patch(`/api/vouchers/${voucherId}/optional`).send({ optional: true });
    expect(makeOptional.status, JSON.stringify(makeOptional.body)).toBe(200);
    const [voucherAfter] = await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, voucherId));
    expect(voucherAfter.optional).toBe(true);
    expect(await getInventoryQty(ctx.locationId, stockItemId)).toBe(beforeQty);
    const [restoredStock] = await db.select().from(schema.inventory)
      .where(eq(schema.inventory.stockItemId, stockItemId));
    expect(Number(restoredStock.totalValue)).toBeCloseTo(Number(beforeStock.totalValue), 2);

    const repeatOptional = await agent.patch(`/api/vouchers/${voucherId}/optional`).send({ optional: true });
    expect(repeatOptional.status).toBe(200);
    expect(await getInventoryQty(ctx.locationId, stockItemId)).toBe(beforeQty);

    // Legacy finalize must not silently turn stock-bearing sales back on.
    const oldFinalize = await agent.post(`/api/vouchers/${voucherId}/finalize`).send({});
    expect(oldFinalize.status).toBe(409);
    expect(oldFinalize.body.code).toBe("POS_SALE_ACTIVATION_REQUIRES_STOCK_TOGGLE");
    expect(await getInventoryQty(ctx.locationId, stockItemId)).toBe(beforeQty);

    const restore = await agent.patch(`/api/vouchers/${voucherId}/optional`).send({ optional: false });
    expect(restore.status, JSON.stringify(restore.body)).toBe(200);
    expect(await getInventoryQty(ctx.locationId, stockItemId)).toBe(beforeQty - 3);
    const [reissuedStock] = await db.select().from(schema.inventory)
      .where(eq(schema.inventory.stockItemId, stockItemId));
    expect(Number(reissuedStock.totalValue)).toBeCloseTo(Number(afterSaleStock.totalValue), 2);

    const repeatRestore = await agent.patch(`/api/vouchers/${voucherId}/optional`).send({ optional: false });
    expect(repeatRestore.status).toBe(200);
    expect(await getInventoryQty(ctx.locationId, stockItemId)).toBe(beforeQty - 3);
  }, 120_000);

  it("refuses reactivation if the returned stock was subsequently used, without changing the optional status", async () => {
    const stockItemId = ctx.stockItemIds[1];
    const voucherId = await (async () => {
      const response = await agent.post("/api/pos/sales").send({
        locationId: ctx.locationId,
        items: [{ stockItemId, quantity: 1, rate: 20 }],
        paymentAccountType: "ledger",
        paymentAccountId: ctx.cashAccountId,
        voucherDate: new Date().toISOString().slice(0, 10),
        clientSaleId: `pos-optional-shortage-${Date.now()}`,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return Number(response.body.voucher.id);
    })();
    const suspend = await agent.patch(`/api/vouchers/${voucherId}/optional`).send({ optional: true });
    expect(suspend.status, JSON.stringify(suspend.body)).toBe(200);

    await db.update(schema.inventory).set({ quantity: "0.000", totalValue: "0.00" })
      .where(and(eq(schema.inventory.companyId, ctx.companyId),
        eq(schema.inventory.locationId, ctx.locationId), eq(schema.inventory.stockItemId, stockItemId)));

    const attempt = await agent.patch(`/api/vouchers/${voucherId}/optional`).send({ optional: false });
    expect(attempt.status).toBe(409);
    expect(String(attempt.body.message)).toMatch(/insufficient stock/i);
    const [voucher] = await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, voucherId));
    expect(voucher.optional).toBe(true);
    expect(await getInventoryQty(ctx.locationId, stockItemId)).toBe(0);
  }, 120_000);
});
