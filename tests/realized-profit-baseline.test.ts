import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

import { db, pool } from "../server/db";
import { closeTestServer, cleanupTestData, seedTestData, type TestContext } from "./setup";
import { getSupplierPartnerPosProfit } from "../server/routes/stats/realizedProfit";
import { companies } from "../shared/schema";

const TEST_PREFIX = "spbaseline";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let voucherIds: number[] = [];

async function loginAsAdmin(): Promise<void> {
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  const company = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(company.status).toBe(200);
}

async function insertSale(date: string, profit: string, deleted = false): Promise<void> {
  const voucher = await pool.query<{ id: number }>(
    `INSERT INTO vouchers
      (company_id, location_id, voucher_number, voucher_type, voucher_date, total_amount, currency, optional, deleted_at)
     VALUES ($1, $2, $3, 'Sales', $4, $5, 'USD', false, $6)
     RETURNING id`,
    [
      ctx.companyId,
      ctx.locationId,
      `${TEST_PREFIX}-${voucherIds.length + 1}`,
      date,
      profit,
      deleted ? new Date() : null,
    ]
  );
  const voucherId = voucher.rows[0].id;
  voucherIds.push(voucherId);

  await pool.query(
    `INSERT INTO sales_items
      (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit)
     VALUES ($1, $2, 1, $3, 0, $3, 0, $3)`,
    [voucherId, ctx.stockItemIds[0], profit]
  );
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await loginAsAdmin();

  await pool.query("ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS sp_pos_profit_baseline_date date");
  await db.update(companies).set({ companyType: "supplier_partner" }).where(eq(companies.id, ctx.companyId));

  await pool.query(
    `INSERT INTO company_settings (company_id, sp_pos_profit_baseline_date)
     VALUES ($1, NULL)
     ON CONFLICT (company_id) DO UPDATE SET sp_pos_profit_baseline_date = NULL`,
    [ctx.companyId]
  );

  await insertSale("2026-08-31", "10");
  await insertSale("2026-09-01", "20");
  await insertSale("2026-09-02", "30");
  await insertSale("2026-09-03", "40", true);
}, 60000);

afterAll(async () => {
  await pool.query("DELETE FROM company_settings WHERE company_id = $1", [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("Supplier Partner realized-profit baseline", () => {
  it("preserves all-time behavior when no baseline is configured", async () => {
    await expect(getSupplierPartnerPosProfit(ctx.companyId, null, null)).resolves.toBe(60);
  });

  it("includes the baseline date, excludes earlier dates, and honors the report end date", async () => {
    await pool.query(
      "UPDATE company_settings SET sp_pos_profit_baseline_date = DATE '2026-09-01' WHERE company_id = $1",
      [ctx.companyId]
    );

    await expect(getSupplierPartnerPosProfit(ctx.companyId, "2026-09-01", null)).resolves.toBe(50);
    await expect(getSupplierPartnerPosProfit(ctx.companyId, "2026-09-01", "2026-08-31")).resolves.toBe(0);
    await expect(getSupplierPartnerPosProfit(ctx.companyId, "2026-09-01", "2026-09-01")).resolves.toBe(20);
  });

  it("returns and caches a configured zero result through the dashboard API", async () => {
    await pool.query(
      "UPDATE company_settings SET sp_pos_profit_baseline_date = DATE '2099-01-01' WHERE company_id = $1",
      [ctx.companyId]
    );

    const first = await agent.get("/api/stats/net-profit?toDate=2099-01-02");
    expect(first.status).toBe(200);
    expect(first.body.spPosProfit).toBe(0);
    expect(first.body.spPosProfitBaselineDate).toBe("2099-01-01");

    const cached = await agent.get("/api/stats/net-profit?toDate=2099-01-02");
    expect(cached.status).toBe(200);
    expect(cached.body.spPosProfit).toBe(0);
    expect(cached.body.spPosProfitBaselineDate).toBe("2099-01-01");
  });  it("shows each selected month independently without deleting earlier-month sales", async () => {
    await pool.query(
      "UPDATE company_settings SET sp_pos_profit_baseline_date = DATE '2026-09-01' WHERE company_id = $1",
      [ctx.companyId]
    );
    await insertSale("2026-10-03", "17");
    const september = await agent.get("/api/stats/net-profit?toDate=2026-09-30");
    expect(september.status).toBe(200);
    expect(september.body.spPosProfit).toBe(50);
    expect(september.body.spPosProfitPeriodStartDate).toBe("2026-09-01");

    const october = await agent.get("/api/stats/net-profit?toDate=2026-10-10");
    expect(october.status).toBe(200);
    expect(october.body.spPosProfit).toBe(17);
    expect(october.body.spPosProfitPeriodStartDate).toBe("2026-10-01");
    expect(october.body.spPosProfitAsOfDate).toBe("2026-10-10");

    // Historical records remain intact; only the report's date window changes.
    await expect(getSupplierPartnerPosProfit(ctx.companyId, "2026-09-01", "2026-10-10")).resolves.toBe(67);
  });


});
