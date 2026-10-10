/**
 * Saving a rate only saves the rate (accounting audit wave 9,
 * docs/accounting-audit-2026-10.md): main's exact-cents FX revaluation posting
 * was superseded by removing the automatic FX-REVAL journal from
 * POST /api/exchange-rates altogether, so a rate change on Cash balances of
 * 100.00 and 33.33 posts nothing. Revaluation is report-time only.
 *
 * Bulk worker advances read each amount as a float: 1.005 is 1.00499… and
 * was stored as 1.00.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "mexact18";

let ctx: TestContext;
let agent: request.SuperAgentTest;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  await pool.query(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, 'MX18-C1', 'MX18 Cash One', 'Cash', '100.00', 'Dr'),
            ($1, 'MX18-C2', 'MX18 Cash Two', 'Cash', '33.33', 'Dr')`,
    [ctx.companyId]
  );
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM factory_worker_advances WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_workers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM exchange_rates WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("FX revaluation on a rate change", () => {
  it("posts no FX-REVAL journal when the rate changes", async () => {
    const first = await agent
      .post("/api/exchange-rates")
      .send({ fromCurrency: "USD", toCurrency: "XOF", rate: "600", effectiveDate: "2026-09-01" });
    expect(first.status).toBeLessThan(300);
    const second = await agent
      .post("/api/exchange-rates")
      .send({ fromCurrency: "USD", toCurrency: "XOF", rate: "650", effectiveDate: "2026-09-02" });
    expect(second.status).toBeLessThan(300);

    const voucher = await pool.query(
      `SELECT id FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'FX-REVAL-%'`,
      [ctx.companyId]
    );
    expect(voucher.rowCount).toBe(0);
  });
});

describe("bulk worker advances", () => {
  it("stores an advance of 1.005 as 1.01, not the float's 1.00", async () => {
    const worker = await pool.query<{ id: number }>(
      `INSERT INTO factory_workers (company_id, full_name) VALUES ($1, $2) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX} Worker`]
    );
    const response = await agent
      .post("/api/factory/advances/bulk")
      .send({ advanceDate: "2026-10-01", items: [{ workerId: worker.rows[0].id, amount: "1.005" }] });
    expect(response.status).toBe(200);

    const advance = await pool.query<{ amount: string; remaining_balance: string }>(
      `SELECT amount, remaining_balance FROM factory_worker_advances WHERE worker_id = $1`,
      [worker.rows[0].id]
    );
    expect(advance.rows).toEqual([{ amount: "1.01", remaining_balance: "1.01" }]);
  });
});
