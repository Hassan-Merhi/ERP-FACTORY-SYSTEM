/**
 * Silent transfer moves stock by location and stock item ids taken from the
 * request body. The path-based company scope never sees body ids, so the
 * routes must check them: another company's locations read as missing, and
 * another company's stock items refuse the whole transfer before anything
 * moves.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { createWorkbook, jsonToSheet, writeWorkbook } from "../server/excelHelper";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "silentxfer";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let foreignCompanyId: number;
let foreignSourceId: number;
let foreignDestId: number;
let foreignItemId: number;

async function quantityAt(locationId: number, stockItemId: number): Promise<string | null> {
  const result = await pool.query<{ quantity: string }>(
    `SELECT quantity FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
    [locationId, stockItemId]
  );
  return result.rows[0]?.quantity ?? null;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
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
  const locations = await pool.query<{ id: number }>(
    `INSERT INTO locations (company_id, code, name) VALUES ($1, 'SXF-A', 'Foreign A'), ($1, 'SXF-B', 'Foreign B') RETURNING id`,
    [foreignCompanyId]
  );
  [foreignSourceId, foreignDestId] = locations.rows.map((row) => row.id);
  const item = await pool.query<{ id: number }>(
    `INSERT INTO stock_items (company_id, code, name, uom, active) VALUES ($1, 'SXF-ITEM', 'Foreign item', 'PCS', true) RETURNING id`,
    [foreignCompanyId]
  );
  foreignItemId = item.rows[0].id;
  await pool.query(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
     VALUES ($1, $2, $3, '50.000', '4.00', '200.00')`,
    [foreignCompanyId, foreignSourceId, foreignItemId]
  );
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM stock_movements WHERE company_id = $1`, [foreignCompanyId]).catch(() => undefined);
  await pool.query(`DELETE FROM inventory WHERE company_id = $1`, [foreignCompanyId]);
  await pool.query(`DELETE FROM stock_items WHERE company_id = $1`, [foreignCompanyId]);
  await pool.query(`DELETE FROM locations WHERE company_id = $1`, [foreignCompanyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("silent transfer tenant scope", () => {
  it("refuses another company's locations on apply and moves nothing", async () => {
    const response = await agent.post("/api/inventory/silent-transfer/apply").send({
      sourceLocationId: foreignSourceId,
      destinationLocationId: foreignDestId,
      items: [{ stockItemId: foreignItemId, quantity: "5" }],
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Source location not found");
    expect(await quantityAt(foreignSourceId, foreignItemId)).toBe("50.000");
    expect(await quantityAt(foreignDestId, foreignItemId)).toBeNull();
  });

  it("refuses another company's stock item even between the company's own locations", async () => {
    const ownItemId = ctx.stockItemIds[0];
    const response = await agent.post("/api/inventory/silent-transfer/apply").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      items: [
        { stockItemId: ownItemId, quantity: "1" },
        { stockItemId: foreignItemId, quantity: "1" },
      ],
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Stock item not found");
    expect(await quantityAt(ctx.locationId, ownItemId)).toBe("100.000");
    expect(await quantityAt(foreignSourceId, foreignItemId)).toBe("50.000");
  });

  it("refuses another company's location when parsing an upload", async () => {
    const workbook = createWorkbook();
    jsonToSheet(workbook, [{ Barcode: "SXF-ITEM", Quantity: 1 }], "Transfer");
    const buffer = Buffer.from(await writeWorkbook(workbook));

    const response = await agent
      .post("/api/inventory/silent-transfer/parse")
      .field("sourceLocationId", String(foreignSourceId))
      .field("destinationLocationId", String(ctx.location2Id))
      .attach("file", buffer, "transfer.xlsx");

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Source location not found");
  });

  it("moves an exact quantity between the company's own locations", async () => {
    const ownItemId = ctx.stockItemIds[1];
    const response = await agent.post("/api/inventory/silent-transfer/apply").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      items: [{ stockItemId: ownItemId, quantity: "2.5" }],
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, itemsTransferred: 1 });
    expect(await quantityAt(ctx.locationId, ownItemId)).toBe("97.500");
    expect(await quantityAt(ctx.location2Id, ownItemId)).toBe("2.500");
  });
});
