/**
 * Concurrency coverage for the canonical container offload lifecycle.
 *
 * An offload is the largest single stock-in the ERP performs and it posts the
 * duty/office/transport charge vouchers and the Supplier Partner journals along
 * with it. `container_offloads` has no unique key on container_id, so the only
 * thing standing between a double-submit and two offload records — the stock
 * received twice and the charge vouchers posted twice — is the lifecycle's own
 * serialization on the container row.
 *
 * Both requests are started together and the assertions are on the committed
 * totals: one offload record, one offload line, and inventory that received the
 * container's quantity once.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";
import { pool } from "../server/db";
import { executeContainerOffloadLifecycle } from "../server/services/containers/offload-lifecycle/execute";
import type { ContainerOffloadLifecycleInput } from "../server/services/containers/offload-lifecycle/types";

const TEST_PREFIX = "offconc";
const OFFLOAD_QTY = "10.000";
const OFFLOAD_RATE = "7.00";
const STARTING_QTY = 100;

let ctx: TestContext;
let supplierId: number;

async function createContainerWithPurchaseOrder(): Promise<number> {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const { rows: containerRows } = await pool.query(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date)
     VALUES ($1, $2, $3, 'OTW', CURRENT_DATE)
     RETURNING id`,
    [ctx.companyId, `CN-${suffix}`.slice(0, 30), supplierId]
  );
  const containerId = Number(containerRows[0].id);

  const { rows: poRows } = await pool.query(
    `INSERT INTO purchase_orders (company_id, po_number, container_id, supplier_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [ctx.companyId, `PO-${suffix}`.slice(0, 30), containerId, supplierId]
  );

  await pool.query(
    `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
     VALUES ($1, $2, 'offload line', $3, $4, $5)`,
    [
      Number(poRows[0].id),
      ctx.stockItemIds[0],
      OFFLOAD_QTY,
      OFFLOAD_RATE,
      (Number(OFFLOAD_QTY) * Number(OFFLOAD_RATE)).toFixed(2),
    ]
  );

  return containerId;
}

function offloadInput(containerId: number): ContainerOffloadLifecycleInput {
  return {
    companyId: ctx.companyId,
    containerId,
    mode: "create-or-replace",
    locationId: ctx.locationId,
    offloadDate: new Date().toISOString().split("T")[0],
    duties: "0",
    officeCharges: "0",
    transferCharges: "0",
    transportFees: "0",
  };
}

async function inventoryQuantity(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT quantity FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
    [ctx.companyId, ctx.locationId, ctx.stockItemIds[0]]
  );
  return Number(rows[0]?.quantity ?? 0);
}

async function resetInventory(): Promise<void> {
  await pool.query(
    `UPDATE inventory SET quantity = $1, average_rate = '10.00', total_value = $2
     WHERE company_id = $3 AND location_id = $4 AND stock_item_id = $5`,
    [`${STARTING_QTY}.000`, `${STARTING_QTY * 10}.00`, ctx.companyId, ctx.locationId, ctx.stockItemIds[0]]
  );
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  const { rows } = await pool.query(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      ctx.companyId,
      `${TEST_PREFIX}SUP`.slice(0, 20).toUpperCase(),
      `${TEST_PREFIX}_supplier`,
      `${TEST_PREFIX}@example.test`,
    ]
  );
  supplierId = Number(rows[0].id);
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM canonical_stock_movement_audit WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM canonical_stock_movement_requests WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM canonical_stock_movements WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM po_line_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)`, [
    ctx.companyId,
  ]);
  await pool.query(`DELETE FROM purchase_orders WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("container offload concurrency", () => {
  it("receives the container's stock once when two offloads race", async () => {
    await resetInventory();
    const containerId = await createContainerWithPurchaseOrder();

    const settled = await Promise.allSettled([
      executeContainerOffloadLifecycle(offloadInput(containerId)),
      executeContainerOffloadLifecycle(offloadInput(containerId)),
    ]);

    const succeeded = settled.filter((entry) => entry.status === "fulfilled");
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    const { rows: offloads } = await pool.query(
      `SELECT id FROM container_offloads WHERE container_id = $1 ORDER BY id`,
      [containerId]
    );
    expect(offloads).toHaveLength(1);

    const { rows: offloadItems } = await pool.query(`SELECT id FROM container_offload_items WHERE offload_id = $1`, [
      Number(offloads[0].id),
    ]);
    expect(offloadItems).toHaveLength(1);

    // The container's 10 units landed once. A duplicated offload would show 120;
    // a replace that reversed correctly still shows 110.
    expect(await inventoryQuantity()).toBeCloseTo(STARTING_QTY + Number(OFFLOAD_QTY), 3);

    const { rows: containerRows } = await pool.query(`SELECT status FROM containers WHERE id = $1`, [containerId]);
    expect(containerRows[0].status).toBe("OFFLOADED");
  }, 120000);

  it("does not duplicate charge vouchers when two offloads race", async () => {
    await resetInventory();
    const containerId = await createContainerWithPurchaseOrder();

    const settled = await Promise.allSettled([
      executeContainerOffloadLifecycle({
        ...offloadInput(containerId),
        duties: "120.00",
        dutiesAccountId: ctx.salesAccountId,
      }),
      executeContainerOffloadLifecycle({
        ...offloadInput(containerId),
        duties: "120.00",
        dutiesAccountId: ctx.salesAccountId,
      }),
    ]);
    expect(settled.filter((entry) => entry.status === "fulfilled").length).toBeGreaterThanOrEqual(1);

    const { rows: offloads } = await pool.query(`SELECT id FROM container_offloads WHERE container_id = $1`, [
      containerId,
    ]);
    expect(offloads).toHaveLength(1);

    const { rows: dutyVouchers } = await pool.query(
      `SELECT v.id, v.total_amount
       FROM vouchers v
       WHERE v.company_id = $1
         AND v.voucher_number LIKE 'DUTY-%'
         AND v.deleted_at IS NULL`,
      [ctx.companyId]
    );
    // One live duty voucher for one offload, whatever the retry did.
    expect(dutyVouchers).toHaveLength(1);
    expect(Number(dutyVouchers[0].total_amount)).toBeCloseTo(120, 2);

    const { rows: voucherBalance } = await pool.query(
      `SELECT COALESCE(SUM(ve.debit_amount::numeric), 0) AS debit,
              COALESCE(SUM(ve.credit_amount::numeric), 0) AS credit
       FROM voucher_entries ve
       WHERE ve.voucher_id = $1`,
      [Number(dutyVouchers[0].id)]
    );
    expect(Number(voucherBalance[0].debit)).toBeCloseTo(Number(voucherBalance[0].credit), 2);
  }, 120000);
});
