/**
 * Canonical journal evidence for factory stock entry.
 *
 * A stock entry writes a batch of bales and raises ERP inventory for each
 * distinct stock item. Unlike every other domain it has no header row of its
 * own, so the journal keys its evidence on a synthetic batch key: the smallest
 * bale id written by the entry. Bale ids are never reused, so that key is
 * unique to the entry and stable afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";
import { pool } from "../server/db";

const TEST_PREFIX = "canonfse";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let productId: number;

async function entryJournalRows(companyId: number) {
  const { rows } = await pool.query(
    `SELECT quantity_delta, unit_cost, movement_kind, location_id, source_id, idempotency_key
       FROM canonical_stock_movements
      WHERE company_id = $1 AND source_type = 'factory-stock-entry'
      ORDER BY id`,
    [companyId]
  );
  return rows;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);

  // The fixture seeds a factory-typed company for this prefix (see
  // FACTORY_COMPANY_PREFIXES in setup.ts): factory routes are pinned to one by
  // the tenant boundary.

  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const { rows } = await pool.query(
    `INSERT INTO factory_bale_products (company_id, code, name, article_code, production_price)
     VALUES ($1, $2, $3, $4, '4.00')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}P`.slice(0, 20).toUpperCase(), `${TEST_PREFIX}_product`, `${TEST_PREFIX}ART`]
  );
  productId = Number(rows[0].id);
}, 60000);

afterAll(async () => {
  await pool.query(`DELETE FROM canonical_stock_movement_audit WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM canonical_stock_movement_requests WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM canonical_stock_movements WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(
    `DELETE FROM factory_bale_production_attributions WHERE bale_id IN (
       SELECT id FROM factory_bales WHERE company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM factory_bales WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_bale_sequences WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_bale_products WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("canonical journal for factory stock entry", () => {
  it("records a receipt keyed on the batch's smallest bale id", async () => {
    const res = await agent.post("/api/factory/stock-entry").send({
      erpLocationId: ctx.locationId,
      entryDate: new Date().toISOString().split("T")[0],
      items: [{ productId, quantity: 3, weightPerBale: "25" }],
    });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const rows = await entryJournalRows(ctx.companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0].movement_kind).toBe("receipt");
    expect(Number(rows[0].location_id)).toBe(ctx.locationId);
    // Three bales of one product raise that item by three.
    expect(Number(rows[0].quantity_delta)).toBe(3);
    // Wave 11: the ERP mirror of factory bales is quantity only, so the receipt
    // is at unit cost 0 (the factory values its bales in factory_bales.total_cost).
    expect(Number(rows[0].unit_cost)).toBe(0);

    // The synthetic key is the smallest bale id the entry wrote.
    const { rows: baleRows } = await pool.query(
      `SELECT min(id)::text AS "minId" FROM factory_bales WHERE company_id = $1`,
      [ctx.companyId]
    );
    expect(rows[0].source_id).toBe(baleRows[0].minId);
  }, 60000);

  it("keeps a second entry's evidence under its own batch key", async () => {
    const before = await entryJournalRows(ctx.companyId);

    const res = await agent.post("/api/factory/stock-entry").send({
      erpLocationId: ctx.locationId,
      entryDate: new Date().toISOString().split("T")[0],
      items: [{ productId, quantity: 2, weightPerBale: "25" }],
    });
    expect(res.status).toBeLessThan(300);

    const after = await entryJournalRows(ctx.companyId);
    const written = after.slice(before.length);
    expect(written).toHaveLength(1);
    expect(Number(written[0].quantity_delta)).toBe(2);

    // Two entries, two batch keys — one entry's stock-in is never mistaken for
    // a replay of the other.
    expect(written[0].source_id).not.toBe(before[0].source_id);
    const keys = new Set(after.map((row) => row.idempotency_key));
    expect(keys.size).toBe(after.length);
  }, 60000);

  it("totals the entry's weight exactly", async () => {
    const res = await agent.post("/api/factory/stock-entry").send({
      erpLocationId: ctx.locationId,
      entryDate: new Date().toISOString().split("T")[0],
      items: [
        { productId, quantity: 1, weightPerBale: "0.1" },
        { productId, quantity: 1, weightPerBale: "0.2" },
      ],
    });
    expect(res.status).toBeLessThan(300);
    // The float sum was 0.30000000000000004.
    expect(res.body.totalWeight).toBe(0.3);
  }, 60000);
});
