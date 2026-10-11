/**
 * Wave 11 ("inventory fidelity"), agent B: the remaining ERP stock posting
 * paths and the admin stock tools.
 *
 *   - before the company's perpetual-inventory cut-over the user-facing paths
 *     post nothing and the admin tools work;
 *   - after it, quick adjust, silent production, the labelled location import,
 *     stock-group archive/restore and credit notes post a balanced journal
 *     whose Inventory side equals the sub-ledger change exactly; a stock
 *     adjustment and a transfer record value_moved and a transfer conserves
 *     the company's stock value;
 *   - the admin tools refuse with 409 PERPETUAL_INVENTORY_ACTIVE, the closing
 *     stock transfer is gone (410) for every company and a location that holds
 *     stock cannot be deleted.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { PERPETUAL_INVENTORY_ACTIVE } from "../server/services/accounting/perpetualInventory/cutoverRefusal";
import { createStockAdjustment, createStockTransfer } from "../server/storage/stock-ops/transfers-create";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w11sp";
const today = new Date().toISOString().slice(0, 10);

let ctx: TestContext;
let agent: request.SuperAgentTest;
let sequence = 0;

async function newItem(): Promise<{ id: number; code: string }> {
  sequence += 1;
  const code = `${TEST_PREFIX}-X${sequence}`;
  const [item] = await db
    .insert(schema.stockItems)
    .values({
      companyId: ctx.companyId,
      code,
      name: code,
      uom: "PCS",
      stockGroupId: ctx.stockGroupId,
      active: true,
      openingRate: "5.00",
    })
    .returning();
  return { id: item.id, code };
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

async function stockValue(locationId: number, stockItemId: number): Promise<string> {
  const { rows } = await pool.query(
    `SELECT total_value::text AS v FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
    [locationId, stockItemId]
  );
  return rows[0]?.v ?? "0.00";
}

async function companyStockValue(stockItemId: number): Promise<string> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(total_value), 0)::numeric(20,2)::text AS v FROM inventory WHERE company_id = $1 AND stock_item_id = $2`,
    [ctx.companyId, stockItemId]
  );
  return rows[0].v;
}

const delta = (after: string, before: string) => (Number(after) - Number(before)).toFixed(2);

/** The INV-MOVE journals of a source type: [code, debit, credit] per line, newest journal last. */
async function movementJournals(sourceType: string) {
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

/** The two lines a movement of `net` (signed) posts against `offset`. */
function movementLines(net: string, offset: string): Array<[string, string, string]> {
  const amount = Math.abs(Number(net)).toFixed(2);
  const lines: Array<[string, string, string]> =
    Number(net) > 0
      ? [
          ["INVENTORY", amount, "0.00"],
          [offset, "0.00", amount],
        ]
      : [
          ["INVENTORY", "0.00", amount],
          [offset, amount, "0.00"],
        ];
  return lines.sort((a, b) => a[0].localeCompare(b[0]));
}

async function asRole(role: "Admin" | "Developer" | "Owner") {
  await pool.query(
    `UPDATE user_company_roles SET role = $1, can_sell_negative_stock = true WHERE user_id = $2 AND company_id = $3`,
    [role, ctx.userId, ctx.companyId]
  );
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}

async function voucher(voucherType: string, locationId = ctx.locationId, optional = false): Promise<number> {
  sequence += 1;
  const [row] = await db
    .insert(schema.vouchers)
    .values({
      companyId: ctx.companyId,
      voucherType,
      voucherNumber: `${TEST_PREFIX.toUpperCase()}-V${sequence}`,
      voucherDate: today,
      description: voucherType,
      totalAmount: "0",
      currency: "USD",
      optional,
      locationId,
    })
    .returning();
  return row.id;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  const id = ctx.companyId;
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [id]);
  await pool.query(
    `DELETE FROM accounting_posting_requests WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
    [id]
  );
  await pool.query(
    `DELETE FROM credit_note_items WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
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
  await pool.query(
    `DELETE FROM stock_group_location_archive_items WHERE archive_id IN (SELECT id FROM stock_group_location_archives WHERE company_id = $1)`,
    [id]
  );
  await pool.query(`DELETE FROM stock_group_location_archives WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM inventory_negative_layers WHERE company_id = $1`, [id]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120_000);

describe("before the cut-over", () => {
  it("posts nothing for a quick adjustment, and audits it with the movement", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item.id, "3", "3.3333333", "10.00");
    const response = await agent
      .post("/api/inventory/quick-adjust")
      .send({ stockItemId: item.id, locationId: ctx.locationId, quantity: 1, type: "subtract" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await movementJournals("quick-adjust")).toEqual([]);
    const { rows } = await pool.query(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND table_name = 'inventory' AND record_id = $2`,
      [ctx.companyId, item.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].changes.valueDelta.new).toBe(delta(await stockValue(ctx.locationId, item.id), "10.00"));
  }, 60_000);

  it("keeps the location import unlabelled and unposted", async () => {
    const item = await newItem();
    const response = await agent
      .post(`/api/locations/${ctx.locationId}/import-inventory`)
      .send({ items: [{ Item_barcode: item.code, quantity: "2", rate: "4" }] });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await stockValue(ctx.locationId, item.id)).toBe("8.00");
    expect(await movementJournals("count-import")).toEqual([]);
  }, 60_000);

  it("runs the admin repair tools", async () => {
    expect((await agent.post("/api/admin/repair-inventory-values").send({})).status).toBe(200);
    expect((await agent.post("/api/admin/fix-sales-inventory").send({})).status).toBe(200);
    expect((await agent.post("/api/admin/rebuild-inventory").send({ dryRun: true })).status).toBe(200);
  }, 120_000);

  it("retires the closing stock transfer for every company (410)", async () => {
    const response = await agent.post("/api/reports/transfer-closing-stock").send({ targetCompanyId: ctx.companyId });
    expect(response.status, JSON.stringify(response.body)).toBe(410);
    expect(response.body.code).toBe("TRANSFER_CLOSING_STOCK_RETIRED");
  });

  it("refuses to delete a location that holds stock value or quantity", async () => {
    const item = await newItem();
    // A row with value but no quantity still blocks.
    await setStock(ctx.location2Id, item.id, "0", "0", "1.00");
    const response = await agent.delete(`/api/locations/${ctx.location2Id}`);
    expect(response.status).toBe(409);
    await setStock(ctx.location2Id, item.id, "0", "0", "0.00");
  });
});

describe("after the cut-over", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by) VALUES ($1, $2, '{}'::jsonb, 'test')`,
      [ctx.companyId, today]
    );
  });

  it("posts a quick adjustment as an INV-MOVE journal equal to the sub-ledger change", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item.id, "3", "3.3333333", "10.00");
    const response = await agent
      .post("/api/inventory/quick-adjust")
      .send({ stockItemId: item.id, locationId: ctx.locationId, quantity: 1, type: "subtract" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const net = delta(await stockValue(ctx.locationId, item.id), "10.00");
    expect(Number(net)).toBeLessThan(0);
    const journals = await movementJournals("quick-adjust");
    expect(journals).toHaveLength(1);
    expect(journals[0]).toEqual(movementLines(net, "INVENTORY_ADJUSTMENT"));
  }, 60_000);

  it("posts silent production at the value received", async () => {
    await asRole("Developer");
    const item = await newItem();
    const response = await agent.post("/api/inventory/silent-production").send({
      locationId: ctx.locationId,
      type: "Production",
      items: [{ stockItemId: item.id, quantity: "4", rate: "2.5" }],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await stockValue(ctx.locationId, item.id)).toBe("10.00");
    expect((await movementJournals("silent-production")).at(-1)).toEqual(
      movementLines("10.00", "INVENTORY_ADJUSTMENT")
    );
  }, 60_000);

  it("requires the location import to be labelled, keeps opening stock to the Owner and posts it", async () => {
    await asRole("Admin");
    const item = await newItem();
    const unlabelled = await agent
      .post(`/api/locations/${ctx.locationId}/import-inventory`)
      .send({ items: [{ Item_barcode: item.code, quantity: "2", rate: "4" }] });
    expect(unlabelled.status).toBe(400);
    expect(unlabelled.body.code).toBe("INVENTORY_IMPORT_KIND_REQUIRED");

    const opening = await agent
      .post(`/api/locations/${ctx.locationId}/import-inventory`)
      .send({ importKind: "opening", items: [{ Item_barcode: item.code, quantity: "2", rate: "4" }] });
    expect(opening.status).toBe(403);
    expect(await stockValue(ctx.locationId, item.id)).toBe("0.00");

    const count = await agent
      .post(`/api/locations/${ctx.locationId}/import-inventory`)
      .send({ importKind: "count", items: [{ Item_barcode: item.code, quantity: "2", rate: "4" }] });
    expect(count.status, JSON.stringify(count.body)).toBe(200);
    expect(await stockValue(ctx.locationId, item.id)).toBe("8.00");
    expect((await movementJournals("count-import")).at(-1)).toEqual(movementLines("8.00", "INVENTORY_ADJUSTMENT"));

    await asRole("Owner");
    const ownerOpening = await agent
      .post(`/api/locations/${ctx.locationId}/import-inventory`)
      .send({ importKind: "opening", items: [{ Item_barcode: item.code, quantity: "1", rate: "4" }] });
    expect(ownerOpening.status, JSON.stringify(ownerOpening.body)).toBe(200);
    expect((await movementJournals("opening-import")).at(-1)).toEqual(movementLines("4.00", "OPENING_BALANCE_EQUITY"));
    await asRole("Admin");
  }, 60_000);

  it("archives and restores a stock group atomically, with its journals", async () => {
    // Location 2 holds only this group's archived item.
    const item = await newItem();
    await setStock(ctx.location2Id, item.id, "4", "2.5", "10.00");
    const archived = await agent
      .post("/api/stock-group-archives")
      .send({ locationId: ctx.location2Id, stockGroupId: ctx.stockGroupId });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(await stockValue(ctx.location2Id, item.id)).toBe("0.00");
    const archiveValue = Number(archived.body.totalValue).toFixed(2);
    expect((await movementJournals("stock-archive")).at(-1)).toEqual(
      movementLines(`-${archiveValue}`, "INVENTORY_ADJUSTMENT")
    );

    const restored = await agent.post(`/api/stock-group-archives/${archived.body.id}/restore`).send({});
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(await stockValue(ctx.location2Id, item.id)).toBe("10.00");
    expect((await movementJournals("stock-archive-restore")).at(-1)).toEqual(
      movementLines(archiveValue, "INVENTORY_ADJUSTMENT")
    );
    // A second restore changes nothing.
    expect((await agent.post(`/api/stock-group-archives/${archived.body.id}/restore`).send({})).status).toBe(500);
    expect(await stockValue(ctx.location2Id, item.id)).toBe("10.00");
    await setStock(ctx.location2Id, item.id, "0", "0", "0.00");
  }, 60_000);

  it("posts a credit note's Inventory at the sub-ledger change and refuses a zero-cost return", async () => {
    const item = await newItem();
    const zeroCost = await agent.post("/api/credit-notes").send({
      noteType: "Credit Note",
      voucherDate: today,
      cashAccountId: ctx.cashAccountId,
      cashAccountType: "ledger",
      items: [{ stockItemId: item.id, locationId: ctx.locationId, quantity: 2, refundRate: 6, inventoryCost: 0 }],
    });
    expect(zeroCost.status).toBe(400);

    await setStock(ctx.locationId, item.id, "3", "3.3333333", "10.00");
    const note = await agent.post("/api/credit-notes").send({
      noteType: "Credit Note",
      voucherDate: today,
      cashAccountId: ctx.cashAccountId,
      cashAccountType: "ledger",
      items: [{ stockItemId: item.id, locationId: ctx.locationId, quantity: 2, refundRate: 6, inventoryCost: 4 }],
    });
    expect(note.status, JSON.stringify(note.body)).toBe(200);
    const received = delta(await stockValue(ctx.locationId, item.id), "10.00");
    expect(received).toBe("8.00");
    const { rows } = await pool.query(
      `SELECT la.code, SUM(ve.debit_amount - ve.credit_amount)::numeric(20,2)::text AS net
         FROM voucher_entries ve JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE ve.voucher_id = $1 GROUP BY la.code`,
      [note.body.voucherId]
    );
    const byCode = Object.fromEntries(rows.map((row) => [row.code, row.net]));
    expect(byCode.INVENTORY).toBe(received);
    expect(rows.reduce((sum, row) => sum + Number(row.net), 0)).toBeCloseTo(0, 6);
    const items = await pool.query(`SELECT value_moved::text AS v FROM credit_note_items WHERE voucher_id = $1`, [
      note.body.voucherId,
    ]);
    expect(items.rows[0].v).toBe("8.00");
  }, 60_000);

  it("records value_moved on stock adjustments and posts Inventory at it", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item.id, "3", "3.3333333", "10.00");
    const voucherId = await voucher("Consumption");
    await createStockAdjustment(voucherId, ctx.locationId, "Consumption", "w11", [
      { stockItemId: item.id, quantity: "1", rate: "9" },
    ]);
    const relieved = delta("10.00", await stockValue(ctx.locationId, item.id));
    const { rows } = await pool.query(
      `SELECT sai.value_moved::text AS v FROM stock_adjustment_items sai JOIN stock_adjustment_vouchers sav ON sav.id = sai.adjustment_id WHERE sav.voucher_id = $1`,
      [voucherId]
    );
    expect(rows[0].v).toBe(relieved);
    const inventoryLine = await pool.query(
      `SELECT SUM(ve.credit_amount - ve.debit_amount)::numeric(20,2)::text AS net
         FROM voucher_entries ve JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE ve.voucher_id = $1 AND la.code = 'INVENTORY'`,
      [voucherId]
    );
    expect(inventoryLine.rows[0].net).toBe(relieved);
  }, 60_000);

  it("conserves the company's stock value on a transfer and records value_moved", async () => {
    const item = await newItem();
    // 3 units holding 10.00: the true rate has three decimals (3.333...).
    await setStock(ctx.locationId, item.id, "3", "3.3333333", "10.00");
    const voucherId = await voucher("Stock Transfer");
    const { items } = await createStockTransfer(
      voucherId,
      ctx.location2Id,
      "w11",
      [{ sourceLocationId: ctx.locationId, stockItemId: item.id, quantity: "3", rate: "3.33" }],
      { activeCompanyId: ctx.companyId }
    );
    // The whole 10.00 moves, not 3 × 3.33.
    expect(await stockValue(ctx.locationId, item.id)).toBe("0.00");
    expect(await stockValue(ctx.location2Id, item.id)).toBe("10.00");
    expect(await companyStockValue(item.id)).toBe("10.00");
    const { rows } = await pool.query(`SELECT value_moved::text AS v FROM stock_transfer_items WHERE id = $1`, [
      items[0].id,
    ]);
    expect(rows[0].v).toBe("10.00");
    expect(await movementJournals("stock-transfer")).toEqual([]);
    await setStock(ctx.location2Id, item.id, "0", "0", "0.00");
  }, 60_000);

  it("refuses the admin stock tools with 409", async () => {
    // The rebuild is a privileged operation: confirmed password and token.
    await agent.post("/api/auth/confirm-password").send({ password: "testpassword123" });
    for (const [path, body] of [
      [
        "/api/admin/rebuild-inventory",
        {
          dryRun: false,
          confirmationToken: `REBUILD-INVENTORY:${ctx.companyId}`,
          reason: "wave 11 refusal test",
          idempotencyKey: `${TEST_PREFIX}-rebuild`,
          sourceId: `${TEST_PREFIX}-rebuild`,
        },
      ],
      ["/api/admin/repair-inventory-values", {}],
      ["/api/admin/fix-sales-inventory", {}],
      ["/api/reports/carryforward-closing-stock", {}],
    ] as const) {
      const response = await agent.post(path).send(body);
      expect(response.status, `${path} ${JSON.stringify(response.body)}`).toBe(409);
      expect(response.body.code, path).toBe(PERPETUAL_INVENTORY_ACTIVE);
    }
    await asRole("Developer");
    const costPrices = await agent
      .post(`/api/locations/${ctx.locationId}/import-cost-prices`)
      .send({ updates: [{ barcode: `${TEST_PREFIX}-ITEM1`, costPrice: 1 }] });
    expect(costPrices.status).toBe(409);
    expect(costPrices.body.code).toBe(PERPETUAL_INVENTORY_ACTIVE);
    await asRole("Admin");
  }, 120_000);

  it("refuses the exact reversal of a stock document, not of other vouchers", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item.id, "10", "2", "20.00");
    const adjustmentVoucher = await voucher("Production");
    await createStockAdjustment(adjustmentVoucher, ctx.locationId, "Production", "w11", [
      { stockItemId: item.id, quantity: "1", rate: "2" },
    ]);
    const refused = await agent.post(`/api/vouchers/${adjustmentVoucher}/exact-reversal`).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe(PERPETUAL_INVENTORY_ACTIVE);
    expect(refused.body.action).toBe("exact-voucher-reversal");

    // A movement journal is a linked stock journal too.
    const [journal] = await movementJournals("quick-adjust");
    expect(journal).toBeDefined();
    const { rows } = await pool.query(
      `SELECT id FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2 LIMIT 1`,
      [ctx.companyId, `INV-MOVE-${ctx.companyId}-quick-adjust-%`]
    );
    expect((await agent.post(`/api/vouchers/${rows[0].id}/exact-reversal`).send({})).status).toBe(409);
  }, 60_000);

  it("still retires the closing stock transfer and still guards locations", async () => {
    expect(
      (await agent.post("/api/reports/transfer-closing-stock").send({ targetCompanyId: ctx.companyId })).status
    ).toBe(410);
    expect((await agent.delete(`/api/locations/${ctx.locationId}`)).status).toBe(409);
  });
});
