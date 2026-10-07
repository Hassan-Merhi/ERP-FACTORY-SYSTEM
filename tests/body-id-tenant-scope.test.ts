/**
 * Location, stock item and bale ids taken from a request body are outside the
 * path-based company scope, so each route checks them itself:
 *
 *   - bale transfers: create moved any company's bales to any location, and
 *     view, complete, delete and edit reached a transfer by id alone;
 *   - stock transfer import: the single-source validate and import accepted
 *     another company's locations;
 *   - stock transfers: accepted another company's destination, sources and
 *     stock items;
 *   - credit and debit notes: booked stock at another company's location;
 *   - silent production: adjusted stock at another company's location.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "bodyscope";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let foreignCompanyId: number;
let foreignLocationId: number;
let foreignBaleId: number;
let ownBaleId: number;
let foreignTransferId: number;

async function login() {
  agent = request.agent(ctx.app);
  const response = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (response.status !== 200) throw new Error(`Login failed: ${response.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}

async function insertBale(companyId: number, locationId: number, code: string): Promise<number> {
  const bale = await pool.query<{ id: number }>(
    `INSERT INTO production_bales (company_id, location_id, bale_code, barcode_value, weight_kg, cost_per_kg, total_cost, status)
     VALUES ($1, $2, $3, $3, '100.000', '1.00', '100.00', 'IN_STOCK') RETURNING id`,
    [companyId, locationId, code]
  );
  return bale.rows[0].id;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await login();

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, base_currency) VALUES ($1, $2, 'USD') RETURNING id`,
    [`${TEST_PREFIX.toUpperCase()}F`, `${TEST_PREFIX}_Foreign`]
  );
  foreignCompanyId = company.rows[0].id;
  const location = await pool.query<{ id: number }>(
    `INSERT INTO locations (company_id, code, name) VALUES ($1, 'BSF-A', 'Foreign A') RETURNING id`,
    [foreignCompanyId]
  );
  foreignLocationId = location.rows[0].id;
  foreignBaleId = await insertBale(foreignCompanyId, foreignLocationId, `${TEST_PREFIX}-FB`);
  ownBaleId = await insertBale(ctx.companyId, ctx.locationId, `${TEST_PREFIX}-OB`);
  const transfer = await pool.query<{ id: number }>(
    `INSERT INTO bale_transfers (company_id, source_location_id, destination_location_id, transfer_date, created_by, status)
     VALUES ($1, $2, $2, '2026-10-01', 'foreign', 'PENDING') RETURNING id`,
    [foreignCompanyId, foreignLocationId]
  );
  foreignTransferId = transfer.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM bale_transfer_items WHERE production_bale_id = ANY($1)`, [[foreignBaleId, ownBaleId]]);
  await pool.query(`DELETE FROM bale_transfers WHERE company_id = ANY($1)`, [[foreignCompanyId, ctx.companyId]]);
  await pool.query(`DELETE FROM factory_daybook_entries WHERE company_id = $1`, [ctx.companyId]).catch(() => undefined);
  await pool.query(`DELETE FROM production_bales WHERE id = ANY($1)`, [[foreignBaleId, ownBaleId]]);
  await pool.query(`DELETE FROM stock_movements WHERE company_id = $1`, [foreignCompanyId]).catch(() => undefined);
  await pool.query(`DELETE FROM inventory WHERE location_id = $1`, [foreignLocationId]);
  await pool.query(`DELETE FROM locations WHERE company_id = $1`, [foreignCompanyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("bale transfers tenant scope", () => {
  const line = (productionBaleId: number) => ({ productionBaleId, weightKg: 100, costPerKg: 1, totalCost: 100 });

  it("refuses to move another company's bale and leaves it where it was", async () => {
    const response = await agent.post("/api/bale-transfers").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      transferDate: "2026-10-07",
      items: [line(foreignBaleId)],
    });
    expect(response.status).toBe(400);
    const bale = await pool.query(`SELECT location_id FROM production_bales WHERE id = $1`, [foreignBaleId]);
    expect(bale.rows[0].location_id).toBe(foreignLocationId);
  });

  it("refuses another company's destination location", async () => {
    const response = await agent.post("/api/bale-transfers").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: foreignLocationId,
      transferDate: "2026-10-07",
      items: [line(ownBaleId)],
    });
    expect(response.status).toBe(400);
    const bale = await pool.query(`SELECT location_id FROM production_bales WHERE id = $1`, [ownBaleId]);
    expect(bale.rows[0].location_id).toBe(ctx.locationId);
  });

  it("answers 404 for another company's transfer on every route by id", async () => {
    const base = `/api/bale-transfers/${foreignTransferId}`;
    const responses = [
      await agent.get(base),
      await agent.patch(`${base}/complete`),
      await agent.patch(base).send({ status: "COMPLETED", notes: "hijacked" }),
      await agent.delete(base),
    ];
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    const transfer = await pool.query(`SELECT status, notes FROM bale_transfers WHERE id = $1`, [foreignTransferId]);
    expect(transfer.rows[0]).toEqual({ status: "PENDING", notes: null });
  });

  it("still transfers the company's own bale between its own locations", async () => {
    const response = await agent.post("/api/bale-transfers").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      transferDate: "2026-10-07",
      items: [line(ownBaleId)],
    });
    expect(response.status).toBe(200);
    const bale = await pool.query(`SELECT location_id FROM production_bales WHERE id = $1`, [ownBaleId]);
    expect(bale.rows[0].location_id).toBe(ctx.location2Id);
  });
});

describe("stock transfer import tenant scope", () => {
  it("refuses another company's source location on validate and import", async () => {
    const validate = await agent.post("/api/stock-transfer-import/validate").send({
      sourceLocationId: foreignLocationId,
      destinationLocationId: ctx.location2Id,
      items: [{ barcode: `${TEST_PREFIX}-ITEM1`, quantity: 1 }],
    });
    expect(validate.status).toBe(200);
    expect(validate.body.errors).toEqual(["Source location not found"]);

    const vouchersBefore = await pool.query(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1`, [
      ctx.companyId,
    ]);
    const imported = await agent.post("/api/stock-transfer-import/import").send({
      sourceLocationId: foreignLocationId,
      destinationLocationId: ctx.location2Id,
      transferDate: "2026-10-07",
      items: [{ barcode: `${TEST_PREFIX}-ITEM1`, quantity: 1 }],
    });
    expect(imported.status).toBe(400);
    expect(imported.body.message).toBe("Source location not found");
    const vouchersAfter = await pool.query(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1`, [
      ctx.companyId,
    ]);
    expect(vouchersAfter.rows[0].n).toBe(vouchersBefore.rows[0].n);
  });
});

describe("stock transfer tenant scope", () => {
  it("refuses another company's destination, source or stock item and moves nothing", async () => {
    const ownItemId = ctx.stockItemIds[2];
    const attempts = [
      { sourceLocationId: ctx.locationId, destinationLocationId: foreignLocationId, stockItemId: ownItemId },
      { sourceLocationId: foreignLocationId, destinationLocationId: ctx.location2Id, stockItemId: ownItemId },
    ];
    for (const { stockItemId, ...locations } of attempts) {
      const response = await agent
        .post("/api/stock-transfers")
        .send({ ...locations, items: [{ stockItemId, quantity: "1" }] });
      expect(response.status).toBe(404);
    }
    const foreignItem = await agent.post("/api/stock-transfers").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      items: [{ stockItemId: 999999999, quantity: "1" }],
    });
    expect(foreignItem.status).toBe(400);

    const own = await pool.query(`SELECT quantity FROM inventory WHERE location_id = $1 AND stock_item_id = $2`, [
      ctx.locationId,
      ownItemId,
    ]);
    expect(own.rows[0].quantity).toBe("100.000");
    const foreign = await pool.query(`SELECT 1 FROM inventory WHERE location_id = $1`, [foreignLocationId]);
    expect(foreign.rowCount).toBe(0);
  });
});

describe("credit note tenant scope", () => {
  it("refuses another company's location and books nothing", async () => {
    const vouchersBefore = await pool.query(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1`, [
      ctx.companyId,
    ]);
    const response = await agent.post("/api/credit-notes").send({
      noteType: "Credit Note",
      voucherDate: "2026-10-07",
      cashAccountId: ctx.cashAccountId,
      cashAccountType: "ledger",
      items: [{ stockItemId: ctx.stockItemIds[0], locationId: foreignLocationId, quantity: "1", rate: "10" }],
    });
    expect(response.status).not.toBe(200);
    expect(response.body.message).toBe(`Location ${foreignLocationId} not found`);
    const vouchersAfter = await pool.query(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1`, [
      ctx.companyId,
    ]);
    expect(vouchersAfter.rows[0].n).toBe(vouchersBefore.rows[0].n);
    const rows = await pool.query(`SELECT 1 FROM inventory WHERE location_id = $1`, [foreignLocationId]);
    expect(rows.rowCount).toBe(0);
  });
});

describe("silent production tenant scope", () => {
  it("refuses another company's location", async () => {
    await pool.query(`UPDATE user_company_roles SET role = 'Developer' WHERE user_id = $1`, [ctx.userId]);
    await login();

    const response = await agent.post("/api/inventory/silent-production").send({
      locationId: foreignLocationId,
      type: "Production",
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: "5", rate: "1" }],
    });
    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Location not found");
    const rows = await pool.query(`SELECT 1 FROM inventory WHERE location_id = $1`, [foreignLocationId]);
    expect(rows.rowCount).toBe(0);
  });
});
