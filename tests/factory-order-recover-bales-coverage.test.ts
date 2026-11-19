import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const recover = (orderId: number) => `/api/factory/customer-orders/${orderId}/recover-bales`;
const autoRecover = (orderId: number) => `/api/factory/customer-orders/${orderId}/auto-recover-bales`;

let seq = 0;

async function customer(w: FactoryWorld) {
  return w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Recover Customer') RETURNING id`,
    [w.companyId, `${w.tag}RC${++seq}`]
  );
}

async function proforma(w: FactoryWorld, customerId: number, lines: Array<[string, number, string]>) {
  const proformaId = await w.one(
    `INSERT INTO customer_proformas (company_id, customer_id, name, destination, is_active)
     VALUES ($1, $2, 'Recover PF', 'MALI', TRUE) RETURNING id`,
    [w.companyId, customerId]
  );
  for (const [articleCode, quantity, price] of lines) {
    await w.q(
      `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale)
       VALUES ($1, $2::text, $2::text, $3, $4)`,
      [proformaId, articleCode, quantity, price]
    );
  }
  return proformaId;
}

async function order(w: FactoryWorld, customerId: number, status: string, proformaId: number | null = null) {
  return w.one(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, location_id, proforma_id_used)
     VALUES ($1, $2, '2026-06-01', $3, $4, $5) RETURNING id`,
    [w.companyId, customerId, status, w.locationId, proformaId]
  );
}

async function bale(w: FactoryWorld, articleCode: string, status = "IN_STOCK") {
  const reference = `${w.tag}-R${++seq}`;
  const id = await w.one(
    `INSERT INTO factory_bales (company_id, reference_number, bale_code, article_code, product_name, weight_kg,
       cost_per_kg, status, erp_location_id)
     VALUES ($1, $2, $3, $4, 'Rags', 25, 1.5, $5, $6) RETURNING id`,
    [w.companyId, reference, `BC-${reference}`, articleCode, status, w.locationId]
  );
  return { id, reference };
}

async function linked(w: FactoryWorld, orderId: number) {
  return w.q(
    `SELECT cob.bale_id, cob.price_used::text AS price, fb.status
       FROM customer_order_bales cob JOIN factory_bales fb ON fb.id = cob.bale_id
      WHERE cob.order_id = $1 ORDER BY cob.bale_id`,
    [orderId]
  );
}

describe("recover bales by reference", () => {
  it("refuses missing orders, non-recoverable states, populated orders and bad input", async () => {
    await withFactoryWorld(async (w) => {
      const customerId = await customer(w);
      const draft = await order(w, customerId, "DRAFT");
      const loading = await order(w, customerId, "LOADING");
      const existing = await bale(w, "ART-A");
      await w.q(
        `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used)
         VALUES ($1, $2, $3, $4, 25, 1)`,
        [loading, existing.id, existing.reference, w.locationId]
      );
      const refs = { baleReferences: ["X"] };
      expect((await w.agent.post(recover(2_000_000_000)).send(refs)).status).toBe(404);
      expect((await w.agent.post(recover(draft)).send(refs)).body.message).toMatch(/only available for LOADING/);
      expect((await w.agent.post(recover(loading)).send(refs)).body.message).toMatch(/already has 1 bale/);
      expect((await w.agent.post(recover(loading)).send({ baleReferences: [] })).status).toBe(400);
      expect((await w.agent.post(recover(0)).send(refs)).status).toBe(400);
      const manager = await w.agentFor("Manager");
      expect((await manager.post(recover(draft)).send(refs)).status).toBe(403);
    });
  });

  it("links free bales without a proforma and reports unknown or already linked references", async () => {
    await withFactoryWorld(async (w) => {
      const customerId = await customer(w);
      const target = await order(w, customerId, "LOADING");
      const other = await order(w, customerId, "LOADING");
      const free = await bale(w, "ART-A");
      const sold = await bale(w, "ART-B", "SOLD");
      const taken = await bale(w, "ART-A");
      await w.q(
        `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used)
         VALUES ($1, $2, $3, $4, 25, 1)`,
        [other, taken.id, taken.reference, w.locationId]
      );
      const productId = await w.one(
        `INSERT INTO factory_bale_products (company_id, code, name, article_code) VALUES ($1, $2, 'Catalog', 'ART-P') RETURNING id`,
        [w.companyId, `${w.tag}CP`]
      );
      const byProduct = await bale(w, "");
      await w.q(`UPDATE factory_bales SET product_id = $1, product_name = NULL WHERE id = $2`, [
        productId,
        byProduct.id,
      ]);
      const res = await w.agent.post(recover(target)).send({
        baleReferences: [
          free.reference.toLowerCase(),
          "  ",
          `BC-${sold.reference}`,
          "NOPE",
          taken.reference,
          byProduct.reference,
        ],
      });
      expect(res.status, res.text).toBe(200);
      expect(res.body.linked).toBe(3);
      const [productLine] = await w.q(`SELECT article_code, bale_name FROM customer_order_bales WHERE bale_id = $1`, [
        byProduct.id,
      ]);
      expect(productLine).toEqual({ article_code: "ART-P", bale_name: "ART-P" });
      expect(res.body.notFound).toEqual(["NOPE", `${taken.reference} (already linked to active order)`]);
      expect(await linked(w, target)).toEqual([
        { bale_id: free.id, price: "1.50", status: "SOLD" },
        { bale_id: sold.id, price: "1.50", status: "SOLD" },
        { bale_id: byProduct.id, price: "1.50", status: "SOLD" },
      ]);
    });
  });

  it("enforces the linked proforma's articles and quantities and uses its prices", async () => {
    await withFactoryWorld(async (w) => {
      const customerId = await customer(w);
      const proformaId = await proforma(w, customerId, [["ART-A", 1, "40.00"]]);
      const target = await order(w, customerId, "LOADING", proformaId);
      const first = await bale(w, "art-a");
      const second = await bale(w, "ART-A");
      const offList = await bale(w, "ART-Z");
      const res = await w.agent
        .post(recover(target))
        .send({ baleReferences: [first.reference, second.reference, offList.reference] });
      expect(res.status, res.text).toBe(200);
      expect(res.body.linked).toBe(1);
      expect(res.body.notFound).toEqual([
        `${second.reference} (proforma quantity exceeded)`,
        `${offList.reference} (article not on linked proforma)`,
      ]);
      expect(await linked(w, target)).toEqual([{ bale_id: first.id, price: "40.00", status: "SOLD" }]);
    });
  });
});

describe("auto-recover bales from stock", () => {
  it("requires a linked proforma with lines and an empty order", async () => {
    await withFactoryWorld(async (w) => {
      const customerId = await customer(w);
      const plain = await order(w, customerId, "LOADING");
      expect((await w.agent.post(autoRecover(plain)).send({})).body.message).toMatch(/requires a proforma/);
      const emptyProforma = await proforma(w, customerId, []);
      const noLines = await order(w, customerId, "LOADING", emptyProforma);
      expect((await w.agent.post(autoRecover(noLines)).send({})).body.message).toMatch(/No proforma lines/);
      expect((await w.agent.post(autoRecover(2_000_000_000)).send({})).status).toBe(404);
    });
  });

  it("links available stock up to each line's remaining quantity", async () => {
    await withFactoryWorld(async (w) => {
      const customerId = await customer(w);
      const proformaId = await proforma(w, customerId, [
        ["ART-A", 2, "40.00"],
        ["ART-B", 1, "30.00"],
      ]);
      const target = await order(w, customerId, "LOADING", proformaId);
      const a1 = await bale(w, "ART-A");
      const a2 = await bale(w, "ART-A", "RESERVED_FOR_ORDER");
      await bale(w, "ART-A");
      await bale(w, "ART-A", "DELETED");
      const res = await w.agent.post(autoRecover(target)).send({});
      expect(res.status, res.text).toBe(200);
      expect(res.body.linked).toBe(2);
      expect(res.body.summary).toEqual([
        { articleCode: "ART-A", linked: 2, needed: 2 },
        { articleCode: "ART-B", linked: 0, needed: 1 },
      ]);
      expect((await linked(w, target)).map((row) => [row.bale_id, row.price])).toEqual([
        [a1.id, "40.00"],
        [a2.id, "40.00"],
      ]);
      const again = await w.agent.post(autoRecover(target)).send({});
      expect(again.status).toBe(400);
      expect(again.body.message).toMatch(/already has 2 bale/);
    });
  });
});
