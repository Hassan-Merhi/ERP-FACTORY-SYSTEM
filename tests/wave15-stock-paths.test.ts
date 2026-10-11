/**
 * Wave 15 (B), accounting audit 2026-10: stock path gaps before a perpetual
 * cut-over.
 *
 *   H1  transfer revision approvals (pending and immutable lifecycles) move
 *       value conserved and keep each line's value_moved;
 *   H2  the stock-transfer imports move value conserved, record value_moved,
 *       mark the transfer applied, and refuse a missing source after the cut-over;
 *   H3  a transfer from a location with no stock row creates no value;
 *   C2  a deleted stock document whose lines its delete removed is not restorable;
 *   M5  re-dating a sale re-dates COGS-{id}; crossing the cut-over date is refused;
 *   M9  a merge repoints the stock lines, so a later reversal lands on the kept
 *       item; an item with history is never permanently deleted or purged;
 *   M10 offload cost corrections need Admin/Owner;
 *   M7/M8 factory valuation: live raw-stock rows, legacy order statuses;
 *   wave 11 leftovers: a production into short stock posts its settlement
 *   variance to COGS; activating a sale of a bale-mirror item is refused after
 *   the cut-over; the waste dispatch is one transaction.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { FACTORY_BALE_MIRROR_STOCK } from "../server/services/accounting/perpetualInventory/cutoverRefusal";
import { factoryStockValuation } from "../server/services/accounting/perpetualInventory/factoryValuation";
import { SALE_DATE_CROSSES_CUTOVER } from "../server/services/accounting/perpetualInventory/saleCogs";
import {
  OFFLOAD_COST_CORRECTION_FORBIDDEN_CODE,
  executeContainerOffloadLifecycle,
} from "../server/services/containers/offload-lifecycle/execute";
import { containerUsdRate } from "../server/services/factory/baleCostBasis";
import {
  approveImmutableStockTransferRevision,
  createImmutableStockTransferRevision,
} from "../server/services/immutableStockTransferRevisionLifecycle";
import {
  STOCK_ITEM_HAS_HISTORY_MESSAGE,
  presentStockItemHistoryTables,
  stockItemHistorySqlText,
} from "../server/services/inventory/stockItemHistory";
import { STOCK_DOCUMENT_NOT_RESTORABLE } from "../server/services/inventory/voucherStockReversal";
import {
  approvePendingStockTransferRevision,
  savePendingStockTransferRevision,
} from "../server/services/stockTransferRevisionLifecycle";
import { STOCK_TRANSFER_IMPORT_SOURCE_MISSING } from "../server/routes/stockTransferImportPosting";
import { createStockTransfer } from "../server/storage/stock-ops/transfers-create";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w15b";
const day = (offset: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const today = day(0);

let ctx: TestContext;
let agent: request.SuperAgentTest;
let sequence = 0;
let supplierId: number;

async function newItem(options: { uom?: string; code?: string; openingRate?: string } = {}) {
  sequence += 1;
  const code = options.code ?? `${TEST_PREFIX}-X${sequence}`;
  const [item] = await db
    .insert(schema.stockItems)
    .values({
      companyId: ctx.companyId,
      code,
      name: code,
      uom: options.uom ?? "PCS",
      stockGroupId: ctx.stockGroupId,
      active: true,
      openingRate: options.openingRate ?? "5.00",
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

async function stockRow(locationId: number, stockItemId: number) {
  const { rows } = await pool.query<{ q: string; v: string }>(
    `SELECT quantity::numeric(20,3)::text AS q, total_value::numeric(20,2)::text AS v
       FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
    [locationId, stockItemId]
  );
  return rows[0] ?? null;
}

async function setCutover(effectiveFrom: string | null) {
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [ctx.companyId]);
  if (effectiveFrom) {
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by)
       VALUES ($1, $2, '{}'::jsonb, 'test')`,
      [ctx.companyId, effectiveFrom]
    );
  }
}

async function sell(stockItemId: number, quantity: number): Promise<number> {
  const response = await agent.post("/api/pos/sales").send({
    locationId: ctx.locationId,
    items: [{ stockItemId, quantity, rate: 20 }],
    paymentAccountType: "ledger",
    paymentAccountId: ctx.cashAccountId,
    voucherDate: today,
  });
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  const { rows } = await pool.query(
    `SELECT voucher_id FROM sales_items WHERE stock_item_id = $1 ORDER BY id DESC LIMIT 1`,
    [stockItemId]
  );
  return rows[0].voucher_id as number;
}

/** A posted stock transfer with one line (value_moved recorded). */
async function transferFixture(stockItemId: number, quantity: string, value: string) {
  sequence += 1;
  const [voucher] = await db
    .insert(schema.vouchers)
    .values({
      companyId: ctx.companyId,
      voucherType: "Stock Transfer",
      voucherNumber: `${TEST_PREFIX.toUpperCase()}-T${sequence}`,
      voucherDate: today,
      description: "transfer",
      totalAmount: value,
      currency: "USD",
      optional: false,
      locationId: ctx.locationId,
    })
    .returning();
  const [transfer] = await db
    .insert(schema.stockTransferVouchers)
    .values({
      voucherId: voucher.id,
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      inventoryApplied: true,
    })
    .returning();
  await db.insert(schema.stockTransferItems).values({
    transferId: transfer.id,
    stockItemId,
    sourceLocationId: ctx.locationId,
    quantity,
    rate: (Number(value) / Number(quantity)).toFixed(2),
    totalAmount: value,
    valueMoved: value,
  });
  return { voucherId: voucher.id, transferId: transfer.id };
}

async function lineValueMoved(transferId: number) {
  const { rows } = await pool.query<{ q: string; v: string }>(
    `SELECT quantity::numeric(20,3)::text AS q, value_moved::text AS v FROM stock_transfer_items WHERE transfer_id = $1`,
    [transferId]
  );
  return rows[0];
}

async function usdContainer(stockItemId: number) {
  sequence += 1;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date, charges_total)
     VALUES ($1, $2, $3, 'OTW', $4, '0') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-C${sequence}`, supplierId, today]
  );
  const po = await pool.query<{ id: number }>(
    `INSERT INTO purchase_orders (company_id, po_number, container_id, supplier_id, currency, status, items_total)
     VALUES ($1, $2, $3, $4, 'USD', 'Open', '20.00') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-PO${sequence}`, rows[0].id, supplierId]
  );
  await pool.query(
    `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
     VALUES ($1, $2, 'line', '4', '5', '20.00')`,
    [po.rows[0].id, stockItemId]
  );
  return rows[0].id;
}

async function voucherLines(voucherId: number) {
  const { rows } = await pool.query<{ code: string; d: string; c: string }>(
    `SELECT la.code, ve.debit_amount::text AS d, ve.credit_amount::text AS c
       FROM voucher_entries ve JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE ve.voucher_id = $1 ORDER BY la.code`,
    [voucherId]
  );
  return rows.map((row) => [row.code, row.d, row.c]);
}

async function setRole(role: string) {
  await pool.query(`UPDATE user_company_roles SET role = $1 WHERE user_id = $2 AND company_id = $3`, [
    role,
    ctx.userId,
    ctx.companyId,
  ]);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}SUP`, `${TEST_PREFIX} Supplier`, "w15b@example.test"]
  );
  supplierId = supplier.rows[0].id;
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await pool.query(
    `UPDATE user_company_roles SET can_sell_negative_stock = true WHERE user_id = $1 AND company_id = $2`,
    [ctx.userId, ctx.companyId]
  );
  await setRole("Admin");
}, 120_000);

afterAll(async () => {
  const id = ctx.companyId;
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [id]);
  await pool.query(
    `DELETE FROM stock_transfer_revision_items WHERE revision_id IN (
       SELECT r.id FROM stock_transfer_revisions r JOIN stock_transfer_vouchers t ON t.id = r.transfer_id
         JOIN vouchers v ON v.id = t.voucher_id WHERE v.company_id = $1)`,
    [id]
  );
  await pool.query(
    `DELETE FROM stock_transfer_revisions WHERE transfer_id IN (
       SELECT t.id FROM stock_transfer_vouchers t JOIN vouchers v ON v.id = t.voucher_id WHERE v.company_id = $1)`,
    [id]
  );
  await pool.query(`DELETE FROM stock_item_merge_logs WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM factory_bale_products WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM inventory_negative_layers WHERE company_id = $1`, [id]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120_000);

describe("H1: transfer revision approvals conserve value", () => {
  it("pending lifecycle: an increase moves what the source relieves, a decrease its exact share back", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item.id, "90", "10", "900.00");
    await setStock(ctx.location2Id, item.id, "10", "10", "100.00");
    const { transferId } = await transferFixture(item.id, "10", "100.00");
    const revise = async (userId: string, from: number, to: number) => {
      const pending = await savePendingStockTransferRevision({
        companyId: ctx.companyId,
        transferId,
        userId,
        items: [
          {
            stockItemId: item.id,
            stockItemName: item.code,
            sourceLocationId: ctx.locationId,
            originalQuantity: from,
            newQuantity: to,
          },
        ],
      });
      return approvePendingStockTransferRevision(ctx.companyId, pending.revisionId);
    };

    expect((await revise(`${TEST_PREFIX}-u1`, 10, 15)).transition).toBe("approved");
    expect(await stockRow(ctx.locationId, item.id)).toEqual({ q: "85.000", v: "850.00" });
    expect(await stockRow(ctx.location2Id, item.id)).toEqual({ q: "15.000", v: "150.00" });
    expect(await lineValueMoved(transferId)).toEqual({ q: "15.000", v: "150.00" });

    // 15 -> 6 returns 9/15 of the 150.00 the line moved.
    await revise(`${TEST_PREFIX}-u2`, 15, 6);
    expect(await stockRow(ctx.locationId, item.id)).toEqual({ q: "94.000", v: "940.00" });
    expect(await stockRow(ctx.location2Id, item.id)).toEqual({ q: "6.000", v: "60.00" });
    expect(await lineValueMoved(transferId)).toEqual({ q: "6.000", v: "60.00" });
  }, 60_000);

  it("immutable lifecycle: the destination receives exactly what the source relieved", async () => {
    const item = await newItem();
    // 6 units worth 6.67 left at the source (average 1.1116667, not the line's 1.11).
    await setStock(ctx.locationId, item.id, "6", "1.1116667", "6.67");
    await setStock(ctx.location2Id, item.id, "3", "1.11", "3.33");
    const { transferId } = await transferFixture(item.id, "3", "3.33");
    const revision = await createImmutableStockTransferRevision({
      companyId: ctx.companyId,
      transferId,
      userId: `${TEST_PREFIX}-u3`,
      pending: true,
      items: [
        {
          stockItemId: item.id,
          stockItemName: item.code,
          sourceLocationId: ctx.locationId,
          originalQuantity: 3,
          newQuantity: 6,
        },
      ],
    });
    const approved = await approveImmutableStockTransferRevision(ctx.companyId, revision.revisionId, ctx.userId);
    expect(approved.transition).toBe("approved");
    const source = await stockRow(ctx.locationId, item.id);
    const destination = await stockRow(ctx.location2Id, item.id);
    expect(source?.q).toBe("3.000");
    expect(destination?.q).toBe("6.000");
    // Nothing created or lost, and the line moved exactly what the destination holds.
    expect((Number(source!.v) + Number(destination!.v)).toFixed(2)).toBe("10.00");
    expect((await lineValueMoved(transferId)).v).toBe(destination!.v);
  }, 60_000);
});

describe("H2/H3: stock transfer imports and missing sources", () => {
  it("the single-source import moves the exact relieved value and records value_moved", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item.id, "3", "3.3333333", "10.00");
    const response = await agent.post("/api/stock-transfer-import/import").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      transferDate: today,
      items: [{ barcode: item.code, quantity: 3 }],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    // 3 × the 2dp rate (3.33) would have received 9.99 for the 10.00 relieved.
    expect(await stockRow(ctx.location2Id, item.id)).toEqual({ q: "3.000", v: "10.00" });
    expect(await stockRow(ctx.locationId, item.id)).toEqual({ q: "0.000", v: "0.00" });
    const { rows } = await pool.query(
      `SELECT sti.value_moved::text AS v, stv.inventory_applied AS applied
         FROM stock_transfer_items sti JOIN stock_transfer_vouchers stv ON stv.id = sti.transfer_id
        WHERE sti.stock_item_id = $1`,
      [item.id]
    );
    expect(rows).toEqual([{ v: "10.00", applied: true }]);
  }, 60_000);

  it("after the cut-over the multi-source import refuses a source with no stock row", async () => {
    const item = await newItem();
    await setCutover("2026-01-01");
    try {
      const response = await agent.post("/api/stock-transfer-import/import-multi-source").send({
        destinationLocationId: ctx.location2Id,
        transferDate: today,
        items: [{ stockItemId: item.id, sourceLocationId: ctx.locationId, quantity: 2 }],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.code).toBe(STOCK_TRANSFER_IMPORT_SOURCE_MISSING);
      expect(await stockRow(ctx.locationId, item.id)).toBeNull();
      expect(await stockRow(ctx.location2Id, item.id)).toBeNull();
    } finally {
      await setCutover(null);
    }
  }, 60_000);

  it("a transfer from a location with no row keeps the shortage's value: nothing is created", async () => {
    const item = await newItem();
    const [voucher] = await db
      .insert(schema.vouchers)
      .values({
        companyId: ctx.companyId,
        voucherType: "Stock Transfer",
        voucherNumber: `${TEST_PREFIX.toUpperCase()}-MS`,
        voucherDate: today,
        totalAmount: "0",
        currency: "USD",
        locationId: ctx.locationId,
      })
      .returning();
    await createStockTransfer(voucher.id, ctx.location2Id, "", [
      { sourceLocationId: ctx.locationId, stockItemId: item.id, quantity: "4", rate: "12.34" },
    ]);
    expect(await stockRow(ctx.locationId, item.id)).toEqual({ q: "-4.000", v: "-49.36" });
    expect(await stockRow(ctx.location2Id, item.id)).toEqual({ q: "4.000", v: "49.36" });
  }, 60_000);
});

describe("C2: restoring a deleted stock document", () => {
  it("refuses a stock adjustment and a sale whose delete removed their stock lines", async () => {
    const produced = await newItem();
    const adjustment = await agent.post("/api/stock-adjustments").send({
      voucher: { voucherDate: today },
      locationId: ctx.locationId,
      adjustmentType: "Production",
      items: [{ stockItemId: produced.id, quantity: 2, rate: 5 }],
    });
    expect(adjustment.status, JSON.stringify(adjustment.body)).toBe(201);
    const sold = await newItem();
    await setStock(ctx.locationId, sold.id, "5", "4", "20.00");
    const saleId = await sell(sold.id, 1);

    for (const voucherId of [adjustment.body.voucher.id as number, saleId]) {
      expect((await agent.delete(`/api/vouchers/${voucherId}`)).status).toBe(200);
      const restore = await agent.post(`/api/deleted-items/voucher/${voucherId}/restore`);
      expect(restore.status, JSON.stringify(restore.body)).toBe(409);
      expect(restore.body.code).toBe(STOCK_DOCUMENT_NOT_RESTORABLE);
      const { rows } = await pool.query(`SELECT deleted_at FROM vouchers WHERE id = $1`, [voucherId]);
      expect(rows[0].deleted_at).not.toBeNull();
    }
    // The reversals stand: the produced stock left, the sold unit came back.
    expect(await stockRow(ctx.locationId, produced.id)).toEqual({ q: "0.000", v: "0.00" });
    expect(await stockRow(ctx.locationId, sold.id)).toEqual({ q: "5.000", v: "20.00" });
  }, 60_000);
});

describe("M5: re-dating a sale", () => {
  it("moves COGS-{id} with the sale and refuses a date across the cut-over", async () => {
    await setCutover("2026-01-01");
    try {
      const item = await newItem();
      await setStock(ctx.locationId, item.id, "5", "4", "20.00");
      const saleId = await sell(item.id, 1);
      const cogsDate = async () =>
        (
          await pool.query(
            `SELECT voucher_date::text AS d FROM vouchers WHERE company_id = $1 AND voucher_number = $2`,
            [ctx.companyId, `COGS-${saleId}`]
          )
        ).rows[0]?.d;
      expect(await cogsDate()).toBe(today);

      const patched = await agent.patch(`/api/vouchers/${saleId}`).send({ voucherDate: day(-1) });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect(await cogsDate()).toBe(day(-1));

      const entries = (
        await pool.query(
          `SELECT ledger_account_id AS "ledgerAccountId", debit_amount::text AS "debitAmount",
                  credit_amount::text AS "creditAmount", narration
             FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
          [saleId]
        )
      ).rows;
      const put = await agent
        .put(`/api/vouchers/${saleId}/with-entries`)
        .send({ voucher: { voucherType: "Sales", voucherDate: day(-2) }, entries });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      expect(await cogsDate()).toBe(day(-2));

      const crossing = await agent.patch(`/api/vouchers/${saleId}`).send({ voucherDate: "2025-12-31" });
      expect(crossing.status, JSON.stringify(crossing.body)).toBe(409);
      expect(crossing.body.code).toBe(SALE_DATE_CROSSES_CUTOVER);
      const { rows } = await pool.query(`SELECT voucher_date::text AS d FROM vouchers WHERE id = $1`, [saleId]);
      expect(rows[0].d).toBe(day(-2));
      expect(await cogsDate()).toBe(day(-2));
    } finally {
      await setCutover(null);
    }
  }, 60_000);
});

describe("M9: merge, permanent delete and purge keep stock history", () => {
  it("a merge repoints the sale line, so deleting the sale returns the stock to the kept item", async () => {
    const kept = await newItem();
    const duplicate = await newItem();
    await setStock(ctx.locationId, duplicate.id, "4", "5", "20.00");
    const saleId = await sell(duplicate.id, 1);
    const merged = await agent
      .post(`/api/stock-items/${kept.id}/merge`)
      .send({ duplicateId: duplicate.id, confirm: "MERGE" });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    const { rows } = await pool.query(`SELECT stock_item_id FROM sales_items WHERE voucher_id = $1`, [saleId]);
    expect(rows).toEqual([{ stock_item_id: kept.id }]);

    expect((await agent.delete(`/api/vouchers/${saleId}`)).status).toBe(200);
    expect(await stockRow(ctx.locationId, kept.id)).toEqual({ q: "4.000", v: "20.00" });
    expect(await stockRow(ctx.locationId, duplicate.id)).toBeNull();

    // The merged item keeps its stock movements: never permanently deleted, never purged.
    const refused = await agent.delete(`/api/deleted-items/stockItem/${duplicate.id}/permanent`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.message).toBe(STOCK_ITEM_HAS_HISTORY_MESSAGE);

    const unused = await newItem();
    const unusedPurgeable = await newItem();
    await pool.query(`UPDATE stock_items SET deleted_at = now(), active = false WHERE id = ANY($1)`, [
      [unused.id, unusedPurgeable.id],
    ]);
    const history = stockItemHistorySqlText(await presentStockItemHistoryTables(db), "si.id");
    const purgeable = await pool.query(
      `SELECT si.id FROM stock_items si WHERE si.id = ANY($1) AND NOT EXISTS (${history}) ORDER BY si.id`,
      [[duplicate.id, unused.id, unusedPurgeable.id]]
    );
    expect(purgeable.rows.map((row) => row.id)).toEqual([unused.id, unusedPurgeable.id]);

    const removed = await agent.delete(`/api/deleted-items/stockItem/${unused.id}/permanent`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const gone = await pool.query(`SELECT id FROM stock_items WHERE id = $1`, [unused.id]);
    expect(gone.rows).toEqual([]);
  }, 90_000);
});

describe("M10: offload cost corrections", () => {
  it("need Admin or Owner; the offload itself is unchanged", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item.id, "2", "3", "6.00");
    const containerId = await usdContainer(item.id);
    const offload = (actorRole: string) =>
      executeContainerOffloadLifecycle({
        companyId: ctx.companyId,
        containerId,
        mode: "create-or-replace",
        locationId: ctx.locationId,
        offloadDate: today,
        duties: "0",
        officeCharges: "0",
        transferCharges: "0",
        transportFees: "0",
        inventoryCostCorrections: [{ stockItemId: item.id, correctRate: 4 }],
        actorRole,
      });
    await expect(offload("Manager")).rejects.toMatchObject({
      status: 403,
      code: OFFLOAD_COST_CORRECTION_FORBIDDEN_CODE,
    });
    expect(await stockRow(ctx.locationId, item.id)).toEqual({ q: "2.000", v: "6.00" });
    await offload("Admin");
    // 2 on hand re-costed at 4 (8.00) plus the 4 received at 5 (20.00).
    expect(await stockRow(ctx.locationId, item.id)).toEqual({ q: "6.000", v: "28.00" });
  }, 60_000);
});

describe("wave 11 leftovers", () => {
  it("a production into short stock posts its settlement variance to COGS", async () => {
    await setCutover("2026-01-01");
    try {
      const item = await newItem();
      // Sold 2 short at the provisional 3.00; produced 2 at 5.00.
      await setStock(ctx.locationId, item.id, "-2", "3", "-6.00");
      const response = await agent.post("/api/stock-adjustments").send({
        voucher: { voucherDate: today },
        locationId: ctx.locationId,
        adjustmentType: "Production",
        items: [{ stockItemId: item.id, quantity: 2, rate: 5 }],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(await voucherLines(response.body.voucher.id)).toEqual([
        ["COGS", "4.00", "0.00"],
        ["INVENTORY", "6.00", "0.00"],
        ["STOCK_ADJUSTMENT", "0.00", "10.00"],
      ]);
    } finally {
      await setCutover(null);
    }
  }, 60_000);

  it("activating a suspended sale of a bale-mirror item is refused after the cut-over", async () => {
    const mirror = await newItem({ uom: "BALE", code: `${TEST_PREFIX.toUpperCase()}-MB1` });
    await pool.query(
      `INSERT INTO factory_bale_products (company_id, code, name, production_price, selling_price)
       VALUES ($1, $2::varchar, $2::text, '10', '20')`,
      [ctx.companyId, mirror.code]
    );
    await setStock(ctx.locationId, mirror.id, "5", "0", "0.00");
    const saleId = await sell(mirror.id, 1);
    expect((await agent.patch(`/api/vouchers/${saleId}/optional`).send({ optional: true })).status).toBe(200);
    await setCutover("2026-01-01");
    try {
      for (const activate of [
        () => agent.patch(`/api/vouchers/${saleId}/optional`).send({ optional: false }),
        () => agent.patch(`/api/vouchers/${saleId}`).send({ optional: false }),
      ]) {
        const response = await activate();
        expect(response.status, JSON.stringify(response.body)).toBe(409);
        expect(response.body.code).toBe(FACTORY_BALE_MIRROR_STOCK);
      }
      expect(await stockRow(ctx.locationId, mirror.id)).toEqual({ q: "5.000", v: "0.00" });
    } finally {
      await setCutover(null);
    }
  }, 60_000);

  it("a waste dispatch writes its voucher, adjustment and dispatch together or not at all", async () => {
    const vouchersLike = async () =>
      (
        await pool.query(
          `SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'WD-%'`,
          [ctx.companyId]
        )
      ).rows[0].n as number;
    // No stock and no opening rate: the adjustment fails, so nothing may remain.
    const unpriced = await newItem({ openingRate: "0" });
    const failed = await agent.post("/api/waste-dispatches").send({
      locationId: ctx.locationId,
      dispatchDate: today,
      items: [{ stockItemId: unpriced.id, quantity: 1 }],
    });
    expect(failed.status).toBe(500);
    expect(await vouchersLike()).toBe(0);

    const item = await newItem();
    await setStock(ctx.locationId, item.id, "5", "2", "10.00");
    const created = await agent.post("/api/waste-dispatches").send({
      locationId: ctx.locationId,
      dispatchDate: today,
      items: [{ stockItemId: item.id, quantity: 2 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const { rows } = await pool.query(
      `SELECT v.voucher_type, sav.adjustment_type, wd.total_amount::text AS total
         FROM waste_dispatches wd JOIN vouchers v ON v.id = wd.voucher_id
         JOIN stock_adjustment_vouchers sav ON sav.voucher_id = v.id
        WHERE wd.id = $1`,
      [created.body.id]
    );
    expect(rows).toEqual([{ voucher_type: "Consumption", adjustment_type: "Consumption", total: "4.00" }]);
    expect(await stockRow(ctx.locationId, item.id)).toEqual({ q: "3.000", v: "6.00" });
  }, 60_000);
});

describe("M7/M8: factory valuation", () => {
  it("prices a container from its live raw-stock rows only", async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO factory_containers (company_id, container_number, currency_code) VALUES ($1, $2, 'USD') RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-FC1`]
    );
    const containerId = rows[0].id;
    await pool.query(
      `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, cost_per_kg, cost_per_kg_usd, deleted_at)
       VALUES ($1, $2, 10, 9, 9, now()), ($1, $2, 10, 2, 2, NULL)`,
      [ctx.companyId, containerId]
    );
    expect((await containerUsdRate(db, ctx.companyId, containerId))?.toFixed(2)).toBe("2.00");
  }, 60_000);

  it("treats bales on legacy closed orders as gone and bales on draft orders as stock", async () => {
    const customer = await pool.query<{ id: number }>(
      `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2::varchar, $2::text) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-CUS`]
    );
    const before = await factoryStockValuation(db, ctx.companyId);
    const orderWithBale = async (orderStatus: string, baleStatus: string, cost: string) => {
      sequence += 1;
      const order = await pool.query<{ id: number }>(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status) VALUES ($1, $2, $3, $4) RETURNING id`,
        [ctx.companyId, customer.rows[0].id, today, orderStatus]
      );
      const bale = await pool.query<{ id: number }>(
        `INSERT INTO factory_bales (company_id, bale_code, reference_number, weight_kg, status, total_cost)
         VALUES ($1, $2::varchar, $2::varchar, 25, $3, $4) RETURNING id`,
        [ctx.companyId, `${TEST_PREFIX}-B${sequence}`, baleStatus, cost]
      );
      await pool.query(
        `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used)
         VALUES ($1, $2, $3, $4, 25, 1)`,
        [order.rows[0].id, bale.rows[0].id, `${TEST_PREFIX}-B${sequence}`, ctx.locationId]
      );
    };
    await orderWithBale("DISPATCHED", "SOLD", "11.00");
    await orderWithBale("INVOICED", "IN_STOCK", "13.00");
    await orderWithBale("DRAFT", "SOLD", "7.00");
    const after = await factoryStockValuation(db, ctx.companyId);
    // Only the draft order's sold bale is still stock (sold, not invoiced).
    expect(after.finished.minus(before.finished).toFixed(2)).toBe("7.00");
    expect(after.soldNotInvoiced.bales - before.soldNotInvoiced.bales).toBe(1);
    expect(after.reservedForOrders.bales - before.reservedForOrders.bales).toBe(1);
  }, 60_000);
});
