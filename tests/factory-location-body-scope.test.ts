/**
 * Factory stock entry, bale import and bale finalize take an `erpLocationId`
 * from the body and put stock there. The path-based company scope never sees
 * it, so each route now refuses a location that belongs to neither the
 * factory company nor the session company.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "factloc";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let foreignCompanyId: number;
let foreignLocationId: number;

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

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, base_currency) VALUES ($1, $2, 'USD') RETURNING id`,
    [`${TEST_PREFIX.toUpperCase()}F`, `${TEST_PREFIX}_Foreign`]
  );
  foreignCompanyId = company.rows[0].id;
  const location = await pool.query<{ id: number }>(
    `INSERT INTO locations (company_id, code, name) VALUES ($1, 'FLF-A', 'Foreign A') RETURNING id`,
    [foreignCompanyId]
  );
  foreignLocationId = location.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM inventory WHERE location_id = $1`, [foreignLocationId]);
  await pool.query(`DELETE FROM locations WHERE company_id = $1`, [foreignCompanyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("factory routes refuse another company's ERP location", () => {
  it("stock entry, bale import and finalize answer 400 before writing", async () => {
    const responses = [
      await agent.post("/api/factory/stock-entry").send({
        erpLocationId: foreignLocationId,
        items: [{ productId: 1, weightKg: 10 }],
      }),
      await agent.post("/api/factory/bales/import").send({
        erpLocationId: foreignLocationId,
        bales: [{ itemName: "Item", barcode: `${TEST_PREFIX}-B1`, weight: "10" }],
      }),
      await agent.post("/api/factory/finalize").send({
        erpLocationId: foreignLocationId,
        pressingBatchId: 1,
        scannedBaleIds: [1],
        mixBatchId: 1,
      }),
    ];
    expect(responses.map((response) => [response.status, response.body.message])).toEqual([
      [400, "Location not found"],
      [400, "Location not found"],
      [400, "Location not found"],
    ]);
    const rows = await pool.query(`SELECT 1 FROM inventory WHERE location_id = $1`, [foreignLocationId]);
    expect(rows.rowCount).toBe(0);
  });

  it("still accepts the company's own location past the location check", async () => {
    const response = await agent.post("/api/factory/bales/import").send({
      erpLocationId: ctx.locationId,
      bales: [{ itemName: "Item", barcode: `${TEST_PREFIX}-B2`, weight: "10" }],
    });
    expect(response.body.message).not.toBe("Location not found");
  });
});
