/**
 * Supplier Profit Check proforma persistence
 * (server/routes/supplier-profit-check/proforma.ts) over HTTP against
 * PostgreSQL, one rolled-back company per test.
 *
 * Pinned: save refuses a bad supplier id, no items, another company's
 * supplier, an item without a code and a request with no positive quantity,
 * writing nothing; resolved codes and aliases collapse onto the canonical
 * stock item with summed quantity and quantity-weighted price and weight,
 * a PO override wins over supplied prices, unresolved codes stay raw lines;
 * a blank reference is generated. Update refuses a bad id, a non-array body,
 * another company's proforma and a proforma whose supplier is out of scope,
 * and replaces lines (an empty list clears them).
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { otherCompany } from "./helpers/voucherReadFixture";

const SAVE = "/api/supplier-profit-check/save-proforma";
const update = (id: number | string) => `/api/supplier-profit-check/proforma/${id}/update-items`;

async function world(w: FactoryWorld) {
  const supplier = (companyId: number, code: string) =>
    w.one(
      `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2::varchar, $2::text, 'x@example.test') RETURNING id`,
      [companyId, `${w.tag}${code}`]
    );
  const item = (code: string, name: string) =>
    w.one(`INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, $3, 'PCS') RETURNING id`, [
      w.companyId,
      code,
      name,
    ]);
  const other = await otherCompany(w);
  const own = await supplier(w.companyId, "SUP");
  const itemA = await item(`${w.tag}A`, "Shirts A");
  const itemB = await item(`${w.tag}B`, "Shoes B");
  await w.q(`INSERT INTO stock_item_code_aliases (company_id, stock_item_id, alias_code) VALUES ($1, $2, $3)`, [
    w.companyId,
    itemA,
    `${w.tag}ALIAS`,
  ]);
  return { own, foreignSupplier: await supplier(other, "FSUP"), other, itemA, itemB };
}

const lines = (w: FactoryWorld, proformaId: number) =>
  w.q(
    `SELECT barcode, item_name, qty, weight_per_bale::numeric::text AS weight, price_per_bale::numeric::text AS price
       FROM supplier_proforma_lines WHERE proforma_id = $1 ORDER BY barcode`,
    [proformaId]
  );

describe("save proforma", () => {
  it("refuses bad input and out-of-scope suppliers without writing", () =>
    withFactoryWorld(async (w) => {
      const f = await world(w);
      const item = { code: `${w.tag}A`, qty: 1 };
      const cases: Array<[Record<string, unknown>, number, RegExp]> = [
        [{ supplierId: "x", items: [item] }, 400, /supplierId and items required/],
        [{ supplierId: f.own, items: [] }, 400, /supplierId and items required/],
        [{ supplierId: f.own }, 400, /supplierId and items required/],
        [{ supplierId: f.foreignSupplier, items: [item] }, 404, /Supplier not found/],
        [{ supplierId: f.own, items: [{ qty: 2 }] }, 400, /requires a code/],
        [
          {
            supplierId: f.own,
            items: [
              { code: "X", qty: 0 },
              { code: "Y", qty: "abc" },
            ],
          },
          400,
          /at least one item/,
        ],
      ];
      for (const [body, status, message] of cases) {
        const res = await w.agent.post(SAVE).send(body);
        expect(res.status, JSON.stringify(body)).toBe(status);
        expect(res.body.message).toMatch(message);
      }
      expect(await w.q(`SELECT 1 FROM supplier_proformas WHERE company_id = $1`, [w.companyId])).toEqual([]);
    }));

  it("collapses codes and aliases, weights prices, applies overrides and keeps raw lines", () =>
    withFactoryWorld(async (w) => {
      const f = await world(w);
      await w.q(`INSERT INTO supplier_profit_po_overrides (supplier_id, stock_item_id, po_price) VALUES ($1, $2, 99)`, [
        f.own,
        f.itemB,
      ]);
      const res = await w.agent.post(SAVE).send({
        supplierId: String(f.own),
        reference: "  ",
        notes: " first ",
        items: [
          { barcode: `${w.tag}a`, qty: 2, supplierPrice: 10, weight: 40 },
          { code: `${w.tag}ALIAS`, qty: 2, supplierPrice: "20", weight: 50 },
          { code: `${w.tag}A`, qty: 1.4, supplierPrice: "", weight: "bad" },
          { code: `${w.tag}B`, qty: 3, supplierPrice: 5 },
          { code: "RAW-1", name: "Loose Socks", qty: 4, supplierPrice: -1 },
          { code: "RAW-2", qty: 1 },
          { code: "SKIP", qty: 0 },
        ],
      });
      expect(res.status, res.text).toBe(200);
      expect(res.body.reference).toMatch(/^PC-\d{4}-\d{2}-\d{2}-\d{4}$/);
      const saved = await lines(w, res.body.id);
      expect(saved.map((l) => [l.barcode, l.item_name, Number(l.qty), Number(l.weight), Number(l.price)])).toEqual([
        ["RAW-1", "Loose Socks", 4, 0, 0],
        ["RAW-2", "RAW-2", 1, 0, 0],
        [`${w.tag}A`, "Shirts A", 5, 36, 15],
        [`${w.tag}B`, "Shoes B", 3, 0, 99],
      ]);
      const [header] = await w.q(`SELECT notes FROM supplier_proformas WHERE id = $1`, [res.body.id]);
      expect(header.notes).toBe("first");
    }));
});

describe("update proforma items", () => {
  it("refuses bad ids, bodies, other companies and out-of-scope suppliers", () =>
    withFactoryWorld(async (w) => {
      const f = await world(w);
      expect((await w.agent.put(update("abc")).send({ items: [] })).status).toBe(400);
      expect((await w.agent.put(update(1)).send({ items: "x" })).status).toBe(400);
      const foreign = await w.one(
        `INSERT INTO supplier_proformas (company_id, supplier_id, reference) VALUES ($1, $2, 'F') RETURNING id`,
        [f.other, f.foreignSupplier]
      );
      const notFound = await w.agent.put(update(foreign)).send({ items: [] });
      expect(notFound.status).toBe(404);
      expect(notFound.body.message).toBe("Proforma not found");
      const orphan = await w.one(
        `INSERT INTO supplier_proformas (company_id, supplier_id, reference) VALUES ($1, $2, 'O') RETURNING id`,
        [w.companyId, f.foreignSupplier]
      );
      const scope = await w.agent.put(update(orphan)).send({ items: [] });
      expect(scope.status).toBe(404);
      expect(scope.body.message).toBe("Supplier not found");
    }));

  it("replaces and clears the lines", () =>
    withFactoryWorld(async (w) => {
      const f = await world(w);
      const saved = await w.agent
        .post(SAVE)
        .send({ supplierId: f.own, reference: "REF-1", items: [{ code: `${w.tag}A`, qty: 1 }] });
      expect(saved.body.reference).toBe("REF-1");
      const replaced = await w.agent
        .put(update(saved.body.id))
        .send({ items: [{ code: `${w.tag}B`, itemName: "Renamed", qty: 2, supplierPrice: 3 }] });
      expect(replaced.body).toEqual({ ok: true });
      expect((await lines(w, saved.body.id)).map((l) => [l.barcode, Number(l.price)])).toEqual([[`${w.tag}B`, 3]]);
      expect((await w.agent.put(update(saved.body.id)).send({ items: [] })).status).toBe(200);
      expect(await lines(w, saved.body.id)).toEqual([]);
    }));
});
