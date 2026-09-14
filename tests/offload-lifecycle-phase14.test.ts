import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p14off";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let containerId: number;

async function inventory() {
  const result = await pool.query<{ quantity: string; average_rate: string; total_value: string }>(
    `SELECT quantity, average_rate, total_value
       FROM inventory
      WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
    [ctx.companyId, ctx.locationId, ctx.stockItemIds[0]]
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0];
}

async function activeChargeVouchers() {
  return pool.query<{ id: number; voucher_number: string; total_amount: string }>(
    `SELECT id, voucher_number, total_amount
       FROM vouchers
      WHERE company_id = $1
        AND deleted_at IS NULL
        AND description ILIKE $2
        AND (
          voucher_number LIKE 'DUTY-%' OR
          voucher_number LIKE 'TRANS-%' OR
          voucher_number LIKE 'XFER-%' OR
          voucher_number LIKE 'CHG-%'
        )
      ORDER BY id`,
    [ctx.companyId, `%container P14-CN-%`]
  );
}

async function chargeEntryTotals(voucherIds: number[]) {
  if (voucherIds.length === 0) return { rows: [] as Array<{ voucher_id: number; debit: string; credit: string }> };
  return pool.query<{ voucher_id: number; debit: string; credit: string }>(
    `SELECT voucher_id,
            SUM(COALESCE(debit_amount, 0))::text AS debit,
            SUM(COALESCE(credit_amount, 0))::text AS credit
       FROM voucher_entries
      WHERE voucher_id = ANY($1::int[])
      GROUP BY voucher_id
      ORDER BY voucher_id`,
    [voucherIds]
  );
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

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email)
     VALUES ($1, 'P14SUP', $2, $3)
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}_supplier`, `${TEST_PREFIX}@example.test`]
  );
  supplierId = Number(supplier.rows[0].id);

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const container = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date)
     VALUES ($1, $2, $3, 'OTW', CURRENT_DATE)
     RETURNING id`,
    [ctx.companyId, `P14-CN-${suffix}`.slice(0, 30), supplierId]
  );
  containerId = Number(container.rows[0].id);

  const po = await pool.query<{ id: number }>(
    `INSERT INTO purchase_orders (company_id, po_number, container_id, supplier_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [ctx.companyId, `P14-PO-${suffix}`.slice(0, 30), containerId, supplierId]
  );
  await pool.query(
    `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
     VALUES ($1, $2, 'Phase 14 lifecycle item', '10', '7', '70')`,
    [Number(po.rows[0].id), ctx.stockItemIds[0]]
  );

  await pool.query(
    `UPDATE inventory
        SET quantity = '0', average_rate = '0', total_value = '0'
      WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
    [ctx.companyId, ctx.locationId, ctx.stockItemIds[0]]
  );
}, 120_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("Phase 14 offload lifecycle", () => {
  it("offload -> reverse -> re-offload leaves one complete accounting and inventory result", async () => {
    const payload = {
      locationId: ctx.locationId,
      offloadDate: "2026-09-14",
      duties: "12.00",
      dutiesAccountId: ctx.cashAccountId,
      officeCharges: "0",
      transferCharges: "5.00",
      transportFees: "8.00",
      transportAccountId: ctx.cashAccountId,
      additionalCharges: [
        {
          description: "Phase 14 post-offload handling",
          amount: 4,
          ledgerAccountId: ctx.cashAccountId,
        },
      ],
    };

    const first = await agent.post(`/api/containers/${containerId}/offload`).send(payload);
    expect(first.status).toBe(200);

    let stock = await inventory();
    expect(Number(stock.quantity)).toBeCloseTo(10, 3);
    expect(Number(stock.total_value)).toBeCloseTo(99, 2);
    expect(Number(stock.average_rate)).toBeCloseTo(9.9, 2);

    const firstOffload = await pool.query<{ id: number; total_charges: string }>(
      `SELECT id, total_charges FROM container_offloads WHERE container_id = $1`,
      [containerId]
    );
    expect(firstOffload.rowCount).toBe(1);
    expect(Number(firstOffload.rows[0].total_charges)).toBeCloseTo(29, 2);

    const firstCharges = await activeChargeVouchers();
    expect(firstCharges.rowCount).toBe(4);
    const firstTotals = firstCharges.rows.map((row) => Number(row.total_amount)).sort((a, b) => a - b);
    expect(firstTotals).toEqual([4, 5, 8, 12]);
    const firstEntries = await chargeEntryTotals(firstCharges.rows.map((row) => row.id));
    expect(firstEntries.rows).toHaveLength(4);
    for (const row of firstEntries.rows) {
      expect(Number(row.debit)).toBeCloseTo(Number(row.credit), 2);
      expect(Number(row.debit)).toBeGreaterThan(0);
    }

    const reversed = await agent.post(`/api/containers/${containerId}/reverse-offload`).send({});
    expect(reversed.status).toBe(200);

    stock = await inventory();
    expect(Number(stock.quantity)).toBeCloseTo(0, 3);
    expect(Number(stock.total_value)).toBeCloseTo(0, 2);
    expect((await pool.query(`SELECT id FROM container_offloads WHERE container_id = $1`, [containerId])).rowCount).toBe(0);
    expect((await activeChargeVouchers()).rowCount).toBe(0);

    const retiredEntries = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM voucher_entries
        WHERE voucher_id = ANY($1::int[])`,
      [firstCharges.rows.map((row) => row.id)]
    );
    expect(Number(retiredEntries.rows[0].count)).toBe(0);

    const reoffload = await agent.post(`/api/containers/${containerId}/offload`).send(payload);
    expect(reoffload.status).toBe(200);

    stock = await inventory();
    expect(Number(stock.quantity)).toBeCloseTo(10, 3);
    expect(Number(stock.total_value)).toBeCloseTo(99, 2);
    expect(Number(stock.average_rate)).toBeCloseTo(9.9, 2);

    const finalOffload = await pool.query<{ id: number; total_charges: string }>(
      `SELECT id, total_charges FROM container_offloads WHERE container_id = $1`,
      [containerId]
    );
    expect(finalOffload.rowCount).toBe(1);
    expect(Number(finalOffload.rows[0].total_charges)).toBeCloseTo(29, 2);
    expect(finalOffload.rows[0].id).not.toBe(firstOffload.rows[0].id);

    const finalCharges = await activeChargeVouchers();
    expect(finalCharges.rowCount).toBe(4);
    const finalEntries = await chargeEntryTotals(finalCharges.rows.map((row) => row.id));
    expect(finalEntries.rows).toHaveLength(4);
    for (const row of finalEntries.rows) {
      expect(Number(row.debit)).toBeCloseTo(Number(row.credit), 2);
      expect(Number(row.debit)).toBeGreaterThan(0);
    }

    const evidence = await pool.query<{ source_type: string; movement_kind: string; quantity_delta: string }>(
      `SELECT source_type, movement_kind, quantity_delta
         FROM canonical_stock_movements
        WHERE company_id = $1 AND stock_item_id = $2
          AND source_type IN ('container-offload', 'container-reverse-offload')
        ORDER BY id`,
      [ctx.companyId, ctx.stockItemIds[0]]
    );
    expect(evidence.rows.filter((row) => row.source_type === "container-offload")).toHaveLength(2);
    expect(evidence.rows.filter((row) => row.source_type === "container-reverse-offload")).toHaveLength(1);
    expect(evidence.rows.map((row) => Number(row.quantity_delta))).toEqual([10, -10, 10]);
  }, 120_000);
});
