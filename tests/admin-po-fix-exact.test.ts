/**
 * The admin test-voucher route posts the cents an amount rounds to, half up:
 * 1.005 becomes 1.01 in the voucher and both entries. The float toFixed(2)
 * wrote 1.00.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "pofixx";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`, [
    ctx.companyId,
  ]);
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/test-data/vouchers", () => {
  it("posts a half-cent amount at the cents it rounds to", async () => {
    const res = await agent.post("/api/test-data/vouchers").send({
      date: "2026-01-15",
      debitAccountId: ctx.cashAccountId,
      creditAccountId: ctx.salesAccountId,
      amount: "1.005",
    });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);

    const rows = await pool.query<{ total_amount: string; debit_amount: string; credit_amount: string }>(
      `SELECT v.total_amount, ve.debit_amount, ve.credit_amount
         FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id
        WHERE v.company_id = $1 AND v.voucher_number LIKE 'TEST-%'`,
      [ctx.companyId]
    );
    expect(rows.rows.map((r) => [r.total_amount, r.debit_amount, r.credit_amount]).sort()).toEqual([
      ["1.01", "0.00", "1.01"],
      ["1.01", "1.01", "0.00"],
    ]);
  });

  it("refuses an amount that is not a positive number", async () => {
    for (const amount of ["abc", "-1"]) {
      const res = await agent.post("/api/test-data/vouchers").send({
        date: "2026-01-15",
        debitAccountId: ctx.cashAccountId,
        creditAccountId: ctx.salesAccountId,
        amount,
      });
      expect(res.status).toBe(400);
    }
  });
});
