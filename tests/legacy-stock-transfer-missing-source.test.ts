/**
 * Regression coverage for the existing-voucher stock-transfer path.
 *
 * This path used to skip the source mutation when its inventory row was absent
 * and still credit the destination, creating stock from nothing. These cases
 * prove source/destination atomicity, the explicit negative-stock policy,
 * historical cost preservation, tenant isolation and exactly-once posting.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "legxfer";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let foreignLocationId = 0;
let voucherSequence = 0;

type InventoryRow = {
  quantity: string;
  average_rate: string;
  total_value: string;
};

async function resetInventory(): Promise<void> {
  await pool.query("DELETE FROM inventory_negative_layers WHERE company_id = $1", [ctx.companyId]);
  await pool.query("DELETE FROM inventory WHERE company_id = $1", [ctx.companyId]);
  for (const stockItemId of ctx.stockItemIds) {
    await pool.query(
      `INSERT INTO inventory
         (company_id, location_id, stock_item_id, quantity, average_rate, total_value, last_updated)
       VALUES ($1, $2, $3, '100.000', '10.00', '1000.00', NOW())`,
      [ctx.companyId, ctx.locationId, stockItemId]
    );
  }
}

async function inventoryRow(locationId: number, stockItemId: number): Promise<InventoryRow | null> {
  const { rows } = await pool.query<InventoryRow>(
    `SELECT quantity::text, average_rate::text, total_value::text
       FROM inventory
      WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
    [ctx.companyId, locationId, stockItemId]
  );
  return rows[0] ?? null;
}

async function createVoucher(description = "legacy transfer fixture"): Promise<number> {
  voucherSequence += 1;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO vouchers
       (company_id, location_id, voucher_type, voucher_number, voucher_date, description, total_amount, optional)
     VALUES ($1, $2, 'Stock Transfer', $3, CURRENT_DATE, $4, '0.00', false)
     RETURNING id`,
    [ctx.companyId, ctx.locationId, `LEG-XFER-${Date.now()}-${voucherSequence}`, description]
  );
  return Number(rows[0].id);
}

function legacyBody(
  voucherId: number,
  items: Array<{ stockItemId: number; sourceLocationId: number; quantity: string; rate: string }>,
  overrides: Record<string, unknown> = {}
) {
  return {
    voucherId,
    destinationLocationId: ctx.location2Id,
    notes: "legacy transfer regression",
    items,
    ...overrides,
  };
}

async function transferForVoucher(voucherId: number): Promise<{ id: number } | null> {
  const { rows } = await pool.query<{ id: number }>("SELECT id FROM stock_transfer_vouchers WHERE voucher_id = $1", [
    voucherId,
  ]);
  return rows[0] ?? null;
}

async function voucherState(voucherId: number) {
  const { rows } = await pool.query<{ description: string | null; total_amount: string }>(
    "SELECT description, total_amount::text FROM vouchers WHERE id = $1",
    [voucherId]
  );
  return rows[0];
}

async function journalRows(transferId: number) {
  const { rows } = await pool.query<{
    location_id: number;
    quantity_delta: string;
    unit_cost: string;
    idempotency_key: string;
  }>(
    `SELECT location_id, quantity_delta::text, unit_cost::text, idempotency_key
       FROM canonical_stock_movements
      WHERE company_id = $1
        AND source_type = 'stock-transfer'
        AND source_id = $2
      ORDER BY id`,
    [ctx.companyId, String(transferId)]
  );
  return rows;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  const [foreignCompany] = await db
    .insert(schema.companies)
    .values({
      code: "LEGXFERFOREIGN",
      name: `${TEST_PREFIX}_ForeignCompany`,
      baseCurrency: "USD",
    })
    .returning();
  const [foreignLocation] = await db
    .insert(schema.locations)
    .values({
      companyId: foreignCompany.id,
      code: "LEGXFER-FOREIGN-LOC",
      name: `${TEST_PREFIX}_ForeignLocation`,
    })
    .returning();
  foreignLocationId = foreignLocation.id;
}, 120000);

beforeEach(async () => {
  await resetInventory();
}, 30000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("legacy existing-voucher stock transfer source/destination integrity", () => {
  it("creates a missing source as negative at the transfer cost when negative stock is enabled", async () => {
    const stockItemId = ctx.stockItemIds[0];
    await pool.query("DELETE FROM inventory WHERE location_id = $1 AND stock_item_id = $2", [
      ctx.locationId,
      stockItemId,
    ]);

    const voucherId = await createVoucher();
    const res = await agent.post("/api/stock-transfers").send(
      legacyBody(voucherId, [{ stockItemId, sourceLocationId: ctx.locationId, quantity: "4.000", rate: "12.34" }], {
        allowNegativeInventory: true,
      })
    );

    expect(res.status).toBe(201);
    const source = await inventoryRow(ctx.locationId, stockItemId);
    const destination = await inventoryRow(ctx.location2Id, stockItemId);
    expect(source).not.toBeNull();
    expect(Number(source!.quantity)).toBe(-4);
    expect(Number(source!.average_rate)).toBeCloseTo(12.34, 2);
    // Wave 15 (H3): the short source keeps the negative value of the shortage
    // (negative-stock policy), exactly what the destination received; it used
    // to be reset to 0, which created 49.36 of stock value from nothing.
    expect(source!.total_value).toBe("-49.36");
    expect(destination).not.toBeNull();
    expect(Number(destination!.quantity)).toBe(4);
    expect(Number(destination!.average_rate)).toBeCloseTo(12.34, 2);
    expect(destination!.total_value).toBe("49.36");

    const { rows } = await pool.query<{ qty: string; provisional_rate: string }>(
      `SELECT COALESCE(SUM(qty), 0)::text AS qty, MAX(provisional_rate)::text AS provisional_rate
         FROM inventory_negative_layers
        WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
      [ctx.companyId, ctx.locationId, stockItemId]
    );
    expect(Number(rows[0].qty)).toBe(4);
    expect(Number(rows[0].provisional_rate)).toBeCloseTo(12.34, 2);
  }, 60000);

  it("rejects a missing source before either side changes when negative stock is disabled", async () => {
    const stockItemId = ctx.stockItemIds[0];
    await pool.query("DELETE FROM inventory WHERE location_id = $1 AND stock_item_id = $2", [
      ctx.locationId,
      stockItemId,
    ]);
    const voucherId = await createVoucher("unchanged before rejection");
    const beforeVoucher = await voucherState(voucherId);

    const res = await agent.post("/api/stock-transfers").send(
      legacyBody(voucherId, [{ stockItemId, sourceLocationId: ctx.locationId, quantity: "1.000", rate: "8.75" }], {
        allowNegativeInventory: false,
      })
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STOCK_TRANSFER_NEGATIVE_STOCK_DISABLED");
    expect(await inventoryRow(ctx.locationId, stockItemId)).toBeNull();
    expect(await inventoryRow(ctx.location2Id, stockItemId)).toBeNull();
    expect(await transferForVoucher(voucherId)).toBeNull();
    expect(await voucherState(voucherId)).toEqual(beforeVoucher);
  }, 60000);

  it("uses locked source cost when destination inventory is missing", async () => {
    const stockItemId = ctx.stockItemIds[1];
    const voucherId = await createVoucher();

    const res = await agent.post("/api/stock-transfers").send(
      legacyBody(voucherId, [
        {
          stockItemId,
          sourceLocationId: ctx.locationId,
          quantity: "5.000",
          // Deliberately wrong/display-like value: the locked source row is $10.
          rate: "99.99",
        },
      ])
    );

    expect(res.status).toBe(201);
    expect(Number((await inventoryRow(ctx.locationId, stockItemId))!.quantity)).toBe(95);
    const destination = await inventoryRow(ctx.location2Id, stockItemId);
    expect(destination).not.toBeNull();
    expect(Number(destination!.quantity)).toBe(5);
    expect(Number(destination!.average_rate)).toBe(10);
    expect(Number(destination!.total_value)).toBe(50);
    expect(Number(res.body.items[0].rate)).toBe(10);
  }, 60000);

  it("rolls back all transfer-side records when a later item is invalid", async () => {
    const validStockItemId = ctx.stockItemIds[0];
    const missingStockItemId = 2147483000;
    const voucherId = await createVoucher("rollback marker");
    const beforeVoucher = await voucherState(voucherId);
    const beforeSource = await inventoryRow(ctx.locationId, validStockItemId);

    const res = await agent.post("/api/stock-transfers").send(
      legacyBody(voucherId, [
        { stockItemId: validStockItemId, sourceLocationId: ctx.locationId, quantity: "3.000", rate: "10.00" },
        { stockItemId: missingStockItemId, sourceLocationId: ctx.locationId, quantity: "1.000", rate: "10.00" },
      ])
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("STOCK_TRANSFER_SCOPE_INVALID");
    expect(await transferForVoucher(voucherId)).toBeNull();
    expect(await inventoryRow(ctx.locationId, validStockItemId)).toEqual(beforeSource);
    expect(await inventoryRow(ctx.location2Id, validStockItemId)).toBeNull();
    expect(await voucherState(voucherId)).toEqual(beforeVoucher);

    const { rows: ledgerRows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM voucher_entries WHERE voucher_id = $1",
      [voucherId]
    );
    expect(Number(ledgerRows[0].count)).toBe(0);
  }, 60000);

  it("applies concurrent duplicate submissions for one voucher exactly once", async () => {
    const stockItemId = ctx.stockItemIds[2];
    const voucherId = await createVoucher();
    const body = legacyBody(voucherId, [
      { stockItemId, sourceLocationId: ctx.locationId, quantity: "2.000", rate: "10.00" },
    ]);

    const [first, second] = await Promise.all([
      agent.post("/api/stock-transfers").send(body),
      agent.post("/api/stock-transfers").send(body),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect([first.body.code, second.body.code].filter(Boolean)).toContain("STOCK_TRANSFER_ALREADY_EXISTS");

    const source = await inventoryRow(ctx.locationId, stockItemId);
    const destination = await inventoryRow(ctx.location2Id, stockItemId);
    expect(Number(source!.quantity)).toBe(98);
    expect(Number(destination!.quantity)).toBe(2);

    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM stock_transfer_vouchers WHERE voucher_id = $1",
      [voucherId]
    );
    expect(Number(rows[0].count)).toBe(1);
  }, 60000);

  it("writes balanced canonical source and destination journal rows in the same transfer", async () => {
    const stockItemId = ctx.stockItemIds[0];
    const voucherId = await createVoucher();
    const res = await agent
      .post("/api/stock-transfers")
      .send(
        legacyBody(voucherId, [{ stockItemId, sourceLocationId: ctx.locationId, quantity: "7.000", rate: "10.00" }])
      );

    expect(res.status).toBe(201);
    const transferId = Number(res.body.transfer.id);
    const rows = await journalRows(transferId);
    expect(rows).toHaveLength(2);

    const source = rows.find((row) => Number(row.quantity_delta) < 0);
    const destination = rows.find((row) => Number(row.quantity_delta) > 0);
    expect(source).toBeDefined();
    expect(destination).toBeDefined();
    expect(Number(source!.location_id)).toBe(ctx.locationId);
    expect(Number(destination!.location_id)).toBe(ctx.location2Id);
    expect(Number(source!.quantity_delta)).toBe(-7);
    expect(Number(destination!.quantity_delta)).toBe(7);
    expect(Number(source!.unit_cost)).toBe(10);
    expect(Number(destination!.unit_cost)).toBe(10);
    expect(source!.idempotency_key).toBe(destination!.idempotency_key);
  }, 60000);

  it("rejects a source location from another company without creating or moving stock", async () => {
    const stockItemId = ctx.stockItemIds[1];
    const voucherId = await createVoucher();
    const beforeDestination = await inventoryRow(ctx.location2Id, stockItemId);
    const { rows: journalBeforeRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM canonical_stock_movements
        WHERE company_id = $1 AND source_type = 'stock-transfer'`,
      [ctx.companyId]
    );
    const journalBefore = Number(journalBeforeRows[0].count);

    const res = await agent
      .post("/api/stock-transfers")
      .send(
        legacyBody(voucherId, [{ stockItemId, sourceLocationId: foreignLocationId, quantity: "1.000", rate: "10.00" }])
      );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("STOCK_TRANSFER_SCOPE_INVALID");
    expect(await transferForVoucher(voucherId)).toBeNull();
    expect(await inventoryRow(ctx.location2Id, stockItemId)).toEqual(beforeDestination);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM canonical_stock_movements
        WHERE company_id = $1 AND source_type = 'stock-transfer'`,
      [ctx.companyId]
    );
    expect(Number(rows[0].count)).toBe(journalBefore);
  }, 60000);
});
