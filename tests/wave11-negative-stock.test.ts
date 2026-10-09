/**
 * Wave 11 (inventory fidelity), agent A: negative stock is allowed and costed
 * provisionally (owner decision 2).
 *
 *   - a short issue relieves the shortage at the item's cost memory, so the
 *     row's total_value goes negative by exactly the value the issue reports
 *     (valueDelta), and a negative layer records the shortage quantity;
 *   - a receipt that covers the shortage takes back the provisional value of
 *     the settled quantity, receives the rest at the receipt rate, and reports
 *     (receipt rate − provisional rate) × settled quantity as
 *     shortageSettlementVariance; receiptValue = valueDelta + variance;
 *   - a partial cover settles pro rata and leaves the remaining shortage at
 *     its provisional rate;
 *   - an exact reversal into shortage leaves the negative value and records
 *     the layer under the row's own company;
 *   - through the POS: a short sale posts its COGS at the provisional cost;
 *     the covering offload's STOCK-IN debits Inventory with exactly what the
 *     sub-ledger received and posts the variance to COGS.
 */
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { adjustInventory, receiveInventoryAtValue, reverseInventoryByExactValue } from "../server/inventoryHelper";
import { relievedValue } from "../server/services/accounting/perpetualInventory/saleCogs";
import { createPurchaseOrder } from "../server/storage/containers-store/purchase-orders";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w11neg";
const today = new Date().toISOString().slice(0, 10);

let ctx: TestContext;
let agent: request.SuperAgentTest;
let item: number;

async function row() {
  const { rows } = await pool.query(
    `SELECT quantity::text AS q, total_value::text AS v, average_rate::text AS r
       FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
    [ctx.locationId, item]
  );
  return rows[0] as { q: string; v: string; r: string } | undefined;
}

async function layers() {
  const { rows } = await pool.query(
    `SELECT company_id, qty::text AS q, provisional_rate::text AS r FROM inventory_negative_layers
      WHERE location_id = $1 AND stock_item_id = $2 ORDER BY id`,
    [ctx.locationId, item]
  );
  return rows.map((layer) => [layer.company_id, layer.q, layer.r]);
}

const move = (delta: number, rate?: number) =>
  db.transaction((tx) => adjustInventory(tx, ctx.locationId, item, delta, ctx.companyId, rate));

/** A journal's lines; STOCK-IN-{container} reads its per-offload journals (wave 17 B). */
async function journalLines(voucherNumber: string) {
  const { rows } = await pool.query(
    `SELECT la.code, ve.debit_amount::text AS d, ve.credit_amount::text AS c
       FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE v.company_id = $1 AND v.deleted_at IS NULL
        AND (v.voucher_number = $2 OR ($2 LIKE 'STOCK-IN-%' AND v.voucher_number LIKE $2 || '-%')) ORDER BY la.code`,
    [ctx.companyId, voucherNumber]
  );
  return rows.map((line) => [line.code, line.d, line.c]);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  item = ctx.stockItemIds[0];
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM inventory_negative_layers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

beforeEach(async () => {
  await pool.query(`DELETE FROM inventory_negative_layers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM inventory WHERE company_id = $1`, [ctx.companyId]);
});

describe("the costing engine under the negative-stock policy", () => {
  it("relieves a short issue at the cost memory and goes negative by the same value", async () => {
    await move(10, 6);
    const issued = await move(-15);
    expect(issued.valueDelta).toBe("-90.00"); // 60.00 on hand + 5 short × 6.00
    expect(relievedValue(issued).toFixed(2)).toBe("90.00");
    expect(await row()).toMatchObject({ q: "-5.000", v: "-30.00" });
    expect(await layers()).toEqual([[ctx.companyId, "5.000", "6.0000"]]);

    // Still short: a further issue relieves at the same provisional rate.
    const more = await move(-2);
    expect(more.valueDelta).toBe("-12.00");
    expect(await row()).toMatchObject({ q: "-7.000", v: "-42.00" });
  });

  it("settles a shortage on the covering receipt and reports the price difference", async () => {
    await move(10, 6);
    await move(-15); // -5 / -30.00
    const received = await move(10, 8);
    // 5 settled take back 30.00; 5 received at 8.00 = 40.00.
    expect(received.valueDelta).toBe("70.00");
    expect(received.receiptValue).toBe("80.00");
    expect(received.settledQuantity).toBe(5);
    expect(received.shortageSettlementVariance).toBe("10.00"); // (8.00 − 6.00) × 5
    expect(await row()).toMatchObject({ q: "5.000", v: "40.00", r: "8.0000000" });
    expect(await layers()).toEqual([]);
  });

  it("settles a partial cover pro rata and keeps the rest of the shortage provisional", async () => {
    await move(-9, 3); // first touch, provisional 3.00: -9 / -27.00
    expect(await row()).toMatchObject({ q: "-9.000", v: "-27.00" });
    const received = await move(3, 4.5);
    expect(received.valueDelta).toBe("9.00"); // 3 of 9 settled: a third of 27.00
    expect(received.shortageSettlementVariance).toBe("4.50"); // (4.50 − 3.00) × 3
    expect(await row()).toMatchObject({ q: "-6.000", v: "-18.00" });
    expect(await layers()).toEqual([[ctx.companyId, "6.000", "3.0000"]]);
    const rest = await move(10, 2);
    expect(rest.valueDelta).toBe("26.00"); // 18.00 back + 4 × 2.00
    expect(rest.shortageSettlementVariance).toBe("-6.00"); // (2.00 − 3.00) × 6
    expect(await row()).toMatchObject({ q: "4.000", v: "8.00" });
  });

  it("receives an exact value and reports no variance when nothing is short", async () => {
    const received = await db.transaction((tx) =>
      receiveInventoryAtValue(tx, {
        locationId: ctx.locationId,
        stockItemId: item,
        quantity: "3",
        value: "10.00",
        companyId: ctx.companyId,
      })
    );
    expect(received).toMatchObject({ valueDelta: "10.00", receiptValue: "10.00", shortageSettlementVariance: "0.00" });
    expect(await row()).toMatchObject({ q: "3.000", v: "10.00", r: "3.3333333" });
  });

  it("reverses exactly into shortage, with the layer under the row's company", async () => {
    await move(10, 7);
    await move(-8); // 2 / 14.00
    const reversed = await db.transaction((tx) => reverseInventoryByExactValue(tx, ctx.locationId, item, 10, "70.00"));
    expect(reversed?.valueDelta).toBe("-70.00");
    expect(await row()).toMatchObject({ q: "-8.000", v: "-56.00" });
    expect(await layers()).toEqual([[ctx.companyId, "8.000", "7.0000"]]);
  });
});

describe("short sales and covering receipts under perpetual inventory", () => {
  it("posts the provisional COGS and the settlement variance on STOCK-IN", async () => {
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by)
       VALUES ($1, '2026-01-01', '{}'::jsonb, 'test') ON CONFLICT (company_id) DO NOTHING`,
      [ctx.companyId]
    );
    await move(4, 6.25); // 4 on hand, 25.00
    const sale = await agent.post("/api/pos/sales").send({
      locationId: ctx.locationId,
      items: [{ stockItemId: item, quantity: 10, rate: 50 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: today,
    });
    expect(sale.status, JSON.stringify(sale.body)).toBeLessThan(300);
    const saleId = Number(sale.body?.voucher?.id ?? sale.body?.voucherId ?? sale.body?.id);
    // 25.00 on hand + 6 short × 6.25 = 62.50: the sale is never blocked and its COGS is posted.
    expect(await journalLines(`COGS-${saleId}`)).toEqual([
      ["COGS", "62.50", "0.00"],
      ["INVENTORY", "0.00", "62.50"],
    ]);
    expect(await row()).toMatchObject({ q: "-6.000", v: "-37.50" });

    const supplier = await pool.query<{ id: number }>(
      `INSERT INTO suppliers (company_id, code, legal_name, email, active)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}SUP`, `${TEST_PREFIX} Supplier`, "w11neg@example.test"]
    );
    const container = await pool.query<{ id: number }>(
      `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date, charges_total)
       VALUES ($1, $2, $3, 'OTW', $4, '0') RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-C1`, supplier.rows[0].id, today]
    );
    const containerId = container.rows[0].id;
    const po = await createPurchaseOrder(
      {
        companyId: ctx.companyId,
        poNumber: `${TEST_PREFIX}-PO1`,
        containerId,
        supplierId: supplier.rows[0].id,
        currency: "USD",
        status: "Open",
        itemsTotal: "70.00",
      },
      today
    );
    await pool.query(
      `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
       VALUES ($1, $2, 'line', '10', '7.00', '70.00')`,
      [po.id, item]
    );
    const offload = await agent.post(`/api/containers/${containerId}/offload`).send({
      locationId: ctx.locationId,
      offloadDate: today,
      duties: "0",
      officeCharges: "0",
      transferCharges: "0",
      transportFees: "0",
    });
    expect(offload.status, JSON.stringify(offload.body)).toBeLessThan(300);
    // 6 settled take back 37.50, 4 received at 7.00 = 28.00: the sub-ledger takes 65.50;
    // the 6 sold short cost 42.00, 4.50 more than provisionally booked.
    expect(await row()).toMatchObject({ q: "4.000", v: "28.00" });
    expect(await journalLines(`STOCK-IN-${containerId}`)).toEqual([
      ["COGS", "4.50", "0.00"],
      ["GOODS_IN_TRANSIT", "0.00", "70.00"],
      ["INVENTORY", "65.50", "0.00"],
    ]);
  }, 120_000);
});
