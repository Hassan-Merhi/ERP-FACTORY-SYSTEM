/**
 * Container-specific extra expected items
 * (server/routes/factory/customer-orders/verify-recover/container-extra-items.ts)
 * over HTTP in one rolled-back factory company per test. Refusals first: roles,
 * invalid ids, unknown / other-company loadings, import validation, unlinked
 * proformas, finalized loadings and unknown catalogue articles, each leaving
 * no extra lines. Then the price precedence (manual > agreed > selling >
 * pending), loaded-bale repricing and removal restoring the proforma price.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { loadingWithBales } from "./helpers/dispatchFlowFixture";

const base = (orderId: number | string) => `/api/factory/customer-orders/${orderId}/container-extra-items`;

async function setup(w: FactoryWorld, opts: { proforma?: boolean; status?: string } = {}) {
  const { customerId, orderId } = await loadingWithBales(w, ["10.00", "10.00"], opts.status ?? "LOADING");
  let proformaId: number | null = null;
  if (opts.proforma !== false) {
    proformaId = await w.one(
      `INSERT INTO customer_proformas (company_id, customer_id, name) VALUES ($1, $2, 'Master') RETURNING id`,
      [w.companyId, customerId]
    );
    await w.q(
      `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale)
       VALUES ($1, 'ART-A', 'Mixed Rags', 2, 10)`,
      [proformaId]
    );
  }
  await w.q(`UPDATE customer_orders SET proforma_id_used = $1, destination = 'KALEME' WHERE id = $2`, [
    proformaId,
    orderId,
  ]);
  const seeded = await w.q(`SELECT 1 FROM factory_bale_products WHERE company_id = $1 AND article_code = 'ART-B'`, [
    w.companyId,
  ]);
  for (const [code, name, selling] of seeded.length
    ? []
    : ([
        ["ART-A", "Mixed Rags", "12"],
        ["ART-B", null, "7.5"],
        ["ART-C", "Agreed Shoes", "3"],
        ["ART-D", "Unpriced", null],
      ] as const)) {
    await w.q(
      `INSERT INTO factory_bale_products (company_id, code, name, article_code, selling_price)
       VALUES ($1, $2, COALESCE($3::text, ''), $4, $5)`,
      [w.companyId, `${w.tag}${code}`, name, code, selling]
    );
  }
  await w.q(
    `INSERT INTO customer_destination_price_lists (company_id, customer_id, destination, article_code, price_per_bale)
     VALUES ($1, $2, 'KALEME', 'ART-C', 9)`,
    [w.companyId, customerId]
  );
  return { customerId, orderId };
}

const extraLines = (w: FactoryWorld, orderId: number) =>
  w.q<{ article_code: string; price: number; qty: number }>(
    `SELECT article_code, price_per_bale::float8 AS price, expected_qty AS qty
       FROM customer_order_extra_expected_lines WHERE order_id = $1 ORDER BY article_code`,
    [orderId]
  );
const balePrices = async (w: FactoryWorld, orderId: number) =>
  (await w.q(`SELECT price_used::float8 AS p FROM customer_order_bales WHERE order_id = $1`, [orderId])).map(
    (r) => r.p
  );

describe("refusals", () => {
  it("refuses roles other than Admin, Developer and Owner", () =>
    withFactoryWorld(async (w) => {
      const { orderId } = await setup(w);
      const manager = await w.agentFor("Manager");
      for (const send of [
        () => manager.get(base(orderId)),
        () => manager.get(`${base(orderId)}/prices`),
        () => manager.put(base(orderId)).send({ articleCode: "ART-B", quantity: 1 }),
        () => manager.post(`${base(orderId)}/import`).send({ items: [] }),
        () => manager.delete(`${base(orderId)}/ART-B`),
      ]) {
        expect((await send()).status).toBe(403);
      }
      expect(await extraLines(w, orderId)).toEqual([]);
    }));

  it("refuses invalid ids and unknown or other-company loadings", () =>
    withFactoryWorld(async (w) => {
      await setup(w);
      expect((await w.agent.get(base("abc"))).status).toBe(400);
      expect((await w.agent.get(`${base("abc")}/prices`)).status).toBe(400);
      expect((await w.agent.put(base("abc")).send({})).status).toBe(400);
      expect((await w.agent.post(`${base("abc")}/import`).send({})).status).toBe(400);
      expect((await w.agent.delete(`${base("abc")}/ART-A`)).status).toBe(400);
      const missing = await w.agent.get(base(2147483000));
      expect(missing.status).toBe(404);
      expect(missing.body.message).toBe("Container loading not found");
      expect((await w.agent.get(`${base(2147483000)}/prices`)).status).toBe(404);
      expect((await w.agent.delete(`${base(2147483000)}/ART-A`)).status).toBe(404);
    }));

  it("validates imported rows", () =>
    withFactoryWorld(async (w) => {
      const { orderId } = await setup(w);
      const cases: Array<[unknown, RegExp]> = [
        [undefined, /between 1 and 500/],
        [[], /between 1 and 500/],
        [[{ articleCode: "", quantity: 1 }], /Row 1: valid article code/],
        [[{ articleCode: "ART-B", quantity: 1.5 }], /Row 1: valid article code/],
        [[null], /Row 1: valid article code/],
        [
          [
            { articleCode: "art-b", quantity: 1 },
            { articleCode: "ART-B ", quantity: 2 },
          ],
          /Row 2: duplicate article ART-B/,
        ],
        [[{ articleCode: "ART-B", quantity: 1, pricePerBale: "1.23456" }], /at most four decimals/],
        [[{ articleCode: "ART-B", quantity: 1, pricePerBale: -1 }], /at most four decimals/],
      ];
      for (const [items, message] of cases) {
        const res = await w.agent.post(`${base(orderId)}/import`).send({ items });
        expect(res.status, JSON.stringify(items)).toBe(400);
        expect(res.body.message).toMatch(message);
      }
      expect(await extraLines(w, orderId)).toEqual([]);
    }));

  it("refuses an unlinked loading, a finalized loading and an unknown article", () =>
    withFactoryWorld(async (w) => {
      const unlinked = await setup(w, { proforma: false });
      const res = await w.agent.put(base(unlinked.orderId)).send({ articleCode: "ART-B", quantity: 1 });
      expect(res.status).toBe(409);
      expect(res.body.message).toBe("This loading has no linked proforma");

      const finalized = await setup(w, { status: "COMPLETED" });
      const closed = await w.agent.put(base(finalized.orderId)).send({ articleCode: "ART-B", quantity: 1 });
      expect(closed.status).toBe(409);
      expect(closed.body.message).toMatch(/after finalization/);
      const closedDelete = await w.agent.delete(`${base(finalized.orderId)}/ART-B`);
      expect(closedDelete.status).toBe(409);

      const open = await setup(w);
      const unknown = await w.agent.put(base(open.orderId)).send({ articleCode: "NOPE", quantity: 1 });
      expect(unknown.status).toBe(404);
      expect(unknown.body.message).toMatch(/Article NOPE not found/);
      expect(await extraLines(w, open.orderId)).toEqual([]);
      expect((await w.agent.delete(`${base(open.orderId)}/ART-B`)).status).toBe(404);
    }));
});

describe("saving and removing extra items", () => {
  it("prices imports manual > agreed > selling > pending and lists them", () =>
    withFactoryWorld(async (w) => {
      const { orderId } = await setup(w);
      const res = await w.agent.post(`${base(orderId)}/import`).send({
        items: [
          { articleCode: "art-b", quantity: 3, pricePerBale: "" },
          { articleCode: "ART-C", quantity: 2, pricePerBale: null },
          { articleCode: "ART-D", quantity: 1 },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ imported: 3, unpricedCount: 1 });
      expect(await extraLines(w, orderId)).toEqual([
        { article_code: "ART-B", price: 7.5, qty: 3 },
        { article_code: "ART-C", price: 9, qty: 2 },
        { article_code: "ART-D", price: 0, qty: 1 },
      ]);
      const names = (await w.agent.get(base(orderId))).body.map((l: { productName: string }) => l.productName);
      expect(names).toEqual(["ART-B", "Agreed Shoes", "Unpriced"]);
      const prices = await w.agent.get(`${base(orderId)}/prices`);
      expect(
        prices.body.map((p: { article_code: string; price_per_bale: string }) => [
          p.article_code,
          Number(p.price_per_bale),
        ])
      ).toEqual([["ART-C", 9]]);

      const manual = await w.agent.put(base(orderId)).send({ articleCode: "ART-C", quantity: 4, pricePerBale: 0 });
      expect(manual.status).toBe(200);
      expect(manual.body).toMatchObject({ articleCode: "ART-C", expectedQty: 4 });
      expect(Number(manual.body.pricePerBale)).toBe(0);
    }));

  it("reprices loaded bales and restores the proforma price when the extra item is removed", () =>
    withFactoryWorld(async (w) => {
      const { orderId } = await setup(w);
      const res = await w.agent.put(base(orderId)).send({ articleCode: "ART-A", quantity: 2, pricePerBale: "15.5" });
      expect(res.status).toBe(200);
      expect(await balePrices(w, orderId)).toEqual([15.5, 15.5]);

      const removed = await w.agent.delete(`${base(orderId)}/art-a`);
      expect(removed.status).toBe(200);
      expect(removed.body).toEqual({ deleted: true });
      expect(await extraLines(w, orderId)).toEqual([]);
      expect(await balePrices(w, orderId)).toEqual([10, 10]);
    }));
});
