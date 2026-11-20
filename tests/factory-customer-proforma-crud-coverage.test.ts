/**
 * Customer proforma CRUD and capacity reads
 * (server/routes/factory/customer-proformas/proformas.ts) over HTTP, one
 * rolled-back factory company per test. Refusals first: invalid ids, unknown
 * and other-company proformas, missing customerId, bad destinations, duplicate
 * names, schema failures. Then the summary and full lists, the detail read
 * with bale-product weights, updates and soft deletion.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const BASE = "/api/factory/customer-proformas";

async function seed(w: FactoryWorld) {
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Proforma Buyer') RETURNING id`,
    [w.companyId, `${w.tag}C`]
  );
  await w.q(
    `INSERT INTO factory_bale_products (company_id, code, name, article_code, weight_per_bale_kg)
     VALUES ($1, $2, 'Catalog Shirts', 'ART-1', '45')`,
    [w.companyId, `${w.tag}P`]
  );
  const proformaId = await w.one(
    `INSERT INTO customer_proformas (company_id, customer_id, name, destination, is_active)
     VALUES ($1, $2, 'Alpha', 'KALEME', TRUE) RETURNING id`,
    [w.companyId, customerId]
  );
  await w.q(
    `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale,
       pricing_mode, price_per_kg)
     VALUES ($1, 'ART-1', 'Shirts', 10, 30, 'per_kg', 1.5),
            ($1, 'ART-2', 'Shoes', 4, 50, 'per_bale', NULL)`,
    [proformaId]
  );
  const otherCompany = await w.one(
    `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
    [`${w.tag}O`]
  );
  const otherCustomer = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Other Buyer') RETURNING id`,
    [otherCompany, `${w.tag}OC`]
  );
  const foreignId = await w.one(
    `INSERT INTO customer_proformas (company_id, customer_id, name) VALUES ($1, $2, 'Foreign') RETURNING id`,
    [otherCompany, otherCustomer]
  );
  return { customerId, proformaId, foreignId, otherCustomer };
}

describe("reads", () => {
  it("refuses invalid ids, other-company and unknown proformas", () =>
    withFactoryWorld(async (w) => {
      const { foreignId } = await seed(w);
      expect((await w.agent.get(`${BASE}/abc/capacity`)).status).toBe(400);
      const badOrder = await w.agent.get(`${BASE}/1/capacity`).query({ currentOrderId: "x" });
      expect(badOrder.status).toBe(400);
      expect(badOrder.body.message).toBe("Invalid currentOrderId");
      expect((await w.agent.get(`${BASE}/${foreignId}/capacity`)).status).toBe(404);
      expect((await w.agent.get(`${BASE}/abc`)).status).toBe(400);
      const detail = await w.agent.get(`${BASE}/${foreignId}`);
      expect(detail.status).toBe(404);
      expect(detail.body.message).toBe("Proforma not found");
      const list = await w.agent.get(BASE);
      expect(list.status).toBe(400);
      expect(list.body.message).toBe("customerId is required");
    }));

  it("returns the capacity snapshot with product names from the proforma lines", () =>
    withFactoryWorld(async (w) => {
      const { proformaId } = await seed(w);
      const res = await w.agent.get(`${BASE}/${proformaId}/capacity`).query({ currentOrderId: "" });
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      const names = Object.fromEntries(
        res.body.articles.map((a: { articleCode: string; productName: string }) => [a.articleCode, a.productName])
      );
      expect(names).toMatchObject({ "ART-1": "Shirts", "ART-2": "Shoes" });
    }));

  it("returns one proforma with its lines and catalogue weights", () =>
    withFactoryWorld(async (w) => {
      const { proformaId } = await seed(w);
      const res = await w.agent.get(`${BASE}/${proformaId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: proformaId, name: "Alpha", destination: "KALEME", isActive: true });
      const byCode = Object.fromEntries(res.body.lines.map((l: { articleCode: string }) => [l.articleCode, l]));
      expect(Number(byCode["ART-1"].weightPerBaleKg)).toBe(45);
      expect(byCode["ART-1"]).toMatchObject({ pricingMode: "per_kg", quantity: 10 });
      expect(byCode["ART-2"]).toMatchObject({ weightPerBaleKg: "0", pricePerKg: null });
    }));

  it("lists summaries with SQL totals and the full list with catalogue names", () =>
    withFactoryWorld(async (w) => {
      const { customerId, proformaId } = await seed(w);
      const empty = await w.one(
        `INSERT INTO customer_proformas (company_id, customer_id, name) VALUES ($1, $2, 'Beta') RETURNING id`,
        [w.companyId, customerId]
      );
      const summary = await w.agent.get(BASE).query({ customerId, profile: "summary" });
      expect(summary.status).toBe(200);
      expect(summary.headers["x-erp-payload-profile"]).toBe("customer-proforma-summary-v2");
      const alpha = summary.body.find((p: { id: number }) => p.id === proformaId);
      // 10 bales x 45 kg x 1.5 per kg + 4 bales x 50.
      expect(alpha).toMatchObject({ lineCount: 2, totalQty: 14, totalWeightKg: 450, totalAmount: 875, lines: [] });
      expect(summary.body.find((p: { id: number }) => p.id === empty)).toMatchObject({ lineCount: 0, totalAmount: 0 });

      const full = await w.agent.get(BASE).query({ customerId });
      expect(full.status).toBe(200);
      expect(full.headers["x-erp-payload-profile"]).toBe("customer-proforma-full-v2");
      const fullAlpha = full.body.find((p: { id: number }) => p.id === proformaId);
      const names = fullAlpha.lines.map((l: { productName: string }) => l.productName).sort();
      expect(names).toEqual(["Catalog Shirts", "Shoes"]);
      expect(full.body.find((p: { id: number }) => p.id === empty).lines).toEqual([]);

      const emptyDetail = await w.agent.get(`${BASE}/${empty}`);
      expect(emptyDetail.body).toMatchObject({ id: empty, destination: null, isActive: false, lines: [] });

      const none = await w.agent.get(BASE).query({ customerId: 2147483000 });
      expect(none.body).toEqual([]);
    }));
});

describe("writes", () => {
  it("refuses an invalid destination, a duplicate name and an invalid body on create", () =>
    withFactoryWorld(async (w) => {
      const { customerId } = await seed(w);
      const count = async () =>
        (await w.q(`SELECT count(*)::int AS n FROM customer_proformas WHERE company_id=$1`, [w.companyId]))[0].n;
      const before = await count();
      const badDest = await w.agent.post(BASE).send({ customerId, name: "New", destination: null });
      expect(badDest.status).toBe(400);
      expect(badDest.body.message).toBe("A valid destination is required");
      const dup = await w.agent.post(BASE).send({ customerId, name: "Alpha" });
      expect(dup.status).toBe(409);
      expect((await w.agent.post(BASE).send({ name: "No customer" })).status).toBe(400);
      expect(await count()).toBe(before);
    }));

  it("refuses another company's, a deleted and an unknown customer on create and creates nothing", () =>
    withFactoryWorld(async (w) => {
      const { otherCustomer } = await seed(w);
      const deleted = await w.one(
        `INSERT INTO customers (company_id, code, legal_name, deleted_at) VALUES ($1, $2, 'Gone', now()) RETURNING id`,
        [w.companyId, `${w.tag}D`]
      );
      for (const customerId of [otherCustomer, deleted, 2147483000]) {
        const res = await w.agent.post(BASE).send({ customerId, name: "Stolen", destination: "KALEME" });
        expect(res.status, String(customerId)).toBe(404);
        expect(res.body.message).toBe("Customer not found");
      }
      expect(await w.q(`SELECT id FROM customer_proformas WHERE name = 'Stolen'`)).toEqual([]);
    }));

  it("creates a proforma with a normalised destination", () =>
    withFactoryWorld(async (w) => {
      const { customerId } = await seed(w);
      const res = await w.agent.post(BASE).send({ customerId, name: "Gamma", destination: " lubumbashi " });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: "Gamma", destination: "L'SHI", companyId: w.companyId });
    }));

  it("refuses updates for invalid, unknown and other-company ids, duplicate names and bad destinations", () =>
    withFactoryWorld(async (w) => {
      const { customerId, proformaId, foreignId } = await seed(w);
      await w.q(`INSERT INTO customer_proformas (company_id, customer_id, name) VALUES ($1, $2, 'Beta')`, [
        w.companyId,
        customerId,
      ]);
      expect((await w.agent.put(`${BASE}/abc`).send({})).status).toBe(400);
      expect((await w.agent.put(`${BASE}/${foreignId}`).send({ name: "Hijack" })).status).toBe(404);
      const dup = await w.agent.put(`${BASE}/${proformaId}`).send({ name: "Beta" });
      expect(dup.status).toBe(409);
      const dest = await w.agent.put(`${BASE}/${proformaId}`).send({ destination: 7 });
      expect(dest.status).toBe(400);
      const [row] = await w.q(`SELECT name, destination FROM customer_proformas WHERE id=$1`, [proformaId]);
      expect(row).toEqual({ name: "Alpha", destination: "KALEME" });
      const [foreign] = await w.q(`SELECT name FROM customer_proformas WHERE id=$1`, [foreignId]);
      expect(foreign.name).toBe("Foreign");
    }));

  it("updates the name, active flag and destination", () =>
    withFactoryWorld(async (w) => {
      const { proformaId } = await seed(w);
      const res = await w.agent
        .put(`${BASE}/${proformaId}`)
        .send({ name: "  Alpha 2 ", isActive: "yes", destination: "Mali 53" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: "Alpha 2", isActive: false, destination: "MALI" });
      const same = await w.agent.put(`${BASE}/${proformaId}`).send({ name: "Alpha 2" });
      expect(same.status).toBe(200);
    }));

  it("soft-deletes a proforma and refuses invalid and other-company ids", () =>
    withFactoryWorld(async (w) => {
      const { proformaId, foreignId } = await seed(w);
      expect((await w.agent.delete(`${BASE}/abc`)).status).toBe(400);
      const foreign = await w.agent.delete(`${BASE}/${foreignId}`);
      expect(foreign.status).toBe(404);
      const [still] = await w.q(`SELECT deleted_at FROM customer_proformas WHERE id=$1`, [foreignId]);
      expect(still.deleted_at).toBeNull();

      const res = await w.agent.delete(`${BASE}/${proformaId}`);
      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Proforma deleted");
      const [row] = await w.q(`SELECT is_active, deleted_at FROM customer_proformas WHERE id=$1`, [proformaId]);
      expect(row.is_active).toBe(false);
      expect(row.deleted_at).not.toBeNull();
      expect((await w.agent.get(`${BASE}/${proformaId}`)).status).toBe(404);
    }));
});
