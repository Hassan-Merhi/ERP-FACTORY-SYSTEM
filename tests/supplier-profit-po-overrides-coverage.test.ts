/**
 * Supplier Profit Check manual PO / average price overrides
 * (supplier-profit-check/po-overrides.ts) through the real HTTP app in one
 * rolled-back transaction per test. Pins the supplier scope (own company and
 * explicitly linked parent only), stock item scope, price validation, partial
 * updates that keep the omitted field, explicit null resets that delete the
 * row, and the bulk upsert in all three column shapes - with nothing written
 * on any refusal.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/supplier-profit-check/po-overrides";

async function world(w: FactoryWorld) {
  const supplier = (companyId: number, code: string) =>
    w.one(
      `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2::varchar, $2::text, 'x@example.test') RETURNING id`,
      [companyId, `${w.tag}${code}`]
    );
  const item = (companyId: number, code: string) =>
    w.one(
      `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2::varchar, $2::text, 'PCS') RETURNING id`,
      [companyId, `${w.tag}${code}`]
    );
  const parent = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
    `${w.tag}P`,
  ]);
  const stranger = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
    `${w.tag}S`,
  ]);
  await w.q(`UPDATE companies SET parent_company_id = $1 WHERE id = $2`, [parent, w.companyId]);
  return {
    own: await supplier(w.companyId, "SUP"),
    parentSupplier: await supplier(parent, "PSUP"),
    foreignSupplier: await supplier(stranger, "FSUP"),
    itemA: await item(w.companyId, "A"),
    itemB: await item(w.companyId, "B"),
    itemC: await item(w.companyId, "C"),
    foreignItem: await item(stranger, "F"),
  };
}

const rows = (w: FactoryWorld, supplierId: number) =>
  w.q<{ stock_item_id: number; po_price: string | null; avg_price: string | null }>(
    `SELECT stock_item_id, po_price::text, avg_price::text FROM supplier_profit_po_overrides
      WHERE supplier_id = $1 ORDER BY stock_item_id`,
    [supplierId]
  );

describe("single PO override", () => {
  it("validates input and scope without writing", async () => {
    await withFactoryWorld(async (w) => {
      const f = await world(w);
      const put = (body: object) => w.agent.put(URL).send(body);
      expect((await put({ supplierId: "x", stockItemId: f.itemA, poPrice: 1 })).status).toBe(400);
      expect((await put({ supplierId: f.own, stockItemId: f.itemA })).body.message).toBe("No override field supplied");
      expect((await put({ supplierId: f.foreignSupplier, stockItemId: f.itemA, poPrice: 1 })).status).toBe(404);
      const item = await put({ supplierId: f.own, stockItemId: f.foreignItem, poPrice: 1 });
      expect(item.status).toBe(404);
      expect(item.body.message).toBe("Stock item not found");
      const price = await put({ supplierId: f.own, stockItemId: f.itemA, poPrice: -2 });
      expect(price.status).toBe(400);
      expect(price.body.message).toContain("Price must");
      expect(await rows(w, f.own)).toEqual([]);
    });
  });

  it("keeps the omitted field, resets with null and deletes an empty override", async () => {
    await withFactoryWorld(async (w) => {
      const f = await world(w);
      const put = (body: object) =>
        w.agent.put(URL).send({ supplierId: f.parentSupplier, stockItemId: f.itemA, ...body });
      expect((await put({ poPrice: "12.5", avgPrice: 10 })).status).toBe(200);
      await put({ avgPrice: 11 });
      expect(await rows(w, f.parentSupplier)).toEqual([
        { stock_item_id: f.itemA, po_price: "12.5000", avg_price: "11.0000" },
      ]);
      await put({ poPrice: null });
      expect(await rows(w, f.parentSupplier)).toEqual([
        { stock_item_id: f.itemA, po_price: null, avg_price: "11.0000" },
      ]);
      const listed = await w.agent.get(URL).query({ supplierId: f.parentSupplier });
      expect(listed.body).toEqual([{ stockItemId: f.itemA, poPrice: null, avgPrice: "11.0000" }]);
      await put({ avgPrice: "" });
      expect(await rows(w, f.parentSupplier)).toEqual([]);
    });
  });
});

describe("listing PO overrides", () => {
  it("requires a supplier in scope and hides deleted items", async () => {
    await withFactoryWorld(async (w) => {
      const f = await world(w);
      expect((await w.agent.get(URL)).status).toBe(400);
      expect((await w.agent.get(URL).query({ supplierId: f.foreignSupplier })).status).toBe(404);
      await w.q(
        `INSERT INTO supplier_profit_po_overrides (supplier_id, stock_item_id, po_price) VALUES ($1, $2, 3), ($1, $3, 4)`,
        [f.own, f.itemA, f.itemB]
      );
      await w.q(`UPDATE stock_items SET deleted_at = now() WHERE id = $1`, [f.itemB]);
      const res = await w.agent.get(URL).query({ supplierId: f.own });
      expect(res.body).toEqual([{ stockItemId: f.itemA, poPrice: "3.0000", avgPrice: null }]);
    });
  });
});

describe("bulk PO overrides", () => {
  it("refuses malformed, oversized, out-of-scope and invalid-price batches without writing", async () => {
    await withFactoryWorld(async (w) => {
      const f = await world(w);
      const bulk = (body: object) => w.agent.put(`${URL}/bulk`).send(body);
      expect((await bulk({ supplierId: f.own, overrides: "x" })).status).toBe(400);
      const many = new Array(5001).fill(0);
      expect((await bulk({ supplierId: f.own, overrides: many })).body.message).toBe("Too many overrides");
      expect((await bulk({ supplierId: f.foreignSupplier, overrides: [] })).status).toBe(404);
      expect((await bulk({ supplierId: f.own, overrides: [] })).body).toEqual({ ok: true });
      expect((await bulk({ supplierId: f.own, overrides: [{ stockItemId: "x", poPrice: 1 }] })).status).toBe(400);
      const noField = await bulk({ supplierId: f.own, overrides: [{ stockItemId: f.itemA }] });
      expect(noField.body.message).toContain("poPrice and/or avgPrice");
      const price = await bulk({ supplierId: f.own, overrides: [{ stockItemId: f.itemA, avgPrice: "abc" }] });
      expect(price.status).toBe(400);
      const foreign = await bulk({ supplierId: f.own, overrides: [{ stockItemId: f.foreignItem, poPrice: 1 }] });
      expect(foreign.body.message).toContain("invalid for the active company");
      expect(await rows(w, f.own)).toEqual([]);
    });
  });

  it("upserts both, PO-only and average-only rows and drops rows reset to null", async () => {
    await withFactoryWorld(async (w) => {
      const f = await world(w);
      await w.q(
        `INSERT INTO supplier_profit_po_overrides (supplier_id, stock_item_id, po_price, avg_price)
         VALUES ($1, $2, 5, 6), ($1, $3, 7, 8)`,
        [f.own, f.itemB, f.itemC]
      );
      const res = await w.agent.put(`${URL}/bulk`).send({
        supplierId: f.own,
        overrides: [
          { stockItemId: f.itemA, poPrice: 1, avgPrice: 2 },
          { stockItemId: f.itemB, poPrice: 9 },
          { stockItemId: f.itemC, avgPrice: null },
        ],
      });
      expect(res.status).toBe(200);
      expect(await rows(w, f.own)).toEqual([
        { stock_item_id: f.itemA, po_price: "1.0000", avg_price: "2.0000" },
        { stock_item_id: f.itemB, po_price: "9.0000", avg_price: "6.0000" },
        { stock_item_id: f.itemC, po_price: "7.0000", avg_price: null },
      ]);
      await w.agent.put(`${URL}/bulk`).send({
        supplierId: f.own,
        overrides: [{ stockItemId: f.itemC, poPrice: null, avgPrice: null }],
      });
      expect((await rows(w, f.own)).map((r) => r.stock_item_id)).toEqual([f.itemA, f.itemB]);
    });
  });
});
