/**
 * Customer-order pricing routes (registerOrderPricingRoutes) through the real
 * app inside one rolled-back transaction: reprice from the catalogue, the
 * bale->product chain or the proforma; production prices; applying a chosen
 * proforma; repricing one article; and the per-kg price repair. Refusals
 * (bad ids, cancelled orders, other companies, missing or empty proformas,
 * bad prices) leave every bale price unchanged.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { loadingWithBales } from "./helpers/dispatchFlowFixture";

const order = (id: number | string) => `/api/factory/customer-orders/${id}`;

const prices = async (w: FactoryWorld, orderId: number) =>
  (
    await w.q<{ price: string }>(
      `SELECT price_used::text AS price FROM customer_order_bales WHERE order_id = $1 ORDER BY id`,
      [orderId]
    )
  ).map((r) => r.price);

async function proforma(w: FactoryWorld, customerId: number, lines: Array<[string, string, string?, string?]>) {
  const id = await w.one(
    `INSERT INTO customer_proformas (company_id, customer_id, name) VALUES ($1, $2, 'PF') RETURNING id`,
    [w.companyId, customerId]
  );
  for (const [article, perBale, mode, perKg] of lines) {
    await w.q(
      `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, price_per_bale, pricing_mode, price_per_kg)
       VALUES ($1, $2, 'P', $3, $4, $5)`,
      [id, article, perBale, mode ?? "per_bale", perKg ?? null]
    );
  }
  return id;
}

async function catalogue(w: FactoryWorld, article: string, selling: string | null, production: string | null) {
  return w.one(
    `INSERT INTO factory_bale_products (company_id, code, article_code, name, selling_price, production_price)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [w.companyId, `${w.tag}${article}`.replace(/[^A-Z0-9]/gi, ""), article, `Product ${article}`, selling, production]
  );
}

describe("order pricing refusals", () => {
  it("refuses bad ids, cancelled orders, other companies and bad proforma input", () =>
    withFactoryWorld(async (w) => {
      const { orderId, customerId } = await loadingWithBales(w, ["10.00"]);
      await catalogue(w, "ART-A", "50.00", "30.00");
      const before = await prices(w, orderId);
      for (const path of ["reprice", "reprice-production", "apply-proforma-prices"]) {
        expect((await w.agent.post(`${order("abc")}/${path}`).send({})).status).toBe(400);
      }
      expect((await w.agent.post(`${order(orderId)}/apply-proforma-prices`).send({})).body.message).toBe(
        "proformaId is required"
      );
      expect((await w.agent.post(`${order(2147483000)}/apply-proforma-prices`).send({ proformaId: 1 })).status).toBe(
        404
      );
      expect(
        (await w.agent.post(`${order(orderId)}/apply-proforma-prices`).send({ proformaId: 2147483000 })).status
      ).toBe(404);
      const empty = await proforma(w, customerId, []);
      const noLines = await w.agent.post(`${order(orderId)}/apply-proforma-prices`).send({ proformaId: empty });
      expect(noLines.body.message).toBe("Selected proforma has no price lines");
      expect((await w.agent.post(`${order(2147483000)}/reprice`).send({})).status).toBe(404);

      const badArticle = (body: Record<string, unknown>) =>
        w.agent.patch(`${order(orderId)}/bales/reprice-article`).send(body);
      expect((await badArticle({ pricePerBale: 5 })).status).toBe(400);
      expect((await badArticle({ articleCode: "ART-A", pricePerBale: -1 })).body.message).toBe("Invalid price value");
      expect((await badArticle({ articleCode: "ART-A", pricePerBale: "abc" })).status).toBe(400);
      expect(
        (await w.agent.patch(`${order(2147483000)}/bales/reprice-article`).send({ articleCode: "A", pricePerBale: 1 }))
          .status
      ).toBe(404);

      await w.q(`UPDATE customer_orders SET status = 'CANCELLED' WHERE id = $1`, [orderId]);
      for (const path of ["reprice", "reprice-production"]) {
        const res = await w.agent.post(`${order(orderId)}/${path}`).send({});
        expect(res.status, path).toBe(400);
        expect(res.body.message).toBe("Cannot reprice a cancelled order");
      }
      const pf = await proforma(w, customerId, [["ART-A", "70.00"]]);
      expect((await w.agent.post(`${order(orderId)}/apply-proforma-prices`).send({ proformaId: pf })).status).toBe(400);
      expect(await prices(w, orderId)).toEqual(before);
    }));
});

describe("order pricing", () => {
  it("reprices from the catalogue, then the bale's product, then the proforma", () =>
    withFactoryWorld(async (w) => {
      const { orderId, customerId, bales } = await loadingWithBales(w, ["10.00", "10.00", "10.00", "10.00"]);
      await w.q(`UPDATE customer_order_bales SET article_code = 'ART-B' WHERE id = $1`, [bales[1].orderBaleId]);
      await w.q(`UPDATE customer_order_bales SET article_code = 'ART-C' WHERE id = $1`, [bales[2].orderBaleId]);
      await w.q(`UPDATE customer_order_bales SET article_code = 'ART-D' WHERE id = $1`, [bales[3].orderBaleId]);
      await catalogue(w, "ART-A", "50.00", "30.00");
      const chained = await catalogue(w, "OTHER-X", "44.00", "22.00");
      await w.q(`UPDATE factory_bales SET product_id = $1 WHERE id = $2`, [chained, bales[1].baleId]);
      const pf = await proforma(w, customerId, [
        ["art-c", "33.00"],
        ["ART-A", "99.00"],
      ]);
      await w.q(`UPDATE customer_orders SET proforma_id_used = $1 WHERE id = $2`, [pf, orderId]);

      const res = await w.agent.post(`${order(orderId)}/reprice`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await prices(w, orderId)).toEqual(["50.00", "44.00", "33.00", "10.00"]);

      const prod = await w.agent.post(`${order(orderId)}/reprice-production`).send({});
      expect(prod.status).toBe(200);
      expect(await prices(w, orderId)).toEqual(["30.00", "22.00", "33.00", "10.00"]);

      const applied = await w.agent.post(`${order(orderId)}/apply-proforma-prices`).send({ proformaId: pf });
      expect(applied.status).toBe(200);
      expect(await prices(w, orderId)).toEqual(["99.00", "22.00", "33.00", "10.00"]);

      const article = await w.agent
        .patch(`${order(orderId)}/bales/reprice-article`)
        .send({ articleCode: "ART-D", pricePerBale: "12.345" });
      expect(article.status, JSON.stringify(article.body)).toBe(200);
      expect((await prices(w, orderId))[3]).toBe("12.35");
    }));

  it("refuses to apply a proforma to an order without bales", () =>
    withFactoryWorld(async (w) => {
      const { orderId, customerId } = await loadingWithBales(w, []);
      const pf = await proforma(w, customerId, [["ART-A", "70.00"]]);
      const res = await w.agent.post(`${order(orderId)}/apply-proforma-prices`).send({ proformaId: pf });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Order has no bales");
    }));

  it("repairs zero-priced per-kg bales on open proforma loadings only", () =>
    withFactoryWorld(async (w) => {
      const { orderId, customerId, bales } = await loadingWithBales(w, ["0", "15.00", "0"]);
      await w.q(`UPDATE customer_order_bales SET article_code = 'ART-Z' WHERE id = $1`, [bales[2].orderBaleId]);
      const pf = await proforma(w, customerId, [
        ["ART-A", "0", "per_kg", "4.35"],
        ["ART-Z", "9.00", "per_bale"],
      ]);
      await w.q(`UPDATE customer_orders SET proforma_id_used = $1 WHERE id = $2`, [pf, orderId]);
      const plain = await loadingWithBales(w, ["0"]);
      const perBaleOnly = await proforma(w, plain.customerId, [["ART-A", "5.00"]]);
      await w.q(`UPDATE customer_orders SET proforma_id_used = $1 WHERE id = $2`, [perBaleOnly, plain.orderId]);

      const res = await w.agent.post("/api/factory/repair-perkg-prices").send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ balesRepaired: 1, changedOrderIds: [orderId], errors: [] });
      expect(res.body.ordersScanned).toBeGreaterThanOrEqual(2);
      expect(await prices(w, orderId)).toEqual(["108.75", "15.00", "0.00"]);
      expect(await prices(w, plain.orderId)).toEqual(["0.00"]);

      const again = await w.agent.post("/api/factory/repair-perkg-prices").send({});
      expect(again.body).toMatchObject({ balesRepaired: 0, changedOrderIds: [] });
    }));
});
