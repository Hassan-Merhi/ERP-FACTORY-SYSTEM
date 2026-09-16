/**
 * Container offload: landing a shipment's costs onto inventory.
 *
 * This is the calculation the whole import cycle rests on. Duties, office,
 * transfer and transport charges are spread across every bale in the container,
 * so each item's inventory rate becomes its purchase rate plus a share of the
 * charges. Two properties have to hold exactly, not approximately: the value
 * added to inventory must equal goods plus charges to the cent — the rounding
 * remainder is deliberately pushed onto the last item rather than dropped — and
 * offloading onto stock that is already there must produce a weighted average,
 * not overwrite the old rate.
 */
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { offloadContainer } from "../server/storage/containers-store/offload";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "offload";
let ctx: TestContext;
let supplierId: number;
let sequence = 0;

type InventoryRow = { quantity: string; average_rate: string; total_value: string };

async function makeContainer(chargesTotal = "0"): Promise<number> {
  sequence += 1;
  const result = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date, charges_total)
     VALUES ($1, $2, $3, 'OTW', '2026-09-01', $4) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-C${sequence}`, supplierId, chargesTotal]
  );
  return result.rows[0].id;
}

async function addPurchaseOrder(
  containerId: number,
  lines: Array<{ stockItemId: number; quantity: string; rate: string }>
): Promise<void> {
  sequence += 1;
  const po = await pool.query<{ id: number }>(
    `INSERT INTO purchase_orders (company_id, po_number, container_id, supplier_id, currency, status)
     VALUES ($1, $2, $3, $4, 'USD', 'Open') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-PO${sequence}`, containerId, supplierId]
  );
  for (const line of lines) {
    const total = new Decimal(line.quantity).times(line.rate).toFixed(2);
    await pool.query(
      `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [po.rows[0].id, line.stockItemId, `${TEST_PREFIX} line`, line.quantity, line.rate, total]
    );
  }
}

async function inventoryAt(locationId: number, stockItemId: number): Promise<InventoryRow | undefined> {
  const result = await pool.query<InventoryRow>(
    `SELECT quantity, average_rate, total_value FROM inventory
      WHERE location_id = $1 AND stock_item_id = $2`,
    [locationId, stockItemId]
  );
  return result.rows[0];
}

async function clearInventory(locationId: number): Promise<void> {
  await pool.query(`DELETE FROM inventory WHERE location_id = $1`, [locationId]);
}

async function offloadItems(
  offloadId: number
): Promise<Array<{ stock_item_id: number; quantity: string; rate: string; total_value: string }>> {
  const result = await pool.query<{ stock_item_id: number; quantity: string; rate: string; total_value: string }>(
    `SELECT stock_item_id, quantity, rate, total_value FROM container_offload_items
      WHERE offload_id = $1 ORDER BY stock_item_id`,
    [offloadId]
  );
  return result.rows;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}SUP`, `${TEST_PREFIX} Supplier`, "offload@example.test"]
  );
  supplierId = supplier.rows[0].id;
}, 120_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("landing container charges onto inventory", () => {
  it("adds each item's share of the charges to its purchase rate", async () => {
    await clearInventory(ctx.locationId);
    const containerId = await makeContainer();
    // 10 bales at 5.00 and 20 bales at 4.00: 30 bales, 130.00 of goods.
    await addPurchaseOrder(containerId, [
      { stockItemId: ctx.stockItemIds[0], quantity: "10", rate: "5.00" },
      { stockItemId: ctx.stockItemIds[1], quantity: "20", rate: "4.00" },
    ]);

    // 60.00 of charges over 30 bales is exactly 2.00 a bale.
    const offload = await offloadContainer(
      containerId,
      ctx.locationId,
      "20.00",
      null,
      "10.00",
      null,
      null,
      "10.00",
      "20.00",
      null,
      [],
      "2026-09-15"
    );

    expect(offload.containerId).toBe(containerId);
    expect(Number(offload.totalBales)).toBeCloseTo(30, 6);
    expect(Number(offload.totalCharges)).toBeCloseTo(60, 2);
    expect(Number(offload.additionalCostPerBale)).toBeCloseTo(2, 6);

    const items = await offloadItems(offload.id);
    expect(items).toHaveLength(2);
    const first = items.find((row) => row.stock_item_id === ctx.stockItemIds[0])!;
    const second = items.find((row) => row.stock_item_id === ctx.stockItemIds[1])!;
    expect(Number(first.rate)).toBeCloseTo(7, 6);
    expect(Number(first.total_value)).toBeCloseTo(70, 2);
    expect(Number(second.rate)).toBeCloseTo(6, 6);
    expect(Number(second.total_value)).toBeCloseTo(120, 2);

    // Goods 130 + charges 60 = 190 landed, to the cent.
    const landed = Number(first.total_value) + Number(second.total_value);
    expect(landed).toBeCloseTo(190, 2);

    const inventoryOne = await inventoryAt(ctx.locationId, ctx.stockItemIds[0]);
    expect(Number(inventoryOne?.quantity)).toBeCloseTo(10, 3);
    expect(Number(inventoryOne?.average_rate)).toBeCloseTo(7, 2);
    expect(Number(inventoryOne?.total_value)).toBeCloseTo(70, 2);

    const container = await pool.query<{ status: string; offload_date: string; duty_fee: string }>(
      `SELECT status, offload_date::text, duty_fee FROM containers WHERE id = $1`,
      [containerId]
    );
    expect(container.rows[0].status).toBe("OFFLOADED");
    expect(container.rows[0].offload_date).toBe("2026-09-15");
    expect(Number(container.rows[0].duty_fee)).toBeCloseTo(20, 2);
  }, 180_000);

  it("keeps the landed total exact when the per-bale share does not divide evenly", async () => {
    await clearInventory(ctx.locationId);
    const containerId = await makeContainer();
    // 3 bales of one item and 4 of another: 7 bales.
    await addPurchaseOrder(containerId, [
      { stockItemId: ctx.stockItemIds[0], quantity: "3", rate: "10.00" },
      { stockItemId: ctx.stockItemIds[1], quantity: "4", rate: "10.00" },
    ]);

    // 100.00 over 7 bales does not divide evenly.
    const offload = await offloadContainer(
      containerId,
      ctx.locationId,
      "100.00",
      null,
      "0",
      null,
      null,
      "0",
      "0",
      null,
      [],
      "2026-09-15"
    );

    const items = await offloadItems(offload.id);
    const landed = items.reduce((sum, row) => sum + Number(row.total_value), 0);
    // Goods 70.00 + charges 100.00, with the remainder carried rather than lost.
    expect(landed).toBeCloseTo(170, 2);

    const inventoryTotal = (
      await Promise.all(items.map((row) => inventoryAt(ctx.locationId, row.stock_item_id)))
    ).reduce((sum, row) => sum + Number(row?.total_value ?? 0), 0);
    expect(inventoryTotal).toBeCloseTo(170, 2);
  }, 180_000);

  it("weights the average against stock already on hand instead of replacing it", async () => {
    await clearInventory(ctx.locationId);
    // 10 bales already held at 4.00 = 40.00.
    await pool.query(
      `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
       VALUES ($1, $2, $3, '10', '4.00', '40.00')`,
      [ctx.companyId, ctx.locationId, ctx.stockItemIds[0]]
    );

    const containerId = await makeContainer();
    // 10 more bales at 8.00, with 20.00 of charges over those 10 = 10.00 a bale.
    await addPurchaseOrder(containerId, [{ stockItemId: ctx.stockItemIds[0], quantity: "10", rate: "8.00" }]);

    await offloadContainer(
      containerId,
      ctx.locationId,
      "20.00",
      null,
      "0",
      null,
      null,
      "0",
      "0",
      null,
      [],
      "2026-09-15"
    );

    const inventory = await inventoryAt(ctx.locationId, ctx.stockItemIds[0]);
    // 40.00 held + 100.00 landed over 20 bales = 7.00 a bale.
    expect(Number(inventory?.quantity)).toBeCloseTo(20, 3);
    expect(Number(inventory?.total_value)).toBeCloseTo(140, 2);
    expect(Number(inventory?.average_rate)).toBeCloseTo(7, 2);
  }, 180_000);

  it("carries the charges the container already recorded into the offload total", async () => {
    await clearInventory(ctx.locationId);
    // Charges booked against the container before it was offloaded.
    const containerId = await makeContainer("30.00");
    await addPurchaseOrder(containerId, [{ stockItemId: ctx.stockItemIds[0], quantity: "10", rate: "1.00" }]);

    const offload = await offloadContainer(
      containerId,
      ctx.locationId,
      "10.00",
      null,
      "0",
      null,
      null,
      "0",
      "0",
      null,
      [],
      "2026-09-15"
    );

    // 10.00 of duties plus the 30.00 already on the container.
    expect(Number(offload.totalCharges)).toBeCloseTo(40, 2);
    expect(Number(offload.additionalCostPerBale)).toBeCloseTo(4, 6);

    const inventory = await inventoryAt(ctx.locationId, ctx.stockItemIds[0]);
    expect(Number(inventory?.total_value)).toBeCloseTo(50, 2);
  }, 180_000);

  it("spreads named additional charges over the bales as well", async () => {
    await clearInventory(ctx.locationId);
    const containerId = await makeContainer();
    await addPurchaseOrder(containerId, [{ stockItemId: ctx.stockItemIds[0], quantity: "10", rate: "2.00" }]);

    const offload = await offloadContainer(
      containerId,
      ctx.locationId,
      "0",
      null,
      "0",
      null,
      null,
      "0",
      "0",
      null,
      [
        { description: "Inspection", amount: 30, ledgerAccountId: ctx.cashAccountId },
        { description: "Storage", amount: 20, ledgerAccountId: ctx.cashAccountId },
      ],
      "2026-09-15"
    );

    expect(Number(offload.totalCharges)).toBeCloseTo(50, 2);
    expect(Number(offload.additionalCostPerBale)).toBeCloseTo(5, 6);

    const inventory = await inventoryAt(ctx.locationId, ctx.stockItemIds[0]);
    expect(Number(inventory?.average_rate)).toBeCloseTo(7, 2);
    expect(Number(inventory?.total_value)).toBeCloseTo(70, 2);
  }, 180_000);

  it("restates stock already on hand at a corrected rate before landing the new bales", async () => {
    await clearInventory(ctx.locationId);
    // 10 bales carried at a rate that is known to be wrong.
    await pool.query(
      `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
       VALUES ($1, $2, $3, '10', '99.00', '990.00')`,
      [ctx.companyId, ctx.locationId, ctx.stockItemIds[0]]
    );

    const containerId = await makeContainer();
    await addPurchaseOrder(containerId, [{ stockItemId: ctx.stockItemIds[0], quantity: "10", rate: "5.00" }]);

    await offloadContainer(containerId, ctx.locationId, "0", null, "0", null, null, "0", "0", null, [], "2026-09-15", [
      { stockItemId: ctx.stockItemIds[0], correctRate: 3 },
    ]);

    const inventory = await inventoryAt(ctx.locationId, ctx.stockItemIds[0]);
    // The 10 held bales are restated to 3.00 (30.00) before the 10 new ones
    // land at 5.00 (50.00): 20 bales worth 80.00, so 4.00 a bale.
    expect(Number(inventory?.quantity)).toBeCloseTo(20, 3);
    expect(Number(inventory?.total_value)).toBeCloseTo(80, 2);
    expect(Number(inventory?.average_rate)).toBeCloseTo(4, 2);
  }, 180_000);

  it("ignores a correction that names an item the container does not carry or a rate of zero", async () => {
    await clearInventory(ctx.locationId);
    await pool.query(
      `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
       VALUES ($1, $2, $3, '5', '9.00', '45.00'), ($1, $2, $4, '5', '9.00', '45.00')`,
      [ctx.companyId, ctx.locationId, ctx.stockItemIds[0], ctx.stockItemIds[2]]
    );

    const containerId = await makeContainer();
    await addPurchaseOrder(containerId, [{ stockItemId: ctx.stockItemIds[0], quantity: "5", rate: "1.00" }]);

    await offloadContainer(containerId, ctx.locationId, "0", null, "0", null, null, "0", "0", null, [], "2026-09-15", [
      // Item 3 is not on this container, so its rate must not be touched.
      { stockItemId: ctx.stockItemIds[2], correctRate: 1 },
      // A zero rate is not a correction.
      { stockItemId: ctx.stockItemIds[0], correctRate: 0 },
    ]);

    const untouched = await inventoryAt(ctx.locationId, ctx.stockItemIds[2]);
    expect(Number(untouched?.average_rate)).toBeCloseTo(9, 2);
    expect(Number(untouched?.total_value)).toBeCloseTo(45, 2);

    const landed = await inventoryAt(ctx.locationId, ctx.stockItemIds[0]);
    // The zero correction was ignored, so the held 45.00 stands and 5.00 lands.
    expect(Number(landed?.total_value)).toBeCloseTo(50, 2);
  }, 180_000);
});

describe("offload accounting", () => {
  it("posts a balanced voucher for the charges it spreads", async () => {
    await clearInventory(ctx.locationId);
    const containerId = await makeContainer();
    await addPurchaseOrder(containerId, [{ stockItemId: ctx.stockItemIds[0], quantity: "10", rate: "1.00" }]);

    await offloadContainer(
      containerId,
      ctx.locationId,
      "25.00",
      null,
      "15.00",
      null,
      null,
      "0",
      "10.00",
      null,
      [],
      "2026-09-15"
    );

    // Whatever vouchers the offload raised, each one has to balance.
    const unbalanced = await pool.query<{ voucher_id: number; net: string }>(
      `SELECT ve.voucher_id,
              SUM(COALESCE(ve.debit_amount,0)::numeric - COALESCE(ve.credit_amount,0)::numeric)::text AS net
         FROM voucher_entries ve
         JOIN vouchers v ON v.id = ve.voucher_id
        WHERE v.company_id = $1 AND v.voucher_date = '2026-09-15'
        GROUP BY ve.voucher_id
       HAVING ABS(SUM(COALESCE(ve.debit_amount,0)::numeric - COALESCE(ve.credit_amount,0)::numeric)) > 0.005`,
      [ctx.companyId]
    );
    expect(unbalanced.rows).toEqual([]);
  }, 180_000);
});

describe("offload accounting against named accounts", () => {
  it("posts each charge against the account it was given", async () => {
    await clearInventory(ctx.locationId);
    const containerId = await makeContainer();
    await addPurchaseOrder(containerId, [{ stockItemId: ctx.stockItemIds[0], quantity: "10", rate: "1.00" }]);

    const offload = await offloadContainer(
      containerId,
      ctx.locationId,
      "25.00",
      ctx.cashAccountId,
      "15.00",
      ctx.cashAccountId,
      ctx.cashAccountId,
      "5.00",
      "10.00",
      ctx.cashAccountId,
      [{ description: "Inspection", amount: 5, ledgerAccountId: ctx.cashAccountId }],
      "2026-09-16"
    );

    expect(Number(offload.totalCharges)).toBeCloseTo(60, 2);

    const posted = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM vouchers WHERE company_id = $1 AND voucher_date = '2026-09-16'`,
      [ctx.companyId]
    );
    expect(Number(posted.rows[0].count)).toBeGreaterThan(0);

    const unbalanced = await pool.query(
      `SELECT ve.voucher_id
         FROM voucher_entries ve
         JOIN vouchers v ON v.id = ve.voucher_id
        WHERE v.company_id = $1 AND v.voucher_date = '2026-09-16'
        GROUP BY ve.voucher_id
       HAVING ABS(SUM(COALESCE(ve.debit_amount,0)::numeric - COALESCE(ve.credit_amount,0)::numeric)) > 0.005`,
      [ctx.companyId]
    );
    expect(unbalanced.rows).toEqual([]);
  }, 180_000);

  it("refuses to book office charges against an income account", async () => {
    await clearInventory(ctx.locationId);
    const containerId = await makeContainer();
    await addPurchaseOrder(containerId, [{ stockItemId: ctx.stockItemIds[0], quantity: "10", rate: "1.00" }]);

    // Office charges are capitalised into stock, so the account they sit on has
    // to be an asset; an income account would invert the entry.
    await expect(
      offloadContainer(
        containerId,
        ctx.locationId,
        "0",
        null,
        "15.00",
        ctx.salesAccountId,
        ctx.cashAccountId,
        "0",
        "0",
        null,
        [],
        "2026-09-16"
      )
    ).rejects.toThrow(/invalid/i);

    // The container is still open, because the whole offload is one transaction.
    const container = await pool.query<{ status: string }>(`SELECT status FROM containers WHERE id = $1`, [
      containerId,
    ]);
    expect(container.rows[0].status).toBe("OTW");
  }, 180_000);
});

describe("offload refusals", () => {
  it("will not offload a container that does not exist", async () => {
    await expect(
      offloadContainer(2147481900, ctx.locationId, "0", null, "0", null, null, "0", "0", null, [], "2026-09-15")
    ).rejects.toThrow(/not found/i);
  }, 60_000);

  it("will not offload into a location that does not exist", async () => {
    const containerId = await makeContainer();
    await addPurchaseOrder(containerId, [{ stockItemId: ctx.stockItemIds[0], quantity: "1", rate: "1.00" }]);

    await expect(
      offloadContainer(containerId, 2147481900, "0", null, "0", null, null, "0", "0", null, [], "2026-09-15")
    ).rejects.toThrow(/not found/i);
  }, 120_000);
});
