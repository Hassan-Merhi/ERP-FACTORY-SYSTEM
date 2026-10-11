/**
 * Wave 11 follow-ups (accounting audit 2026-10):
 *
 *   1. the closing-stock reports value each row by total_value over every
 *      non-deleted location (inactive ones too), so their total equals
 *      companyStockValuation().total;
 *   3. a transfer whose destination is short posts the settlement variance to
 *      COGS (INV-MOVE, same transaction);
 *   4. an offload line that returned stock (negative quantity and value_moved)
 *      is replayed as an issue by the as-of valuation;
 *   5. a stock adjustment's type is read trimmed and case-insensitively, so a
 *      ' consumption ' line is an issue in the inventory line and the replay;
 *   7. after the cut-over an ERP sale or transfer of a factory bale-mirror item
 *      is refused (409 FACTORY_BALE_MIRROR_STOCK);
 *   8. under perpetual inventory an offload of non-USD purchase orders is
 *      refused (409); before the cut-over it still runs;
 *   9. the reviewed bale re-cost routes resolve to Factory Settings;
 * Follow-up 10 (factory stock value events) is in wave11-followups-factory.test.ts.
 */
import type { Request } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { resolveFactoryBackendAccessRequirement } from "../server/middleware/factoryBackendAccessBoundary";
import { FACTORY_BALE_MIRROR_STOCK } from "../server/services/accounting/perpetualInventory/cutoverRefusal";
import { syncStockAdjustmentInventoryTx } from "../server/services/accounting/perpetualInventory/stockAdjustments";
import { OFFLOAD_CURRENCY_UNCONFIRMED_CODE } from "../server/services/containers/offload-lifecycle/execute";
import { companyStockValuation } from "../server/services/inventory/stockValuation";
import { calculateHistoricalLocationInventory } from "../server/routes/helpers/inventoryHistoryHelpers";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w11fu";
const day = (offset: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const today = day(0);
const yesterday = day(-1);

let ctx: TestContext;
let agent: request.SuperAgentTest;
let sequence = 0;
let supplierId: number;

async function newItem(uom = "PCS", code?: string): Promise<{ id: number; code: string }> {
  sequence += 1;
  const itemCode = code ?? `${TEST_PREFIX}-X${sequence}`;
  const [item] = await db
    .insert(schema.stockItems)
    .values({
      companyId: ctx.companyId,
      code: itemCode,
      name: itemCode,
      uom,
      stockGroupId: ctx.stockGroupId,
      active: true,
      openingRate: "5.00",
    })
    .returning();
  return { id: item.id, code: itemCode };
}

async function setStock(locationId: number, stockItemId: number, quantity: string, rate: string, value: string) {
  await pool.query(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (location_id, stock_item_id) DO UPDATE
       SET quantity = EXCLUDED.quantity, average_rate = EXCLUDED.average_rate, total_value = EXCLUDED.total_value`,
    [ctx.companyId, locationId, stockItemId, quantity, rate, value]
  );
}

async function journalsOf(sourceType: string) {
  const { rows } = await pool.query(
    `SELECT v.voucher_number, la.code, ve.debit_amount::text AS d, ve.credit_amount::text AS c
       FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE v.company_id = $1 AND v.voucher_number LIKE $2 AND v.deleted_at IS NULL
      ORDER BY v.id, la.code`,
    [ctx.companyId, `INV-MOVE-${ctx.companyId}-${sourceType}-%`]
  );
  const journals = new Map<string, Array<[string, string, string]>>();
  for (const row of rows) {
    journals.set(row.voucher_number, [...(journals.get(row.voucher_number) ?? []), [row.code, row.d, row.c]]);
  }
  return [...journals.values()];
}

async function setCutover(active: boolean) {
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [ctx.companyId]);
  if (active) {
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by)
       VALUES ($1, '2026-01-01', '{}'::jsonb, 'test')`,
      [ctx.companyId]
    );
  }
}

async function eurContainer(stockItemId: number) {
  sequence += 1;
  const containerNumber = `${TEST_PREFIX}-C${sequence}`;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date, charges_total)
     VALUES ($1, $2, $3, 'OTW', $4, '0') RETURNING id`,
    [ctx.companyId, containerNumber, supplierId, today]
  );
  const containerId = rows[0].id;
  const po = await pool.query<{ id: number }>(
    `INSERT INTO purchase_orders (company_id, po_number, container_id, supplier_id, currency, status, items_total)
     VALUES ($1, $2, $3, $4, 'EUR', 'Open', '20.00') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-PO${sequence}`, containerId, supplierId]
  );
  await pool.query(
    `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
     VALUES ($1, $2, 'line', '4', '5', '20.00')`,
    [po.rows[0].id, stockItemId]
  );
  return containerId;
}

const offload = (containerId: number) =>
  agent.post(`/api/containers/${containerId}/offload`).send({
    locationId: ctx.locationId,
    offloadDate: today,
    duties: "0",
    officeCharges: "0",
    transferCharges: "0",
    transportFees: "0",
  });

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}SUP`, `${TEST_PREFIX} Supplier`, "w11fu@example.test"]
  );
  supplierId = supplier.rows[0].id;
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await pool.query(
    `UPDATE user_company_roles SET role = 'Admin', can_sell_negative_stock = true WHERE user_id = $1 AND company_id = $2`,
    [ctx.userId, ctx.companyId]
  );
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  const id = ctx.companyId;
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [id]);
  await pool.query(`UPDATE locations SET active = true WHERE company_id = $1`, [id]);
  await pool.query(
    `DELETE FROM accounting_posting_requests WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
    [id]
  );
  await pool.query(
    `DELETE FROM stock_adjustment_items WHERE adjustment_id IN (SELECT sav.id FROM stock_adjustment_vouchers sav JOIN vouchers v ON v.id = sav.voucher_id WHERE v.company_id = $1)`,
    [id]
  );
  await pool.query(
    `DELETE FROM stock_adjustment_vouchers WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
    [id]
  );
  await pool.query(`DELETE FROM factory_bale_products WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM inventory_negative_layers WHERE company_id = $1`, [id]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120_000);

describe("closing-stock reports (follow-up 1)", () => {
  it("total equals the company stock valuation: total_value, inactive locations, no negative rows", async () => {
    const drifted = await newItem();
    const inactive = await newItem();
    const short = await newItem();
    // quantity × average_rate (3 × 0.33 = 0.99) drifts from the stored value.
    await setStock(ctx.locationId, drifted.id, "3", "0.33", "1.00");
    await setStock(ctx.location2Id, inactive.id, "2", "2.5", "5.00");
    await setStock(ctx.locationId, short.id, "-1", "4", "-4.00");
    await pool.query(`UPDATE locations SET active = false WHERE id = $1`, [ctx.location2Id]);
    try {
      const summary = await agent.get("/api/reports/closing-stock-summary");
      expect(summary.status, JSON.stringify(summary.body)).toBe(200);
      const valuation = await companyStockValuation(db, ctx.companyId);
      expect(summary.body.grandTotal.value.toFixed(2)).toBe(valuation.total);
      const detail = await agent.get(`/api/reports/closing-stock-summary/${ctx.stockGroupId}/items`);
      expect(detail.status).toBe(200);
      const rows = detail.body.items as Array<{ id: number; closing: { value: number } }>;
      expect(rows.find((row) => row.id === drifted.id)?.closing.value).toBe(1);
      expect(rows.find((row) => row.id === inactive.id)?.closing.value).toBe(5);
      expect(rows.find((row) => row.id === short.id)).toBeUndefined();
    } finally {
      await pool.query(`UPDATE locations SET active = true WHERE id = $1`, [ctx.location2Id]);
      for (const item of [drifted, inactive, short]) {
        await pool.query(`DELETE FROM inventory WHERE stock_item_id = $1`, [item.id]);
      }
    }
  }, 60_000);
});

describe("before the cut-over", () => {
  it("still offloads a non-USD container (follow-up 8)", async () => {
    await setCutover(false);
    const item = await newItem();
    const response = await offload(await eurContainer(item.id));
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  }, 60_000);

  it("still sells a bale-mirror item in the ERP (follow-up 7)", async () => {
    const mirror = await newItem("BALE", `${TEST_PREFIX.toUpperCase()}-MB0`);
    await pool.query(
      `INSERT INTO factory_bale_products (company_id, code, name, production_price, selling_price)
       VALUES ($1, $2::varchar, $2::text, '10', '20')`,
      [ctx.companyId, mirror.code]
    );
    await setStock(ctx.locationId, mirror.id, "5", "0", "0.00");
    const sale = await agent.post("/api/pos/sales").send({
      locationId: ctx.locationId,
      items: [{ stockItemId: mirror.id, quantity: 1, rate: 50 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: today,
    });
    expect(sale.status, JSON.stringify(sale.body)).toBeLessThan(300);
  }, 60_000);
});

describe("after the cut-over", () => {
  beforeAll(async () => {
    await setCutover(true);
  });

  it("refuses an offload of non-USD purchase orders (follow-up 8)", async () => {
    const item = await newItem();
    const containerId = await eurContainer(item.id);
    const response = await offload(containerId);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.code).toBe(OFFLOAD_CURRENCY_UNCONFIRMED_CODE);
    const { rows } = await pool.query(`SELECT status FROM containers WHERE id = $1`, [containerId]);
    expect(rows[0].status).toBe("OTW");
  }, 60_000);

  it("refuses an ERP sale and transfers of a factory bale-mirror item (follow-up 7)", async () => {
    const mirror = await newItem("BALE", `${TEST_PREFIX.toUpperCase()}-MB1`);
    await pool.query(
      `INSERT INTO factory_bale_products (company_id, code, name, production_price, selling_price)
       VALUES ($1, $2::varchar, $2::text, '10', '20')`,
      [ctx.companyId, mirror.code]
    );
    await setStock(ctx.locationId, mirror.id, "5", "0", "0.00");
    const sale = await agent.post("/api/pos/sales").send({
      locationId: ctx.locationId,
      items: [{ stockItemId: mirror.id, quantity: 1, rate: 50 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: today,
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(409);
    expect(sale.body.code).toBe(FACTORY_BALE_MIRROR_STOCK);
    expect(sale.body.stockItemIds).toEqual([mirror.id]);

    const silent = await agent.post("/api/inventory/silent-transfer/apply").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      items: [{ stockItemId: mirror.id, quantity: "1" }],
    });
    expect(silent.status, JSON.stringify(silent.body)).toBe(409);
    expect(silent.body.code).toBe(FACTORY_BALE_MIRROR_STOCK);
    const { rows } = await pool.query(
      `SELECT quantity::text AS q FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
      [ctx.locationId, mirror.id]
    );
    expect(rows[0].q).toBe("5.000");
  }, 60_000);

  it("posts a short destination's settlement variance to COGS on a transfer (follow-up 3)", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item.id, "5", "5", "25.00");
    // The destination sold 2 short at the provisional 3.00.
    await setStock(ctx.location2Id, item.id, "-2", "3", "-6.00");
    const before = await journalsOf("silent-transfer");
    const response = await agent.post("/api/inventory/silent-transfer/apply").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      items: [{ stockItemId: item.id, quantity: "2" }],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    // Source relieves 10.00; the destination takes back the 6.00 it was short,
    // so the 4.00 the units cost more than provisionally booked goes to COGS.
    const journals = await journalsOf("silent-transfer");
    expect(journals.length).toBe(before.length + 1);
    expect(journals.at(-1)).toEqual([
      ["COGS", "4.00", "0.00"],
      ["INVENTORY", "0.00", "4.00"],
    ]);
  }, 60_000);

  it("reads a ' consumption ' adjustment as an issue in its inventory line and the replay (follow-up 5)", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item.id, "3", "3", "9.00");
    const voucherId = await db.transaction(async (tx) => {
      const [account] = await tx
        .insert(schema.ledgerAccounts)
        .values({
          companyId: ctx.companyId,
          code: `${TEST_PREFIX.toUpperCase()}-SADJ`,
          name: `${TEST_PREFIX} stock adjustment`,
          accountType: "Indirect Expense",
          active: true,
        })
        .returning();
      const [voucher] = await tx
        .insert(schema.vouchers)
        .values({
          companyId: ctx.companyId,
          voucherType: "Consumption",
          voucherNumber: `${TEST_PREFIX.toUpperCase()}-CONS`,
          voucherDate: today,
          description: "consumption",
          totalAmount: "6.00",
          currency: "USD",
          locationId: ctx.locationId,
        })
        .returning();
      await tx.insert(schema.voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: account.id,
        debitAmount: "6.00",
        creditAmount: "0",
        narration: "consumption expense",
      });
      const [adjustment] = await tx
        .insert(schema.stockAdjustmentVouchers)
        .values({ voucherId: voucher.id, locationId: ctx.locationId, adjustmentType: " consumption ", notes: "" })
        .returning();
      await tx.insert(schema.stockAdjustmentItems).values({
        adjustmentId: adjustment.id,
        stockItemId: item.id,
        quantity: "2",
        rate: "3",
        totalAmount: "6.00",
        valueMoved: "6.00",
      });
      expect(await syncStockAdjustmentInventoryTx(tx, ctx.companyId, voucher.id)).toBe("-6.00");
      return voucher.id;
    });
    const { rows } = await pool.query(
      `SELECT la.code, ve.debit_amount::text AS d, ve.credit_amount::text AS c
         FROM voucher_entries ve JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE ve.voucher_id = $1 ORDER BY la.code`,
      [voucherId]
    );
    expect(rows.map((row) => [row.code, row.d, row.c])).toEqual([
      ["INVENTORY", "0.00", "6.00"],
      [`${TEST_PREFIX.toUpperCase()}-SADJ`, "6.00", "0.00"],
    ]);

    const history = await calculateHistoricalLocationInventory(ctx.locationId, ctx.companyId, yesterday);
    const replayed = history.find((row) => row.stockItemId === item.id)!;
    expect(Number(replayed.quantity)).toBe(5);
    expect(Number(replayed.totalValue)).toBe(15);
  }, 60_000);

  it("replays an offload line that returned stock as an issue (follow-up 4)", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item.id, "3", "3", "9.00");
    sequence += 1;
    const container = await pool.query<{ id: number }>(
      `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date, charges_total)
       VALUES ($1, $2, $3, 'OFFLOADED', $4, '0') RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-R${sequence}`, supplierId, today]
    );
    const offloadRow = await pool.query<{ id: number }>(
      `INSERT INTO container_offloads (container_id, location_id, total_bales, additional_cost_per_bale, offloaded_at)
       VALUES ($1, $2, '2', '0', now()) RETURNING id`,
      [container.rows[0].id, ctx.locationId]
    );
    await pool.query(
      `INSERT INTO container_offload_items (offload_id, stock_item_id, quantity, rate, total_value, value_moved)
       VALUES ($1, $2, '-2', '3', '-6.00', '-6.00')`,
      [offloadRow.rows[0].id, item.id]
    );
    const history = await calculateHistoricalLocationInventory(ctx.locationId, ctx.companyId, yesterday);
    const replayed = history.find((row) => row.stockItemId === item.id)!;
    // The return took 2 units worth 6.00 out today: yesterday held 5 worth 15.00.
    expect(Number(replayed.quantity)).toBe(5);
    expect(Number(replayed.totalValue)).toBe(15);
    await pool.query(`DELETE FROM container_offload_items WHERE offload_id = $1`, [offloadRow.rows[0].id]);
    await pool.query(`DELETE FROM container_offloads WHERE id = $1`, [offloadRow.rows[0].id]);
  }, 60_000);
});

describe("factory access boundary (follow-up 9)", () => {
  const req = (path: string, method = "GET") =>
    ({ path, method, originalUrl: `/api/factory${path}`, query: {}, body: {}, session: {} }) as unknown as Request;

  it("puts the reviewed bale re-cost behind Factory Settings, like the other cost repairs", () => {
    expect(resolveFactoryBackendAccessRequirement(req("/bale-cost/recost-preview"))).toEqual({
      pageKey: "factory/settings",
    });
    expect(resolveFactoryBackendAccessRequirement(req("/bale-cost/recost-apply", "POST"))).toEqual({
      pageKey: "factory/settings",
    });
    expect(resolveFactoryBackendAccessRequirement(req("/repair-perkg-prices", "POST"))).toEqual({
      pageKey: "factory/settings",
    });
  });

  it("no longer lists the retired bale cost backfill as a Settings tool", () => {
    expect(resolveFactoryBackendAccessRequirement(req("/bales/backfill-costs", "POST"))).not.toEqual({
      pageKey: "factory/settings",
    });
  });
});
