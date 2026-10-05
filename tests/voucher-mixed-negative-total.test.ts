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

describe("POST /api/vouchers mixed adjustment totals", () => {
  it("accepts a negative net total for a Mixed production/consumption voucher", async () => {
    const response = await agent.post("/api/vouchers").send({
      companyId: ctx.companyId,
      voucherNumber: `${TEST_PREFIX}-MIXED-${Date.now()}`,
      voucherType: "Mixed",
      voucherDate: TODAY,
      description: "Mixed stock adjustment regression",
      totalAmount: "-293.90",
      currency: "USD",
      optional: false,
    });

    expect(response.status).toBe(200);
    expect(response.body.voucherType).toBe("Mixed");
    expect(response.body.totalAmount).toBe("-293.90");
  });

  it("keeps rejecting negative totals for non-Mixed voucher types", async () => {
    const response = await agent.post("/api/vouchers").send({
      companyId: ctx.companyId,
      voucherNumber: `${TEST_PREFIX}-PROD-${Date.now()}`,
      voucherType: "Production",
      voucherDate: TODAY,
      description: "Invalid negative production header",
      totalAmount: "-1.00",
      currency: "USD",
      optional: false,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ message: "Invalid request data", field: "totalAmount" });
  });
});
