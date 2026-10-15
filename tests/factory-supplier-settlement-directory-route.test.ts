/**
 * End to end: the supplier directory card equals the inside Settlement
 * Statement's Net Balance converted at the Factory Settings rate, with the
 * "Include OTW" toggle on and off, and the factory Net Position carries the
 * same supplier figure with OTW containers included.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "fssd";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;

async function makeEurContainer(number: string, status: string, kg: string, freight: string) {
  await pool.query(
    `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, currency_code, fx_rate_to_usd, fx_rate_confirmed,
        fx_rate_source, rate_per_kg, total_kg, actual_received_kg, status, arrival_date,
        duty_status, freight, freight_paid_by, freight_currency_code, other_charges, commission_amount)
     VALUES ($1, $2, $3, 'EUR', '1.10', true, 'manual', '0.50', $4, $4, $5, '2026-06-08',
             'NONE', $6, 'supplier', 'EUR', '0', '0')`,
    [ctx.companyId, `${TEST_PREFIX}-${number}`, supplierId, kg, status, freight]
  );
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  await pool.query(
    `INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source)
     VALUES ($1, 'EUR', '1.18000000', '2026-06-01', 'manual')`,
    [ctx.companyId]
  );
  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers (company_id, name, is_active) VALUES ($1, $2, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} Euro Supplier`]
  );
  supplierId = supplier.rows[0].id;
  // Offloaded EUR 50,000 goods + EUR 1,000 freight; OTW EUR 5,000 goods + EUR 300 freight.
  await makeEurContainer("C1", "OFFLOADED", "100000", "1000");
  await makeEurContainer("C2", "IN_TRANSIT", "10000", "300");
  // A deleted container's other charges must not reach the supplier.
  await pool.query(
    `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, currency_code, fx_rate_to_usd, fx_rate_confirmed,
        fx_rate_source, rate_per_kg, total_kg, actual_received_kg, status, arrival_date, duty_status,
        freight, other_charges, other_charges_supplier_id, other_charges_currency_code, commission_amount, deleted_at)
     VALUES ($1, $2, $3, 'EUR', '1.10', true, 'manual', '0.50', '1000', '1000', 'OFFLOADED', '2026-06-08', 'NONE',
             '0', '999', $3, 'EUR', '0', now())`,
    [ctx.companyId, `${TEST_PREFIX}-DELETED`, supplierId]
  );
  // EUR 20,000 settled to USD at the historical 1.10 rate.
  await pool.query(
    `INSERT INTO factory_supplier_fx_transfers
       (company_id, from_supplier_id, to_supplier_id, date, from_currency_code, from_amount, fx_rate_to_usd, to_amount_usd, source_type)
     VALUES ($1, $2, $2, '2026-06-09', 'EUR', '20000', '1.10', '22000', 'supplier')`,
    [ctx.companyId, supplierId]
  );

  // A broker whose only container arrives after 2026-06-15.
  const broker = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers (company_id, name, is_active, is_broker) VALUES ($1, $2, true, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} Broker`]
  );
  await pool.query(
    `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, currency_code, fx_rate_to_usd, fx_rate_confirmed,
        fx_rate_source, rate_per_kg, total_kg, actual_received_kg, status, arrival_date, duty_status,
        freight, other_charges, commission_amount, created_at)
     VALUES ($1, $2, $3, 'USD', '1', true, 'manual', '1.00', '5000', '5000', 'OFFLOADED', '2026-07-01', 'NONE',
             '0', '0', '0', '2026-07-01')`,
    [ctx.companyId, `${TEST_PREFIX}-BROKER`, broker.rows[0].id]
  );

  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM factory_supplier_fx_transfers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

async function inside(includeOtw: boolean) {
  const response = await agent.get(`/api/factory/suppliers/${supplierId}/statement?includeOtw=${includeOtw}`);
  expect(response.status).toBe(200);
  return response.body.currencyGroups as { currencyCode: string; netPayable: string }[];
}

async function outside(includeOtw: boolean) {
  const response = await agent.get(`/api/factory/suppliers/with-balances?includeOtw=${includeOtw}`);
  expect(response.status).toBe(200);
  return (response.body as { id: number; usdEquivalentBalance: string | null }[]).find((s) => s.id === supplierId)!;
}

describe("supplier directory = inside settlement statement", () => {
  it("excludes OTW containers on both sides when the toggle is off", async () => {
    const pools = await inside(false);
    // Signed EUR pool from the statement, plus USD created by the self-FX.
    const eur = pools.find((p) => p.currencyCode === "EUR")!;
    const usd = pools.find((p) => p.currencyCode === "USD");
    expect(eur.netPayable).toBe("31000.00");
    const expected = 31000 * 1.18 + Number(usd?.netPayable ?? 0);
    expect(Number((await outside(false)).usdEquivalentBalance)).toBeCloseTo(expected, 2);
  });

  it("includes OTW containers on both sides when the toggle is on", async () => {
    const pools = await inside(true);
    const eur = pools.find((p) => p.currencyCode === "EUR")!;
    const usd = pools.find((p) => p.currencyCode === "USD");
    expect(eur.netPayable).toBe("36300.00");
    const expected = 36300 * 1.18 + Number(usd?.netPayable ?? 0);
    expect(Number((await outside(true)).usdEquivalentBalance)).toBeCloseTo(expected, 2);
  });

  it("puts the Include-OTW figure on the factory Net Position", async () => {
    const card = Number((await outside(true)).usdEquivalentBalance);
    const response = await agent.get("/api/factory/net-position");
    expect(response.status).toBe(200);
    const row = (response.body.onUs.accounts as { name: string; code: string; value: number }[]).find(
      (account) => account.code === "SUPPLIER" && account.name === `${TEST_PREFIX} Euro Supplier`
    );
    expect(row?.value).toBeCloseTo(card, 2);
  });

  it("limits broker balances on a past-date Net Position to that date", async () => {
    const accountFor = async (query: string) => {
      const response = await agent.get(`/api/factory/net-position${query}`);
      expect(response.status).toBe(200);
      return (response.body.onUs.accounts as { name: string; value: number }[]).find(
        (account) => account.name === `${TEST_PREFIX} Broker`
      );
    };
    expect((await accountFor(""))?.value).toBeCloseTo(5000, 2);
    expect(await accountFor("?asOf=2026-06-15")).toBeUndefined();
  });
});
