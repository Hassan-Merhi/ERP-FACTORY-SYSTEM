/**
 * GET /api/vouchers/:id/view-entries detail rows for purchase, stock
 * adjustment and stock transfer vouchers, against PostgreSQL in one
 * rolled-back transaction per test, including the POS cost redaction of each
 * shape and the empty-transfer and plain-voucher fallbacks.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { voucher, ledger, line, item, view } from "./helpers/voucherReadFixture";

type Row = Record<string, unknown>;

async function purchase(w: FactoryWorld) {
  const id = await voucher(w, "Purchase");
  await line(w, id, { ledger_account_id: await ledger(w, "Purchases", "Expense") }, "50");
  const supplier = await w.one(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Acme', 'a@x.io') RETURNING id`,
    [w.companyId, `${w.tag}-SUP`]
  );
  const container = await w.one(
    `INSERT INTO containers (company_id, container_number, supplier_id, import_date) VALUES ($1, $2, $3, '2026-04-01')
     RETURNING id`,
    [w.companyId, `${w.tag}-CN`, supplier]
  );
  const po = await w.one(
    `INSERT INTO purchase_orders (company_id, po_number, supplier_id, container_id, voucher_id, freight, items_total)
     VALUES ($1, $2, $3, $4, $5, 7, 50) RETURNING id`,
    [w.companyId, `${w.tag}-PO`, supplier, container, id]
  );
  return { id, po, supplier, container };
}

describe("view-entries: purchase vouchers", () => {
  it("adds the linked PO lines and PO metadata for Admin", async () => {
    await withFactoryWorld(async (w) => {
      const { id, po, container } = await purchase(w);
      const jeans = await item(w, "Jeans");
      await w.q(
        `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total) VALUES ($1, $2, 'J', 5, 10, 50)`,
        [po, jeans]
      );
      const res = await view(w, id);
      expect(res.status).toBe(200);
      expect(res.body.purchaseOrder).toMatchObject({
        id: po,
        poNumber: `${w.tag}-PO`,
        supplierName: "Acme",
        containerId: container,
        containerNumber: `${w.tag}-CN`,
      });
      expect(res.body.purchaseOrder.freight).not.toBeNull();
      const lineRow = res.body.entries.find((e: Row) => e.isPurchaseItem);
      expect(lineRow).toMatchObject({ stockItemName: "Jeans", purchaseOrderId: po, creditAmount: "0" });
      expect(lineRow.rate).not.toBeNull();
      expect(res.body.entries.find((e: Row) => !e.isStockItem).debitAmount).toBe("50.00");
    });
  });

  it("redacts PO cost, totals and ledger amounts for POS users", async () => {
    await withFactoryWorld(async (w) => {
      const { id, po } = await purchase(w);
      await w.q(
        `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total) VALUES ($1, $2, 'J', 5, 10, 50)`,
        [po, await item(w, "Jeans")]
      );
      const res = await view(w, id, await w.agentFor("POS"));
      expect(res.status).toBe(200);
      expect(res.body.purchaseOrder).toMatchObject({ itemsTotal: null, freight: null, discount: null });
      const lineRow = res.body.entries.find((e: Row) => e.isPurchaseItem);
      expect(lineRow).toMatchObject({ rate: null, totalAmount: null, debitAmount: "0" });
      expect(lineRow.narration).not.toMatch(/@/);
      const ledgerRow = res.body.entries.find((e: Row) => !e.isStockItem);
      expect(ledgerRow).toMatchObject({ debitAmount: "0", creditAmount: "0" });
    });
  });

  it("returns plain lines for a PO without line items and redacts them for POS", async () => {
    await withFactoryWorld(async (w) => {
      const { id } = await purchase(w);
      const admin = await view(w, id);
      expect(admin.body).toHaveLength(1);
      expect(admin.body[0].debitAmount).toBe("50.00");
      const pos = await view(w, id, await w.agentFor("POS"));
      expect(pos.body).toEqual([expect.objectContaining({ debitAmount: "0", creditAmount: "0" })]);
    });
  });
});

describe("view-entries: stock adjustments", () => {
  async function adjustment(w: FactoryWorld, type: string, quantities: string[]) {
    const id = await voucher(w, type);
    await line(w, id, { ledger_account_id: await ledger(w) }, "1");
    const adj = await w.one(
      `INSERT INTO stock_adjustment_vouchers (voucher_id, location_id, adjustment_type) VALUES ($1, $2, $3) RETURNING id`,
      [id, w.locationId, type]
    );
    for (const qty of quantities) {
      await w.q(
        `INSERT INTO stock_adjustment_items (adjustment_id, stock_item_id, quantity, rate, total_amount) VALUES ($1, $2, $3, 4, 8)`,
        [adj, await item(w, `Bale ${qty} ${type}`), qty]
      );
    }
    return id;
  }

  it("labels Mixed lines by quantity sign and posts production as debit, consumption as credit", async () => {
    await withFactoryWorld(async (w) => {
      const id = await adjustment(w, "Mixed", ["2", "-2"]);
      const res = await view(w, id);
      expect(res.status).toBe(200);
      const byType = Object.fromEntries(res.body.map((r: Row) => [r.adjustmentType, r]));
      expect(byType.Production).toMatchObject({ debitAmount: "8.00", creditAmount: "0" });
      expect(byType.Consumption).toMatchObject({ debitAmount: "0", creditAmount: "8.00" });
      expect(String(byType.Consumption.narration)).toMatch(/^Consumption of 2 x Bale -2 Mixed @ \$/);
    });
  });

  it("returns Production and Consumption rows, redacted for POS", async () => {
    await withFactoryWorld(async (w) => {
      const production = await adjustment(w, "Production", ["3"]);
      expect((await view(w, production)).body[0]).toMatchObject({ adjustmentType: "Production", debitAmount: "8.00" });
      const consumption = await adjustment(w, "Consumption", ["3"]);
      const pos = await w.agentFor("POS");
      const res = await view(w, consumption, pos);
      expect(res.body[0]).toMatchObject({ adjustmentType: "Consumption", rate: null, totalAmount: null });
      expect(res.body[0]).toMatchObject({ debitAmount: "0", creditAmount: "0" });
    });
  });

  it("falls back to ledger lines when the adjustment record or its items are missing", async () => {
    await withFactoryWorld(async (w) => {
      const empty = await adjustment(w, "Production", []);
      expect((await view(w, empty)).body).toEqual([expect.objectContaining({ debitAmount: "1.00" })]);
      const bare = await voucher(w, "Consumption");
      expect((await view(w, bare)).body).toEqual([]);
    });
  });
});

describe("view-entries: stock transfers", () => {
  async function transfer(w: FactoryWorld, type: string, withItems: boolean) {
    const id = await voucher(w, type);
    const destination = await w.one(
      `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop') RETURNING id`,
      [w.companyId, `${w.tag}D${type.length}`]
    );
    const second = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Depot') RETURNING id`, [
      w.companyId,
      `${w.tag}S${type.length}`,
    ]);
    const tv = await w.one(
      `INSERT INTO stock_transfer_vouchers (voucher_id, source_location_id, destination_location_id) VALUES ($1, $2, $3)
       RETURNING id`,
      [id, w.locationId, destination]
    );
    if (withItems) {
      await w.q(
        `INSERT INTO stock_transfer_items (transfer_id, stock_item_id, quantity, rate, total_amount, source_location_id)
         VALUES ($1, $2, 2, 5, 10, $3), ($1, $4, 1, 5, 5, NULL)`,
        [tv, await item(w, "Coat"), second, await item(w, "Hat")]
      );
    }
    return id;
  }

  it("names each line's source location and redacts amounts for POS", async () => {
    await withFactoryWorld(async (w) => {
      const id = await transfer(w, "Stock Transfer", true);
      const res = await view(w, id);
      expect(res.status).toBe(200);
      const byName = Object.fromEntries(res.body.map((r: Row) => [r.stockItemName, r]));
      expect(byName.Coat).toMatchObject({ sourceLocationName: "Depot", creditAmount: "10.00" });
      expect(byName.Hat).toMatchObject({ sourceLocationName: "Yard", creditAmount: "5.00" });
      const pos = await view(w, id, await w.agentFor("POS"));
      expect(pos.body.every((r: Row) => r.rate === null && r.creditAmount === "0")).toBe(true);
      expect(String(pos.body[0].narration)).toMatch(/^Transfer of /);
    });
  });

  it("returns an empty list for a transfer without items or without a transfer record", async () => {
    await withFactoryWorld(async (w) => {
      expect((await view(w, await transfer(w, "Transfer", false))).body).toEqual([]);
      const bare = await voucher(w, "StockTransfer");
      await line(w, bare, { ledger_account_id: await ledger(w) }, "3");
      expect((await view(w, bare)).body).toEqual([]);
    });
  });

  it("leaves the source location name blank when neither the transfer nor the line has one", async () => {
    await withFactoryWorld(async (w) => {
      const id = await voucher(w, "Stock Transfer");
      const tv = await w.one(
        `INSERT INTO stock_transfer_vouchers (voucher_id, destination_location_id) VALUES ($1, $2) RETURNING id`,
        [id, w.locationId]
      );
      await w.q(
        `INSERT INTO stock_transfer_items (transfer_id, stock_item_id, quantity, rate, total_amount) VALUES ($1, $2, 1, 2, 2)`,
        [tv, await item(w, "Scarf")]
      );
      const res = await view(w, id);
      expect(res.body).toEqual([expect.objectContaining({ stockItemName: "Scarf", sourceLocationName: "" })]);
    });
  });
});

describe("view-entries: sales without a price list", () => {
  it("leaves the configured price empty when the item has no list price at any location", async () => {
    await withFactoryWorld(async (w) => {
      const id = await voucher(w, "Sales");
      await w.q(
        `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit)
         VALUES ($1, $2, 1, 9, 4, 9, 4, 5)`,
        [id, await item(w, "Belt", null)]
      );
      const [row] = (await view(w, id)).body;
      expect(row).toMatchObject({ stockItemName: "Belt", configuredPrice: null, hassansProfit: null });
      expect(row.costPrice).not.toBeNull();
    });
  });
});
