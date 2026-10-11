/**
 * ERP purchases under perpetual inventory (wave 8.2).
 *
 * Once a company's cut-over is applied, a purchase order's voucher cost moves
 * to Goods in Transit (GIT-PO-{po}), and the container's offload moves the
 * landed value into Inventory (STOCK-IN-{container}): Dr Inventory for what the
 * stock sub-ledger received, Cr Goods in Transit for the POs in transit, Cr
 * each account the offload charge vouchers debited, the difference to
 * Purchases. Reversing the offload removes the stock-in journal. Before the cut-over nothing is posted, and the
 * opening plan carries POs that were still in transit at the cut-over.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { planOpeningInventoryJournal } from "../server/services/accounting/perpetualInventory/openingJournal";
import { createPurchaseOrder } from "../server/storage/containers-store/purchase-orders";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "pistock";
const today = new Date().toISOString().slice(0, 10);

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let sequence = 0;

/** A journal's lines; STOCK-IN-{container} reads its per-offload journals (wave 17 B). */
async function journalLines(voucherNumber: string) {
  const { rows } = await pool.query(
    `SELECT la.code, ve.debit_amount::text AS d, ve.credit_amount::text AS c
       FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE v.company_id = $1 AND v.deleted_at IS NULL
        AND (v.voucher_number = $2 OR ($2 LIKE 'STOCK-IN-%' AND v.voucher_number LIKE $2 || '-%')) ORDER BY ve.id`,
    [ctx.companyId, voucherNumber]
  );
  return rows.map((row) => [row.code, row.d, row.c]);
}

/** A container with one PO of 10 bales at 5.00 and 20 at 4.00 (130.00), its voucher dated `poDate`. */
async function containerWithPurchaseOrder(poDate: string) {
  sequence += 1;
  const container = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date, charges_total)
     VALUES ($1, $2, $3, 'OTW', $4, '0') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-C${sequence}`, supplierId, poDate]
  );
  const containerId = container.rows[0].id;
  const po = await createPurchaseOrder(
    {
      companyId: ctx.companyId,
      poNumber: `${TEST_PREFIX}-PO${sequence}`,
      containerId,
      supplierId,
      currency: "USD",
      status: "Open",
      itemsTotal: "130.00",
    },
    poDate
  );
  const [itemA, itemB] = ctx.stockItemIds;
  await pool.query(
    `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
     VALUES ($1, $2, 'line', '10', '5.00', '50.00'), ($1, $3, 'line', '20', '4.00', '80.00')`,
    [po.id, itemA, itemB]
  );
  return { containerId, poId: po.id };
}

async function offload(containerId: number) {
  // Duties 30 over 30 bales: landed value 130 + 30 = 160.
  const res = await agent.post(`/api/containers/${containerId}/offload`).send({
    locationId: ctx.locationId,
    offloadDate: today,
    duties: "30.00",
    dutiesAccountId: ctx.cashAccountId,
    officeCharges: "0",
    transferCharges: "0",
    transportFees: "0",
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}SUP`, `${TEST_PREFIX} Supplier`, "pistock@example.test"]
  );
  supplierId = supplier.rows[0].id;
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("ERP purchases under perpetual inventory", () => {
  it("posts nothing before the company's cut-over is applied", async () => {
    await pool.query(`DELETE FROM inventory WHERE location_id = $1`, [ctx.locationId]);
    const { containerId, poId } = await containerWithPurchaseOrder(today);
    await offload(containerId);
    expect(await journalLines(`GIT-PO-${poId}`)).toEqual([]);
    expect(await journalLines(`STOCK-IN-${containerId}`)).toEqual([]);
  }, 120_000);

  it("moves the PO cost to goods in transit and the offload's landed value into inventory", async () => {
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by) VALUES ($1, $2, '{}'::jsonb, 'test')`,
      [ctx.companyId, today]
    );
    await pool.query(`DELETE FROM inventory WHERE location_id = $1`, [ctx.locationId]);

    const { containerId, poId } = await containerWithPurchaseOrder(today);
    expect(await journalLines(`GIT-PO-${poId}`)).toEqual([
      ["GOODS_IN_TRANSIT", "130.00", "0.00"],
      ["PURCHASES", "0.00", "130.00"],
    ]);

    // An optional PO voucher is not in transit; activating it posts it again.
    const { rows } = await pool.query(`SELECT voucher_id FROM purchase_orders WHERE id = $1`, [poId]);
    const poVoucherId = rows[0].voucher_id;
    expect((await agent.patch(`/api/vouchers/${poVoucherId}/optional`).send({ optional: true })).status).toBe(200);
    expect(await journalLines(`GIT-PO-${poId}`)).toEqual([]);
    expect((await agent.patch(`/api/vouchers/${poVoucherId}/optional`).send({ optional: false })).status).toBe(200);
    expect(await journalLines(`GIT-PO-${poId}`)).toHaveLength(2);

    await offload(containerId);
    expect(await journalLines(`STOCK-IN-${containerId}`)).toEqual([
      ["INVENTORY", "160.00", "0.00"],
      ["GOODS_IN_TRANSIT", "0.00", "130.00"],
      ["DUTIES", "0.00", "30.00"],
    ]);

    // Reversing the offload: nothing is received any more.
    const reversed = await agent.post(`/api/containers/${containerId}/reverse-offload`).send({});
    expect(reversed.status, JSON.stringify(reversed.body)).toBeLessThan(300);
    expect(await journalLines(`STOCK-IN-${containerId}`)).toEqual([]);
    expect(await journalLines(`GIT-PO-${poId}`)).toHaveLength(2);

    // Offloading again posts it again.
    await offload(containerId);
    expect(await journalLines(`STOCK-IN-${containerId}`)).toHaveLength(3);
  }, 180_000);

  it("relieves a PO dated before the cut-over from the opening goods in transit", async () => {
    await pool.query(`DELETE FROM inventory WHERE location_id = $1`, [ctx.locationId]);
    const { containerId, poId } = await containerWithPurchaseOrder("2020-01-10");
    // Dated before the cut-over: carried by the opening journal, not its own GIT journal.
    expect(await journalLines(`GIT-PO-${poId}`)).toEqual([]);

    const plan = await planOpeningInventoryJournal(ctx.companyId, today);
    const git = plan.lines.find((line) => line.accountCode === "GOODS_IN_TRANSIT");
    expect(git?.amount).toBe("130.00");

    await offload(containerId);
    expect(await journalLines(`STOCK-IN-${containerId}`)).toEqual([
      ["INVENTORY", "160.00", "0.00"],
      ["GOODS_IN_TRANSIT", "0.00", "130.00"],
      ["DUTIES", "0.00", "30.00"],
    ]);
  }, 180_000);
});
