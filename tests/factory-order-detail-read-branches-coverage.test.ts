/**
 * GET /api/factory/customer-orders/:id (order detail with lines, bales,
 * charges and continuation remaining plan) and PATCH .../hidden.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

async function setup(w: FactoryWorld, companyId = w.companyId) {
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Detail Customer') RETURNING id`,
    [companyId, `${w.tag}C${companyId}`]
  );
  const proformaId = await w.one(
    `INSERT INTO customer_proformas (company_id, customer_id, name) VALUES ($1, $2, 'PF') RETURNING id`,
    [companyId, customerId]
  );
  const lineA = await w.one(
    `INSERT INTO customer_proforma_lines (proforma_id, article_code, quantity, price_per_bale, product_name) VALUES ($1, 'ART-A', 10, 12, 'Alpha') RETURNING id`,
    [proformaId]
  );
  await w.q(
    `INSERT INTO customer_proforma_lines (proforma_id, article_code, quantity, price_per_bale, product_name) VALUES ($1, 'ART-B', 4, 8, 'Beta')`,
    [proformaId]
  );
  const orderId = await w.one(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, location_id, proforma_id_used)
     VALUES ($1, $2, '2026-06-01', 'LOADING', $3, $4) RETURNING id`,
    [companyId, customerId, companyId === w.companyId ? w.locationId : null, proformaId]
  );
  return { customerId, proformaId, lineA, orderId };
}

describe("customer order detail", () => {
  it("validates ids and hides another company's order", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.get(`/api/factory/customer-orders/abc`)).status).toBe(400);
      expect((await w.agent.get(`/api/factory/customer-orders/2147483000`)).status).toBe(404);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const { orderId } = await setup(w, other);
      expect((await w.agent.get(`/api/factory/customer-orders/${orderId}`)).status).toBe(404);
    });
  });

  it("returns lines, bales and charges with defaults", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId } = await setup(w);
      const baleId = await w.one(
        `INSERT INTO factory_bales (company_id, reference_number, status) VALUES ($1, $2, 'RESERVED_FOR_ORDER') RETURNING id`,
        [w.companyId, `${w.tag}-B1`]
      );
      await w.q(
        `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used) VALUES ($1, $2, $3, $4, 25, 12)`,
        [orderId, baleId, `${w.tag}-B1`, w.locationId]
      );
      await w.q(`INSERT INTO customer_order_charges (order_id, name, amount) VALUES ($1, 'Freight', 50)`, [orderId]);
      await w.q(
        `INSERT INTO customer_order_lines (order_id, article_code, bale_name, weight_per_bale, total_weight, price_per_bale, total_price)
         VALUES ($1, 'ART-A', 'Alpha', 25, 25, 12, 12)`,
        [orderId]
      );
      const res = await w.agent.get(`/api/factory/customer-orders/${orderId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: orderId,
        status: "LOADING",
        customerName: "Detail Customer",
        invoiceNumber: null,
      });
      expect(res.body.bales).toEqual([expect.objectContaining({ baleId, articleCode: null, baleName: null })]);
      expect(res.body.charges).toEqual([expect.objectContaining({ name: "Freight", chargeType: "OTHER" })]);
      expect(res.body.lines).toHaveLength(1);
      expect(res.body.proformaRemainingLines).toBeUndefined();
    });
  });

  it("computes the continuation remaining plan from saved expected lines", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, proformaId, lineA } = await setup(w);
      await w.q(
        `INSERT INTO customer_order_expected_lines (order_id, company_id, proforma_id, proforma_line_id, article_code, product_name, expected_qty)
         VALUES ($1, $2, $3, $4, 'ART-A', NULL, 6), ($1, $2, $3, NULL, ' art-b ', 'Beta Saved', 2)`,
        [orderId, w.companyId, proformaId, lineA]
      );
      const res = await w.agent
        .get(`/api/factory/customer-orders/${orderId}`)
        .query({ continuationFromOrderId: orderId });
      expect(res.status).toBe(200);
      const remaining = res.body.proformaRemainingLines as Array<{
        articleCode: string;
        quantity: number;
        productName: string;
      }>;
      expect(remaining.map((line) => [line.articleCode.trim().toUpperCase(), line.quantity])).toEqual([
        ["ART-A", 6],
        ["ART-B", 2],
      ]);
    });
  });

  it("returns an empty remaining plan when the proforma is not this company's", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId } = await setup(w);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const foreign = await setup(w, other);
      await w.q(`UPDATE customer_orders SET proforma_id_used = $1 WHERE id = $2`, [foreign.proformaId, orderId]);
      const res = await w.agent
        .get(`/api/factory/customer-orders/${orderId}`)
        .query({ continuationFromOrderId: orderId });
      expect(res.status).toBe(200);
      expect(res.body.proformaRemainingLines).toEqual([]);
    });
  });
});

describe("PATCH /api/factory/customer-orders/:id/hidden", () => {
  it("validates input and only changes this company's order", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId } = await setup(w);
      expect((await w.agent.patch(`/api/factory/customer-orders/abc/hidden`).send({ isHidden: true })).status).toBe(
        400
      );
      expect(
        (await w.agent.patch(`/api/factory/customer-orders/${orderId}/hidden`).send({ isHidden: "yes" })).status
      ).toBe(400);
      expect(
        (await w.agent.patch(`/api/factory/customer-orders/${orderId}/hidden`).send({ isHidden: true })).body
      ).toEqual({
        success: true,
      });
      const [own] = await w.q<{ is_hidden: boolean }>(`SELECT is_hidden FROM customer_orders WHERE id = $1`, [orderId]);
      expect(own.is_hidden).toBe(true);

      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const foreign = await setup(w, other);
      const res = await w.agent
        .patch(`/api/factory/customer-orders/${foreign.orderId}/hidden`)
        .send({ isHidden: true });
      // Pinned: a foreign id is a silent no-op that still answers success.
      expect(res.status).toBe(200);
      const [row] = await w.q<{ is_hidden: boolean }>(`SELECT is_hidden FROM customer_orders WHERE id = $1`, [
        foreign.orderId,
      ]);
      expect(row.is_hidden).toBe(false);
    });
  });
});
