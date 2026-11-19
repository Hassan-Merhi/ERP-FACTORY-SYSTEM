/**
 * Bulk import of bales into a customer loading (bale reference mode and
 * article/quantity mode) against PostgreSQL, one rolled-back transaction per
 * test. Pinned: which bales are taken, how each is priced, what stock status
 * it moves to, and every bale or request that is refused.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const url = (orderId: number | string) => `/api/factory/customer-orders/${orderId}/bales/bulk-import`;
let seq = 0;

async function customer(w: FactoryWorld) {
  return w.one(`INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Bulk Customer') RETURNING id`, [
    w.companyId,
    `${w.tag}C${++seq}`,
  ]);
}

async function order(
  w: FactoryWorld,
  options: { status?: string; proformaId?: number | null; customerId?: number } = {}
) {
  const customerId = options.customerId ?? (await customer(w));
  return w.one(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, proforma_id_used, location_id)
     VALUES ($1, $2, '2026-06-01', $3, $4, $5) RETURNING id`,
    [w.companyId, customerId, options.status ?? "LOADING", options.proformaId ?? null, w.locationId]
  );
}

async function bale(
  w: FactoryWorld,
  fields: { article?: string | null; productId?: number | null; status?: string; weight?: string; code?: string } = {}
) {
  const reference = `${w.tag}R${++seq}`;
  const id = await w.one(
    `INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, product_id, product_name,
       weight_kg, status, erp_location_id, created_at)
     VALUES ($1, $2, $3, $4, $5, 'Bale name', $6, $7, $8, now() + ($9 || ' seconds')::interval) RETURNING id`,
    [
      w.companyId,
      fields.code ?? `${reference}-CODE`,
      reference,
      fields.article === undefined ? "ART-A" : fields.article,
      fields.productId ?? null,
      fields.weight ?? "20",
      fields.status ?? "IN_STOCK",
      w.locationId,
      String(seq),
    ]
  );
  return { id, reference };
}

async function product(w: FactoryWorld, article: string, name: string, sellingPrice: string) {
  return w.one(
    `INSERT INTO factory_bale_products (company_id, code, name, article_code, selling_price) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [w.companyId, `${w.tag}P${++seq}`, name, article, sellingPrice]
  );
}

async function proforma(w: FactoryWorld, customerId: number, lines: Array<Record<string, unknown>>) {
  const id = await w.one(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active) VALUES ($1, $2, 'PF', true) RETURNING id`,
    [w.companyId, customerId]
  );
  for (const line of lines) {
    await w.q(
      `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale, pricing_mode, price_per_kg)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, line.code, line.code, line.qty, line.price ?? "0", line.mode ?? "per_bale", line.perKg ?? null]
    );
  }
  return id;
}

const loaded = (w: FactoryWorld, orderId: number) =>
  w.q(
    `SELECT bale_id, price_used::text AS price, article_code, bale_name FROM customer_order_bales WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
const statusOf = async (w: FactoryWorld, id: number) =>
  (await w.q(`SELECT status FROM factory_bales WHERE id = $1`, [id]))[0].status;

describe("bulk import: request validation", () => {
  it("refuses bad ids, missing input, foreign locations and inactive or finalized loadings", async () => {
    await withFactoryWorld(async (w) => {
      const orderId = await order(w);
      const ok = { locationId: w.locationId, refNumbers: ["X"] };
      expect((await w.agent.post(url("abc")).send(ok)).status).toBe(400);
      expect((await w.agent.post(url(orderId)).send({ refNumbers: ["X"] })).status).toBe(400);
      expect(
        (await w.agent.post(url(orderId)).send({ locationId: w.locationId, items: [], refNumbers: [] })).status
      ).toBe(400);
      const foreign = await w.agent.post(url(orderId)).send({ ...ok, locationId: 999999999 });
      expect(foreign.body.message).toBe("Location not found");
      expect((await w.agent.post(url(999999999)).send(ok)).status).toBe(404);
      const deleted = await order(w);
      await w.q(`UPDATE customer_orders SET deleted_at = now() WHERE id = $1`, [deleted]);
      expect((await w.agent.post(url(deleted)).send(ok)).status).toBe(404);
      const finalized = await order(w, { status: "FINALIZED" });
      expect((await w.agent.post(url(finalized)).send(ok)).body.message).toMatch(/Can only add bales/);
      const cust = await customer(w);
      const pf = await proforma(w, cust, [{ code: "ART-A", qty: 5 }]);
      const v5 = await order(w, { status: "PENDING_VERIFICATION", proformaId: pf, customerId: cust });
      expect((await w.agent.post(url(v5)).send(ok)).body.message).toMatch(/V5 order/);
    });
  });
});

describe("bulk import: bale reference mode", () => {
  it("adds legacy bales by reference or bale code, reserves them and reports the rest", async () => {
    await withFactoryWorld(async (w) => {
      const productId = await product(w, "ART-P", "Product Name", "9.50");
      const orderId = await order(w);
      const byRef = await bale(w);
      const byCode = await bale(w, { code: `${w.tag}BYCODE`, article: null, productId });
      const sold = await bale(w, { status: "SOLD" });
      const elsewhere = await bale(w);
      const otherOrder = await order(w);
      await w.q(
        `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used) VALUES ($1, $2, $3, $4, 20, 0)`,
        [otherOrder, elsewhere.id, elsewhere.reference, w.locationId]
      );
      const res = await w.agent.post(url(orderId)).send({
        locationId: w.locationId,
        refNumbers: [
          byRef.reference,
          ` ${w.tag}BYCODE `,
          "",
          byRef.reference,
          sold.reference,
          elsewhere.reference,
          "NOPE",
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.added).toBe(2);
      // The repeated reference is already RESERVED_FOR_ORDER, so it is no longer found in stock.
      expect(res.body.notFoundRefs).toEqual([byRef.reference, sold.reference, elsewhere.reference, "NOPE"]);
      expect(await loaded(w, orderId)).toEqual([
        { bale_id: byRef.id, price: "0.00", article_code: "ART-A", bale_name: "Bale name" },
        { bale_id: byCode.id, price: "9.50", article_code: "ART-P", bale_name: "Product Name" },
      ]);
      expect(await statusOf(w, byRef.id)).toBe("RESERVED_FOR_ORDER");
      expect(await statusOf(w, byCode.id)).toBe("RESERVED_FOR_ORDER");
      expect(await statusOf(w, sold.id)).toBe("SOLD");
    });
  });

  it("prices proforma loadings per bale, per kg and by container price, and enforces capacity", async () => {
    await withFactoryWorld(async (w) => {
      const cust = await customer(w);
      const pf = await proforma(w, cust, [
        { code: "ART-A", qty: 1, price: "12.00" },
        { code: "ART-K", qty: 5, price: "0", mode: "per_kg", perKg: "1.115" },
        { code: "ART-X", qty: 5, price: "3.00" },
      ]);
      const orderId = await order(w, { proformaId: pf, customerId: cust });
      await w.q(
        `INSERT INTO customer_order_extra_expected_lines (company_id, order_id, article_code, product_name, expected_qty, price_per_bale)
         VALUES ($1, $2, 'art-x', 'Extra', 2, 44.5)`,
        [w.companyId, orderId]
      );
      const perBale = await bale(w, { article: "ART-A" });
      const overCap = await bale(w, { article: "ART-A" });
      const perKg = await bale(w, { article: "ART-K", weight: "3" });
      const container = await bale(w, { article: "ART-X" });
      const offList = await bale(w, { article: "ART-Z" });
      const res = await w.agent.post(url(orderId)).send({
        locationId: w.locationId,
        refNumbers: [
          perBale.reference,
          perBale.reference,
          overCap.reference,
          perKg.reference,
          container.reference,
          offList.reference,
        ],
      });
      expect(res.body.added).toBe(3);
      expect(res.body.notFoundRefs).toEqual([overCap.reference, offList.reference]);
      expect((await loaded(w, orderId)).map((r) => r.price)).toEqual(["12.00", "3.35", "44.50"]);
      // V5 loadings keep bales IN_STOCK until verification.
      expect(await statusOf(w, perBale.id)).toBe("IN_STOCK");

      const bypass = await w.agent
        .post(url(orderId))
        .send({ locationId: w.locationId, refNumbers: [offList.reference], allowBypassProforma: true });
      expect(bypass.body.added).toBe(1);
    });
  });
});

describe("bulk import: article quantity mode", () => {
  it("takes the oldest matching legacy bales by article or product name and reports shortfalls", async () => {
    await withFactoryWorld(async (w) => {
      const productId = await product(w, "ART-N", "Named Rags", "7.00");
      const orderId = await order(w);
      const first = await bale(w, { article: "ART-A" });
      const second = await bale(w, { article: "art-a" });
      await bale(w, { article: "ART-A", status: "SOLD" });
      const named = await bale(w, { article: null, productId });
      const res = await w.agent.post(url(orderId)).send({
        locationId: w.locationId,
        items: [
          { articleCode: "ART-A", qty: "3" },
          { articleCode: "named rags", qty: 1 },
          { articleCode: "", qty: 4 },
          { articleCode: "ART-A", qty: 0 },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.added).toBe(3);
      expect(res.body.notFound).toEqual([{ articleCode: "ART-A", requestedQty: 3, foundQty: 2 }]);
      expect((await loaded(w, orderId)).map((r) => [r.bale_id, r.price])).toEqual([
        [first.id, "0.00"],
        [second.id, "0.00"],
        [named.id, "7.00"],
      ]);
      expect(await statusOf(w, first.id)).toBe("RESERVED_FOR_ORDER");
    });
  });

  it("respects proforma capacity, skips bales held by other loadings and prices per kg or container", async () => {
    await withFactoryWorld(async (w) => {
      const cust = await customer(w);
      const pf = await proforma(w, cust, [
        { code: "ART-A", qty: 2, price: "10.00" },
        { code: "ART-K", qty: 2, price: "0", mode: "per_kg", perKg: "2" },
        { code: "ART-X", qty: 2, price: "1.00" },
      ]);
      const orderId = await order(w, { proformaId: pf, customerId: cust });
      await w.q(
        `INSERT INTO customer_order_extra_expected_lines (company_id, order_id, article_code, product_name, expected_qty, price_per_bale)
         VALUES ($1, $2, 'ART-X', 'Extra', 2, 8)`,
        [w.companyId, orderId]
      );
      const held = await bale(w, { article: "ART-A" });
      const other = await order(w);
      await w.q(
        `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used) VALUES ($1, $2, $3, $4, 20, 0)`,
        [other, held.id, held.reference, w.locationId]
      );
      const a1 = await bale(w, { article: "ART-A" });
      const a2 = await bale(w, { article: "ART-A" });
      await bale(w, { article: "ART-A" });
      const k1 = await bale(w, { article: "ART-K", weight: "4.5" });
      const x1 = await bale(w, { article: "ART-X" });
      const res = await w.agent.post(url(orderId)).send({
        locationId: w.locationId,
        items: [
          { articleCode: "ART-A", qty: 5 },
          { articleCode: "ART-K", qty: 1 },
          { articleCode: "ART-X", qty: 1 },
        ],
      });
      expect(res.body.added).toBe(4);
      expect(res.body.notFound).toEqual([{ articleCode: "ART-A", requestedQty: 5, foundQty: 2 }]);
      expect((await loaded(w, orderId)).map((r) => [r.bale_id, r.price])).toEqual([
        [a1.id, "10.00"],
        [a2.id, "10.00"],
        [k1.id, "9.00"],
        [x1.id, "8.00"],
      ]);
      expect(await statusOf(w, a1.id)).toBe("IN_STOCK");
    });
  });

  it("adds nothing when the proforma has been removed", async () => {
    await withFactoryWorld(async (w) => {
      const cust = await customer(w);
      const pf = await proforma(w, cust, [{ code: "ART-A", qty: 2, price: "10.00" }]);
      const orderId = await order(w, { proformaId: pf, customerId: cust });
      await bale(w, { article: "ART-A" });
      await w.q(`UPDATE customer_proformas SET deleted_at = now() WHERE id = $1`, [pf]);
      const res = await w.agent
        .post(url(orderId))
        .send({ locationId: w.locationId, items: [{ articleCode: "ART-A", qty: 1 }] });
      expect(res.body.added).toBe(0);
      expect(res.body.notFound).toEqual([{ articleCode: "ART-A", requestedQty: 1, foundQty: 0 }]);
      expect(await loaded(w, orderId)).toEqual([]);
    });
  });
});
