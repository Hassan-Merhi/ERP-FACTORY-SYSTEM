/**
 * Wave 11 (inventory fidelity), agent A: offload fidelity and the perpetual
 * reconciliation.
 *
 * One mixed scenario under perpetual inventory, checked line by line and then
 * reconciled (ledger INVENTORY = stock sub-ledger, to the cent):
 *
 *   1. container 1 offloaded two days ago: 10 A at 5.00 and 20 B at 4.00 with
 *      30.00 duties (landed 60.00 + 100.00);
 *   2. a POS sale of 15 A today, 5 more than on hand: COGS at the provisional
 *      cost (60.00 + 5 × 6.00), the A row goes to -5 holding -30.00;
 *      the reconciliation as of yesterday (replayed) and today are both zero;
 *   3. container 2 offloaded today: 10 A at 8.00 settles the shortage (the
 *      sub-ledger takes back 30.00, the 10.00 price difference goes to COGS on
 *      STOCK-IN), 4 B at 6.00, and a cost correction of the 20 B on hand to
 *      5.50 (+10.00 to Inventory Revaluation, INV-MOVE);
 *   4. a partial sale of B, then the duty voucher of container 1 is edited
 *      30 → 60: the bales still on hand take their share into inventory, the
 *      sold share goes to COGS on STOCK-IN;
 *   5. suspending and restoring container 2 receives each line again at its
 *      stored value (not its 2dp rate); reversing container 2 takes back
 *      exactly what it moved;
 *   and the reconciliation is zero after every step.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { reconcilePerpetualInventory } from "../server/services/accounting/perpetualInventory/reconciliation";
import { companyStockValuation } from "../server/services/inventory/stockValuation";
import { createPurchaseOrder } from "../server/storage/containers-store/purchase-orders";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w11off";
const day = (offset: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const today = day(0);
const yesterday = day(-1);
const twoDaysAgo = day(-2);

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let itemA: number;
let itemB: number;
let itemC: number;
let sequence = 0;

/** A journal's lines; STOCK-IN-{container} reads its per-offload journals (wave 17 B). */
async function journalLines(voucherNumber: string) {
  const { rows } = await pool.query(
    `SELECT la.code, ve.debit_amount::text AS d, ve.credit_amount::text AS c
       FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE v.company_id = $1 AND v.deleted_at IS NULL
        AND (v.voucher_number = $2 OR ($2 LIKE 'STOCK-IN-%' AND v.voucher_number LIKE $2 || '-%')) ORDER BY la.code, ve.id`,
    [ctx.companyId, voucherNumber]
  );
  return rows.map((row) => [row.code, row.d, row.c]);
}

async function stock(stockItemId: number) {
  const { rows } = await pool.query(
    `SELECT quantity::text AS q, total_value::text AS v FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
    [ctx.locationId, stockItemId]
  );
  return rows[0] ? [rows[0].q, rows[0].v] : null;
}

async function inventoryDifference(asOf = today) {
  const reconciliation = await reconcilePerpetualInventory(db, ctx.companyId, asOf);
  const line = (code: string) => reconciliation.lines.find((candidate) => candidate.accountCode === code)!;
  return {
    inventory: line("INVENTORY"),
    goodsInTransit: line("GOODS_IN_TRANSIT"),
  };
}

async function expectReconciled(asOf = today) {
  const { inventory, goodsInTransit } = await inventoryDifference(asOf);
  expect(inventory.difference, `${asOf} ${JSON.stringify(inventory)}`).toBe("0.00");
  expect(goodsInTransit.difference, `${asOf} ${JSON.stringify(goodsInTransit)}`).toBe("0.00");
  return inventory;
}

async function container(lines: Array<[number, string, string]>, date: string) {
  sequence += 1;
  const containerNumber = `${TEST_PREFIX}-C${sequence}`;
  const created = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date, charges_total)
     VALUES ($1, $2, $3, 'OTW', $4, '0') RETURNING id`,
    [ctx.companyId, containerNumber, supplierId, date]
  );
  const containerId = created.rows[0].id;
  const total = lines.reduce((sum, [, quantity, rate]) => sum + Number(quantity) * Number(rate), 0);
  const po = await createPurchaseOrder(
    {
      companyId: ctx.companyId,
      poNumber: `${TEST_PREFIX}-PO${sequence}`,
      containerId,
      supplierId,
      currency: "USD",
      status: "Open",
      itemsTotal: total.toFixed(2),
    },
    date
  );
  for (const [stockItemId, quantity, rate] of lines) {
    await pool.query(
      `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
       VALUES ($1, $2, 'line', $3, $4, $5)`,
      [po.id, stockItemId, quantity, rate, (Number(quantity) * Number(rate)).toFixed(2)]
    );
  }
  return { containerId, containerNumber };
}

async function offload(
  containerId: number,
  date: string,
  duties: string,
  inventoryCostCorrections: Array<{ stockItemId: number; correctRate: number }> = []
) {
  const res = await agent.post(`/api/containers/${containerId}/offload`).send({
    locationId: ctx.locationId,
    offloadDate: date,
    duties,
    dutiesAccountId: ctx.cashAccountId,
    officeCharges: "0",
    transferCharges: "0",
    transportFees: "0",
    inventoryCostCorrections,
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body as { id: number };
}

async function sell(stockItemId: number, quantity: number) {
  const res = await agent.post("/api/pos/sales").send({
    locationId: ctx.locationId,
    items: [{ stockItemId, quantity, rate: 50 }],
    paymentAccountType: "ledger",
    paymentAccountId: ctx.cashAccountId,
    voucherDate: today,
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return Number(res.body?.voucher?.id ?? res.body?.voucherId ?? res.body?.id);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  [itemA, itemB, itemC] = ctx.stockItemIds;
  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}SUP`, `${TEST_PREFIX} Supplier`, "w11off@example.test"]
  );
  supplierId = supplier.rows[0].id;
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  await pool.query(`DELETE FROM inventory WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM inventory_negative_layers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(
    `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by)
     VALUES ($1, '2026-01-01', '{}'::jsonb, 'test')`,
    [ctx.companyId]
  );
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM inventory_negative_layers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("offload fidelity under perpetual inventory", () => {
  let c1: { containerId: number; containerNumber: string };
  let c2: { containerId: number; containerNumber: string };
  let c2Offload: { id: number };

  it("starts reconciled", async () => {
    expect((await expectReconciled()).subLedger).toBe("0.00");
  });

  it("receives container 1 at its landed value", async () => {
    c1 = await container(
      [
        [itemA, "10", "5.00"],
        [itemB, "20", "4.00"],
      ],
      twoDaysAgo
    );
    await offload(c1.containerId, twoDaysAgo, "30.00");
    expect(await stock(itemA)).toEqual(["10.000", "60.00"]);
    expect(await stock(itemB)).toEqual(["20.000", "100.00"]);
    expect(await journalLines(`STOCK-IN-${c1.containerId}`)).toEqual([
      ["DUTIES", "0.00", "30.00"],
      ["GOODS_IN_TRANSIT", "0.00", "130.00"],
      ["INVENTORY", "160.00", "0.00"],
    ]);
    await expectReconciled();
  }, 120_000);

  it("posts a short sale at the provisional cost and reconciles today and as of yesterday", async () => {
    const saleId = await sell(itemA, 15);
    // 10 on hand at 6.00 relieved in full, 5 short at the cost memory 6.00.
    expect(await journalLines(`COGS-${saleId}`)).toEqual([
      ["COGS", "90.00", "0.00"],
      ["INVENTORY", "0.00", "90.00"],
    ]);
    expect(await stock(itemA)).toEqual(["-5.000", "-30.00"]);
    const valuation = await companyStockValuation(db, ctx.companyId);
    expect(valuation.total).toBe("100.00"); // negative stock does not subtract
    expect(valuation.excluded.shortageValue).toBe("-30.00");
    expect(valuation.subLedgerTotal).toBe("70.00");
    expect((await expectReconciled()).subLedger).toBe("70.00");
    // As of yesterday the sale is replayed away: 160.00 on both sides.
    expect((await expectReconciled(yesterday)).subLedger).toBe("160.00");
  }, 120_000);

  it("settles the shortage on the covering receipt and posts the variance and the cost correction", async () => {
    c2 = await container(
      [
        [itemA, "10", "8.00"],
        [itemB, "4", "6.00"],
        [itemC, "5", "2.00"],
      ],
      today
    );
    c2Offload = await offload(c2.containerId, today, "0", [{ stockItemId: itemB, correctRate: 5.5 }]);
    // A: -5 / -30.00 + 10 at 8.00: the 5 settled take back 30.00, the other 5 come in at 40.00.
    expect(await stock(itemA)).toEqual(["5.000", "40.00"]);
    // B: corrected to 20 × 5.50 = 110.00, then 4 at 6.00.
    expect(await stock(itemB)).toEqual(["24.000", "134.00"]);
    expect(await journalLines(`STOCK-IN-${c2.containerId}`)).toEqual([
      ["COGS", "10.00", "0.00"],
      ["GOODS_IN_TRANSIT", "0.00", "114.00"],
      ["INVENTORY", "104.00", "0.00"],
    ]);
    const { rows } = await pool.query(
      `SELECT stock_item_id, total_value::text AS t, value_moved::text AS m, cogs_variance::text AS c
         FROM container_offload_items WHERE offload_id = $1 ORDER BY stock_item_id`,
      [c2Offload.id]
    );
    expect(rows.find((row) => row.stock_item_id === itemA)).toMatchObject({ t: "80.00", m: "70.00", c: "10.00" });
    expect(await journalLines(`INV-MOVE-${ctx.companyId}-offload-cost-correction-${c2Offload.id}`)).toEqual([
      ["INVENTORY", "10.00", "0.00"],
      ["INVENTORY_REVALUATION", "0.00", "10.00"],
    ]);
    await expectReconciled();
  }, 120_000);

  it("re-prices a charge after a partial sale: on-hand share to inventory, sold share to COGS", async () => {
    await sell(itemB, 10); // 14 B left
    const before = await stock(itemB);
    const { rows: duty } = await pool.query(
      `SELECT id, voucher_date::text AS voucher_date FROM vouchers
        WHERE company_id = $1 AND voucher_number LIKE $2 AND deleted_at IS NULL`,
      [ctx.companyId, `DUTY-${c1.containerNumber}-%`]
    );
    expect(duty).toHaveLength(1);
    const { rows: entries } = await pool.query(
      `SELECT ledger_account_id, debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
      [duty[0].id]
    );
    const edit = await agent.put(`/api/vouchers/${duty[0].id}/with-entries`).send({
      voucher: {
        voucherType: "Payment",
        voucherDate: duty[0].voucher_date,
        description: `Duties for container ${c1.containerNumber}`,
      },
      entries: entries.map((entry) => ({
        ledgerAccountId: entry.ledger_account_id,
        debitAmount: Number(entry.debit_amount) > 0 ? "60.00" : "0",
        creditAmount: Number(entry.credit_amount) > 0 ? "60.00" : "0",
      })),
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    // +30.00 over 30 bales: A +10.00 (5 of its 10 still on hand: +5.00),
    // B +20.00 (14 of its 20 on hand: +14.00).
    expect(await stock(itemA)).toEqual(["5.000", "45.00"]);
    expect(await stock(itemB)).toEqual(["14.000", (Number(before![1]) + 14).toFixed(2)]);
    expect(await journalLines(`STOCK-IN-${c1.containerId}`)).toEqual([
      ["COGS", "11.00", "0.00"],
      ["DUTIES", "0.00", "60.00"],
      ["GOODS_IN_TRANSIT", "0.00", "130.00"],
      ["INVENTORY", "179.00", "0.00"],
    ]);
    await expectReconciled();
  }, 120_000);

  it("suspends and restores an offload exactly, and reverses it exactly", async () => {
    const before = await Promise.all([stock(itemA), stock(itemB), stock(itemC)]);
    const suspend = await agent.post(`/api/offloads/${c2Offload.id}/toggle-optional`).send({ requestedOptional: true });
    expect(suspend.status, JSON.stringify(suspend.body)).toBeLessThan(300);
    expect(await journalLines(`STOCK-IN-${c2.containerId}`)).toEqual([]);
    await expectReconciled();
    const restore = await agent
      .post(`/api/offloads/${c2Offload.id}/toggle-optional`)
      .send({ requestedOptional: false });
    expect(restore.status, JSON.stringify(restore.body)).toBeLessThan(300);
    // B and C come back exactly as they were: the restore receives each line at
    // its stored value, not its 2dp rate.
    expect(await Promise.all([stock(itemB), stock(itemC)])).toEqual(before.slice(1));
    // A went short while suspended (holding -25.00: the shortage it had, with
    // the +5.00 charge re-pricing its container-1 bales took). The restore
    // settles that shortage again: it takes back 25.00 and the other 5 bales
    // come in at 40.00, the 15.00 difference going to COGS on STOCK-IN.
    expect(await stock(itemA)).toEqual(["5.000", "40.00"]);
    expect(before[0]).toEqual(["5.000", "45.00"]);
    expect(await journalLines(`STOCK-IN-${c2.containerId}`)).toEqual([
      ["COGS", "15.00", "0.00"],
      ["GOODS_IN_TRANSIT", "0.00", "114.00"],
      ["INVENTORY", "99.00", "0.00"],
    ]);
    await expectReconciled();

    const reversed = await agent.post(`/api/containers/${c2.containerId}/reverse-offload`).send({});
    expect(reversed.status, JSON.stringify(reversed.body)).toBeLessThan(300);
    // A goes back short: 5 / 40.00 less the 10 / 65.00 the restored receipt moved.
    expect(await stock(itemA)).toEqual(["-5.000", "-25.00"]);
    const { rows: layers } = await pool.query(
      `SELECT qty::text AS q FROM inventory_negative_layers WHERE location_id = $1 AND stock_item_id = $2`,
      [ctx.locationId, itemA]
    );
    expect(layers.map((layer) => layer.q)).toEqual(["5.000"]);
    expect(await journalLines(`STOCK-IN-${c2.containerId}`)).toEqual([]);
    await expectReconciled();
  }, 120_000);
});
