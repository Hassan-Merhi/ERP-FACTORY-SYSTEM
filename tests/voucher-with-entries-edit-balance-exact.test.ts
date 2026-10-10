/**
 * PUT /api/vouchers/:id/with-entries checks the edited legs balance using
 * decimals. In floats 0.10 + 0.20 is 0.30000000000000004, which differs from
 * a 0.31 credit by 0.0099999…, under the 0.01 tolerance, so a voucher one
 * cent out of balance was saved. It is now refused.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "wefbal";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let voucherId: number;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const created = await agent.post("/api/vouchers/with-entries").send({
    voucher: { voucherNumber: `${TEST_PREFIX}-V1`, voucherType: "Journal", voucherDate: "2026-09-01" },
    entries: [
      { ledgerAccountId: ctx.cashAccountId, debitAmount: "0.30", creditAmount: "0" },
      { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "0.30" },
    ],
  });
  expect(created.status).toBe(200);
  voucherId = created.body.voucher?.id ?? created.body.id;
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("voucher with-entries edit balance", () => {
  it("refuses legs that are one cent out of balance", async () => {
    const response = await agent.put(`/api/vouchers/${voucherId}/with-entries`).send({
      voucher: { voucherType: "Journal", voucherDate: "2026-09-01" },
      entries: [
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "0.10", creditAmount: "0" },
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "0.20", creditAmount: "0" },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "0.31" },
      ],
    });
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/^Total debits must equal total credits for active vouchers/);
  });

  it("refuses a leg that is not a finite number", async () => {
    const response = await agent.put(`/api/vouchers/${voucherId}/with-entries`).send({
      voucher: { voucherType: "Journal", voucherDate: "2026-09-01" },
      entries: [
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "NaN", creditAmount: "0" },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "0" },
      ],
    });
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/must be a finite non-negative amount/);
  });
});
