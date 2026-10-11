import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "mixneg";
const TODAY = new Date().toISOString().slice(0, 10);

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

  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(selected.status).toBe(200);
}, 90000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("mixed adjustment totals", () => {
  // Wave 12: stock voucher types are created only by POST /api/stock-adjustments,
  // which derives the header from the persisted lines (production minus consumption).
  it("keeps a negative net total for a Mixed production/consumption voucher", async () => {
    const response = await agent.post("/api/stock-adjustments").send({
      voucher: { voucherNumber: `${TEST_PREFIX}-MIXED-${Date.now()}`, voucherDate: TODAY },
      locationId: ctx.locationId,
      adjustmentType: "Mixed",
      items: [
        { stockItemId: ctx.stockItemIds[0], quantity: "1", rate: "10" },
        // Consumed at the location's average rate (10).
        { stockItemId: ctx.stockItemIds[1], quantity: "-3", rate: "10" },
      ],
    });

    expect(response.status).toBe(201);
    expect(response.body.voucher.voucherType).toBe("Mixed");
    expect(response.body.voucher.totalAmount).toBe("-20.00");
  });

  it("refuses Mixed on the generic route and negative totals for other types", async () => {
    const mixed = await agent.post("/api/vouchers").send({
      voucherNumber: `${TEST_PREFIX}-GENERIC-${Date.now()}`,
      voucherType: "Mixed",
      voucherDate: TODAY,
      totalAmount: "-293.90",
    });
    expect(mixed.status).toBe(400);
    expect(mixed.body.code).toBe("STOCK_VOUCHER_TYPE_NOT_ALLOWED");

    const response = await agent.post("/api/vouchers").send({
      companyId: ctx.companyId,
      voucherNumber: `${TEST_PREFIX}-JRNL-${Date.now()}`,
      voucherType: "Journal",
      voucherDate: TODAY,
      description: "Invalid negative journal header",
      totalAmount: "-1.00",
      currency: "USD",
      optional: false,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ message: "Invalid request data", field: "totalAmount" });
  });
});
