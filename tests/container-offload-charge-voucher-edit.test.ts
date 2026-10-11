/**
 * Editing an offload charge voucher re-prices the offloaded bales.
 *
 * The offload spreads duties and transport fees over every bale and posts a
 * DUTY-/TRANS- voucher for each. Changing that voucher's amount afterwards must
 * carry through to the offload record, each offload line's cost per bale, and
 * the inventory at the offload location — not just the ledger.
 */
import Decimal from "decimal.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "offchgedit";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let sequence = 0;

async function makeOffloadableContainer(lines: Array<{ stockItemId: number; quantity: string; rate: string }>) {
  sequence += 1;
  const containerNumber = `${TEST_PREFIX}-C${sequence}`;
  const container = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date, charges_total)
     VALUES ($1, $2, $3, 'OTW', '2026-09-01', '0') RETURNING id`,
    [ctx.companyId, containerNumber, supplierId]
  );
  const po = await pool.query<{ id: number }>(
    `INSERT INTO purchase_orders (company_id, po_number, container_id, supplier_id, currency, status)
     VALUES ($1, $2, $3, $4, 'USD', 'Open') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-PO${sequence}`, container.rows[0].id, supplierId]
  );
  for (const line of lines) {
    await pool.query(
      `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        po.rows[0].id,
        line.stockItemId,
        `${TEST_PREFIX} line`,
        line.quantity,
        line.rate,
        new Decimal(line.quantity).times(line.rate).toFixed(2),
      ]
    );
  }
  return { containerId: container.rows[0].id, containerNumber };
}

async function chargeVoucher(prefix: string, containerNumber: string) {
  const voucher = await pool.query<{ id: number; voucher_date: string; total_amount: string }>(
    `SELECT id, voucher_date::text, total_amount FROM vouchers
      WHERE company_id = $1 AND voucher_number LIKE $2 AND deleted_at IS NULL`,
    [ctx.companyId, `${prefix}-${containerNumber}-%`]
  );
  expect(voucher.rows).toHaveLength(1);
  const entries = await pool.query<{ ledger_account_id: number; debit_amount: string; credit_amount: string }>(
    `SELECT ledger_account_id, debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
    [voucher.rows[0].id]
  );
  return { ...voucher.rows[0], entries: entries.rows };
}

async function offloadState(containerId: number) {
  const offload = await pool.query<{
    id: number;
    duties: string;
    transport_fees: string;
    total_charges: string;
    additional_cost_per_bale: string;
  }>(
    `SELECT id, duties, transport_fees, total_charges, additional_cost_per_bale
       FROM container_offloads WHERE container_id = $1`,
    [containerId]
  );
  const items = await pool.query<{ stock_item_id: number; rate: string; total_value: string }>(
    `SELECT stock_item_id, rate, total_value FROM container_offload_items WHERE offload_id = $1 ORDER BY stock_item_id`,
    [offload.rows[0].id]
  );
  return { offload: offload.rows[0], items: items.rows };
}

async function inventoryAt(stockItemId: number) {
  const result = await pool.query<{ quantity: string; average_rate: string; total_value: string }>(
    // average_rate is numeric(20,7) since wave 11; these rates are compared at the 2dp the writer uses.
    `SELECT quantity, average_rate::numeric(20,2)::text AS average_rate, total_value
       FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
    [ctx.locationId, stockItemId]
  );
  return result.rows[0];
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}SUP`, `${TEST_PREFIX} Supplier`, "offchgedit@example.test"]
  );
  supplierId = supplier.rows[0].id;

  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("editing an offload charge voucher", () => {
  it("re-prices every bale on the offload and in inventory", async () => {
    await pool.query(`DELETE FROM inventory WHERE location_id = $1`, [ctx.locationId]);
    // 10 bales at 5.00 and 20 bales at 4.00 — 30 bales.
    const [itemA, itemB] = ctx.stockItemIds;
    const { containerId, containerNumber } = await makeOffloadableContainer([
      { stockItemId: itemA, quantity: "10", rate: "5.00" },
      { stockItemId: itemB, quantity: "20", rate: "4.00" },
    ]);

    // Duties 30 + transport 30 = 60 over 30 bales = 2.00 a bale.
    const offload = await agent.post(`/api/containers/${containerId}/offload`).send({
      locationId: ctx.locationId,
      offloadDate: "2026-09-15",
      duties: "30.00",
      dutiesAccountId: ctx.cashAccountId,
      officeCharges: "0",
      transferCharges: "0",
      transportFees: "30.00",
      transportAccountId: ctx.cashAccountId,
    });
    expect(offload.status, JSON.stringify(offload.body)).toBeLessThan(300);

    let state = await offloadState(containerId);
    expect(state.offload.additional_cost_per_bale).toBe("2.00");
    expect(state.items.map((item) => item.rate)).toEqual(["7.00", "6.00"]);
    expect((await inventoryAt(itemA)).average_rate).toBe("7.00");

    // Edit the duty voucher from the voucher screen: 30 → 90.
    const duty = await chargeVoucher("DUTY", containerNumber);
    const dutyEdit = await agent.put(`/api/vouchers/${duty.id}/with-entries`).send({
      voucher: {
        voucherType: "Payment",
        voucherDate: duty.voucher_date,
        description: `Duties for container ${containerNumber}`,
      },
      entries: duty.entries.map((entry) => ({
        ledgerAccountId: entry.ledger_account_id,
        debitAmount: Number(entry.debit_amount) > 0 ? "90.00" : "0",
        creditAmount: Number(entry.credit_amount) > 0 ? "90.00" : "0",
      })),
    });
    expect(dutyEdit.status, JSON.stringify(dutyEdit.body)).toBe(200);

    // 120 of charges over 30 bales = 4.00 a bale.
    state = await offloadState(containerId);
    expect(state.offload.duties).toBe("90.00");
    expect(state.offload.total_charges).toBe("120.00");
    expect(state.offload.additional_cost_per_bale).toBe("4.00");
    expect(state.items.map((item) => [item.rate, item.total_value])).toEqual([
      ["9.00", "90.00"],
      ["8.00", "160.00"],
    ]);
    expect(await inventoryAt(itemA)).toMatchObject({ average_rate: "9.00", total_value: "90.00" });
    expect(await inventoryAt(itemB)).toMatchObject({ average_rate: "8.00", total_value: "160.00" });

    // Edit the transport voucher from the Payment form: 30 → 15.
    const transport = await chargeVoucher("TRANS", containerNumber);
    const expense = transport.entries.find((entry) => Number(entry.debit_amount) > 0)!;
    const payee = transport.entries.find((entry) => Number(entry.credit_amount) > 0)!;
    const transportEdit = await agent.patch(`/api/vouchers/${transport.id}/payment-receipt`).send({
      voucherType: "Payment",
      voucherDate: transport.voucher_date,
      paymentAccountType: "ledger",
      paymentAccountId: payee.ledger_account_id,
      entries: [{ accountType: "ledger", accountId: expense.ledger_account_id, amount: "15.00" }],
      notes: `Transport fees for container ${containerNumber}`,
    });
    expect(transportEdit.status, JSON.stringify(transportEdit.body)).toBe(200);

    // 105 of charges over 30 bales = 3.50 a bale.
    state = await offloadState(containerId);
    expect(state.offload.transport_fees).toBe("15.00");
    expect(state.offload.total_charges).toBe("105.00");
    expect(state.offload.additional_cost_per_bale).toBe("3.50");
    expect(state.items.map((item) => [item.rate, item.total_value])).toEqual([
      ["8.50", "85.00"],
      ["7.50", "150.00"],
    ]);
    expect(await inventoryAt(itemA)).toMatchObject({ average_rate: "8.50", total_value: "85.00" });
    expect(await inventoryAt(itemB)).toMatchObject({ average_rate: "7.50", total_value: "150.00" });
  });

  it("leaves the cost of bales already sold alone", async () => {
    await pool.query(`DELETE FROM inventory WHERE location_id = $1`, [ctx.locationId]);
    const [itemA] = ctx.stockItemIds;
    const { containerId, containerNumber } = await makeOffloadableContainer([
      { stockItemId: itemA, quantity: "10", rate: "5.00" },
    ]);
    const offload = await agent.post(`/api/containers/${containerId}/offload`).send({
      locationId: ctx.locationId,
      offloadDate: "2026-09-15",
      duties: "20.00",
      dutiesAccountId: ctx.cashAccountId,
      officeCharges: "0",
      transferCharges: "0",
      transportFees: "0",
    });
    expect(offload.status, JSON.stringify(offload.body)).toBeLessThan(300);
    expect((await inventoryAt(itemA)).average_rate).toBe("7.00");

    // Six of the ten bales have been sold; four remain at 7.00.
    await pool.query(
      `UPDATE inventory SET quantity = '4', total_value = '28.00' WHERE location_id = $1 AND stock_item_id = $2`,
      [ctx.locationId, itemA]
    );

    // Duties 20 → 40 is 2.00 more per bale.
    const duty = await chargeVoucher("DUTY", containerNumber);
    const edit = await agent.put(`/api/vouchers/${duty.id}/with-entries`).send({
      voucher: { voucherType: "Payment", voucherDate: duty.voucher_date },
      entries: duty.entries.map((entry) => ({
        ledgerAccountId: entry.ledger_account_id,
        debitAmount: Number(entry.debit_amount) > 0 ? "40.00" : "0",
        creditAmount: Number(entry.credit_amount) > 0 ? "40.00" : "0",
      })),
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);

    const state = await offloadState(containerId);
    expect(state.items[0]).toMatchObject({ rate: "9.00", total_value: "90.00" });
    // Only the four bales on hand take the extra 2.00 each.
    expect(await inventoryAt(itemA)).toMatchObject({ quantity: "4.000", average_rate: "9.00", total_value: "36.00" });
  });
});

describe("repairing offloads edited before the sync existed", () => {
  it("previews and applies the gap between stored charges and live vouchers", async () => {
    await pool.query(`DELETE FROM inventory WHERE location_id = $1`, [ctx.locationId]);
    const [itemA, itemB] = ctx.stockItemIds;
    const { containerId, containerNumber } = await makeOffloadableContainer([
      { stockItemId: itemA, quantity: "10", rate: "5.00" },
      { stockItemId: itemB, quantity: "20", rate: "4.00" },
    ]);
    const offload = await agent.post(`/api/containers/${containerId}/offload`).send({
      locationId: ctx.locationId,
      offloadDate: "2026-09-15",
      duties: "30.00",
      dutiesAccountId: ctx.cashAccountId,
      officeCharges: "15.00",
      transferCharges: "0",
      transportFees: "30.00",
      transportAccountId: ctx.cashAccountId,
    });
    expect(offload.status, JSON.stringify(offload.body)).toBeLessThan(300);
    // 75 over 30 bales = 2.50 a bale; office charges had no account, so no voucher.
    expect((await offloadState(containerId)).offload.additional_cost_per_bale).toBe("2.50");

    // An edit made before the sync: the duty voucher went 30 → 90 and nothing else moved.
    const duty = await chargeVoucher("DUTY", containerNumber);
    await pool.query(`UPDATE vouchers SET total_amount = '90.00' WHERE id = $1`, [duty.id]);

    // The repair scan must keep the legacy voucher-number matching rules:
    // optional/deleted vouchers and non-numeric suffixes do not contribute.
    await pool.query(
      `INSERT INTO vouchers
         (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional, deleted_at)
       VALUES
         ($1, $2, 'Payment', '2026-09-15', '400.00', true, NULL),
         ($1, $3, 'Payment', '2026-09-15', '500.00', false, NOW()),
         ($1, $4, 'Payment', '2026-09-15', '700.00', false, NULL)`,
      [
        ctx.companyId,
        `DUTY-${containerNumber}-999001`,
        `DUTY-${containerNumber}-999002`,
        `DUTY-${containerNumber}-NOTNUM`,
      ]
    );

    const preview = await agent.get("/api/admin/offload-charge-voucher-repair");
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const rows = preview.body.drift.filter(
      (row: { containerNumber: string }) => row.containerNumber === containerNumber
    );
    expect(rows).toEqual([
      expect.objectContaining({
        prefix: "DUTY",
        stored: "30.00",
        vouchers: "90.00",
        chargeDelta: "60.00",
        oldCostPerBale: "2.50",
        newCostPerBale: "4.50",
        balesOnHand: "30.000",
      }),
    ]);
    // The preview changes nothing.
    expect((await offloadState(containerId)).offload.duties).toBe("30.00");

    const apply = await agent
      .post("/api/admin/offload-charge-voucher-repair")
      .send({ offloadIds: [rows[0].offloadId] });
    expect(apply.status, JSON.stringify(apply.body)).toBe(200);
    expect(apply.body.repaired).toHaveLength(1);

    const state = await offloadState(containerId);
    expect(state.offload).toMatchObject({
      duties: "90.00",
      transport_fees: "30.00",
      total_charges: "135.00",
      additional_cost_per_bale: "4.50",
    });
    expect(state.items.map((item) => [item.rate, item.total_value])).toEqual([
      ["9.50", "95.00"],
      ["8.50", "170.00"],
    ]);
    expect(await inventoryAt(itemA)).toMatchObject({ average_rate: "9.50", total_value: "95.00" });
    expect(await inventoryAt(itemB)).toMatchObject({ average_rate: "8.50", total_value: "170.00" });

    // Running it again finds nothing left to do for this container.
    const again = await agent.get("/api/admin/offload-charge-voucher-repair");
    expect(
      again.body.drift.filter((row: { containerNumber: string }) => row.containerNumber === containerNumber)
    ).toEqual([]);
  });
});
