/**
 * Payroll worker payments (2026-10 accounting audit, wave 7).
 *
 * pay-worker and bulk-pay-workers wrote the voucher and each line as separate
 * autocommit inserts, summed amounts as floats rounded per group (so a bulk
 * voucher could miss balance by a cent), and paid a worker of any company.
 */
import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w7paywk";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let ownWorkers: number[];
let otherCompanyWorker: number;
let otherCompanyId: number;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" }))
      .status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  const worker = async (companyId: number, code: string) =>
    (
      await pool.query<{ id: number }>(
        `INSERT INTO employees (company_id, code, first_name, last_name, join_date) VALUES ($1, $2::varchar, 'W', $2::text, '2026-01-01') RETURNING id`,
        [companyId, `${TEST_PREFIX}-${code}`]
      )
    ).rows[0].id;
  ownWorkers = [await worker(ctx.companyId, "A"), await worker(ctx.companyId, "B"), await worker(ctx.companyId, "C")];
  otherCompanyId = (
    await pool.query<{ id: number }>(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
      `${TEST_PREFIX}X`.toUpperCase(),
    ])
  ).rows[0].id;
  otherCompanyWorker = await worker(otherCompanyId, "X");
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [otherCompanyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [otherCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

async function voucherTotals(voucherId: number) {
  const result = await pool.query<{ dr: string; cr: string; lines: number }>(
    `SELECT SUM(debit_amount)::text AS dr, SUM(credit_amount)::text AS cr, COUNT(*)::int AS lines
       FROM voucher_entries WHERE voucher_id = $1`,
    [voucherId]
  );
  return result.rows[0];
}

describe("POST /api/payroll/bulk-pay-workers", () => {
  it("balances to the cent across payments that do not add up exactly in binary floats", async () => {
    const res = await agent
      .post("/api/payroll/bulk-pay-workers")
      .set("X-Idempotency-Key", randomUUID())
      .send({
        payments: [
          { employeeId: ownWorkers[0], amount: "0.10" },
          { employeeId: ownWorkers[1], amount: "0.20" },
          { employeeId: ownWorkers[2], amount: "333.335" },
        ],
        paymentAccountType: "cash",
        paymentAccountId: ctx.cashAccountId,
        date: "2026-10-01",
      });
    expect(res.status).toBe(200);
    const totals = await voucherTotals(res.body.voucher.id);
    expect(totals.dr).toBe(totals.cr);
    expect(totals.cr).toBe("333.64");
  });

  it("refuses to pay a worker of another company and posts nothing", async () => {
    const before = await pool.query(`SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1`, [ctx.companyId]);
    const res = await agent
      .post("/api/payroll/bulk-pay-workers")
      .set("X-Idempotency-Key", randomUUID())
      .send({
        payments: [
          { employeeId: ownWorkers[0], amount: "10.00" },
          { employeeId: otherCompanyWorker, amount: "10.00" },
        ],
        paymentAccountType: "cash",
        paymentAccountId: ctx.cashAccountId,
        date: "2026-10-01",
      });
    expect(res.status).toBe(404);
    const after = await pool.query(`SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1`, [ctx.companyId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("POST /api/payroll/pay-worker", () => {
  it("refuses a worker of another company", async () => {
    const res = await agent
      .post("/api/payroll/pay-worker")
      .set("X-Idempotency-Key", randomUUID())
      .send({ employeeId: otherCompanyWorker, amount: "10.00", bankAccountId: 1, date: "2026-10-01" });
    expect(res.status).toBe(404);
  });
});
