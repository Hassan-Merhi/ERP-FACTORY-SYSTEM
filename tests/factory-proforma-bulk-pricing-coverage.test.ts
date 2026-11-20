/**
 * Customer proforma bulk create, replace-lines and apply-catalog-prices:
 * every refusal (bad destination, missing fields, no valid line, duplicate
 * article codes, bad id, unknown or other-company proforma) writes nothing,
 * including apply-catalog-prices on another company's proforma;
 * the happy paths store per-bale and per-kg lines and re-price only unfixed
 * lines that have a positive catalog price. One rolled-back transaction per test.
 */
import { describe, expect, it } from "vitest";

import { type FactoryWorld, withFactoryWorld } from "./helpers/rolledBackFactoryApp";

const BASE = "/api/factory/customer-proformas";

async function customer(w: FactoryWorld, companyId = w.companyId) {
  return w.one(`INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Buyer') RETURNING id`, [
    companyId,
    `${w.tag}${Math.random().toString(36).slice(2, 6)}`,
  ]);
}

const line = (code: string, over: Record<string, unknown> = {}) => ({
  articleCode: code,
  productName: `Product ${code}`,
  quantity: "3",
  pricePerBale: "10",
  ...over,
});

const proformaCount = async (w: FactoryWorld) =>
  Number((await w.q(`SELECT COUNT(*)::int AS n FROM customer_proformas WHERE company_id = $1`, [w.companyId]))[0].n);

describe("bulk proforma create", () => {
  it("refuses bad destinations, missing fields, empty or duplicate lines", async () => {
    await withFactoryWorld(async (w) => {
      const customerId = await customer(w);
      const send = (body: Record<string, unknown>) => w.agent.post(`${BASE}/bulk`).send(body);
      let res = await send({ customerId, name: "P", destination: 5, lines: [line("A")] });
      expect(res.body.message).toBe("Invalid proforma destination");
      res = await send({ customerId, name: "P", lines: "x" });
      expect(res.body.message).toMatch(/lines=not array/);
      res = await send({ name: "P", lines: [] });
      expect(res.body.message).toMatch(/customerId=undefined, name=P, lines=0/);
      res = await send({ customerId, name: "P", lines: [line("A", { quantity: "0" }), line("", {})] });
      expect(res.body.message).toBe("At least one line must have articleCode, productName, and quantity > 0");
      res = await send({ customerId, name: "P", lines: [line("A"), line(" a ")] });
      expect(res.body.message).toBe("Article code already exists in this proforma");
      expect(res.status).toBe(400);
      expect(await proformaCount(w)).toBe(0);
    });
  });

  it("refuses another company's, a deleted and an unknown customer and creates nothing", async () => {
    await withFactoryWorld(async (w) => {
      const otherCompany = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}O`]
      );
      const foreign = await customer(w, otherCompany);
      const deleted = await customer(w);
      await w.q(`UPDATE customers SET deleted_at = now() WHERE id = $1`, [deleted]);
      for (const customerId of [foreign, deleted, 2147483000]) {
        const res = await w.agent.post(`${BASE}/bulk`).send({ customerId, name: "Stolen", lines: [line("A")] });
        expect(res.status, String(customerId)).toBe(404);
        expect(res.body.message).toBe("Customer not found");
      }
      expect(await w.q(`SELECT id FROM customer_proformas WHERE name = 'Stolen'`)).toEqual([]);
    });
  });

  it("creates per-bale and per-kg lines with a normalised destination", async () => {
    await withFactoryWorld(async (w) => {
      const customerId = await customer(w);
      const res = await w.agent.post(`${BASE}/bulk`).send({
        customerId,
        name: "Season",
        destination: " lubumbashi ",
        isActive: true,
        lines: [
          line("A", { productionPricePerBale: "7" }),
          line("B", { pricingMode: "per_kg", pricePerKg: "1.25", pricePerBale: "" }),
          line("C", { pricingMode: "per_kg", pricePerKg: "" }),
          line("D", { quantity: "-1" }),
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ destination: "L'SHI", isActive: true, name: "Season" });
      const lines = res.body.lines.map((l: Record<string, unknown>) => [
        l.articleCode,
        l.pricingMode,
        l.pricePerKg === null ? null : Number(l.pricePerKg),
      ]);
      expect(lines).toEqual([
        ["A", "per_bale", null],
        ["B", "per_kg", 1.25],
        ["C", "per_kg", null],
      ]);
    });
  });
});

async function proformaWithLines(w: FactoryWorld, companyId = w.companyId) {
  const customerId = await customer(w, companyId);
  const id = await w.one(
    `INSERT INTO customer_proformas (company_id, customer_id, name) VALUES ($1, $2, 'Existing') RETURNING id`,
    [companyId, customerId]
  );
  for (const [code, price, fixed] of [
    ["A1", "1", false],
    ["B1", "2", true],
    ["C1", "3", false],
  ] as const) {
    await w.q(
      `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale, price_fixed)
       VALUES ($1, $2::varchar, $2::text, 1, $3, $4)`,
      [id, code, price, fixed]
    );
  }
  return id;
}

const linePrices = async (w: FactoryWorld, proformaId: number) =>
  (
    await w.q(
      `SELECT article_code, price_per_bale FROM customer_proforma_lines WHERE proforma_id = $1 ORDER BY article_code`,
      [proformaId]
    )
  ).map((r) => [r.article_code, Number(r.price_per_bale)]);

describe("replace proforma lines", () => {
  it("refuses bad ids, unknown or other-company proformas and invalid lines", async () => {
    await withFactoryWorld(async (w) => {
      const id = await proformaWithLines(w);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const foreign = await proformaWithLines(w, other);
      const put = (target: unknown, body: Record<string, unknown>) =>
        w.agent.put(`${BASE}/${target}/replace-lines`).send(body);
      expect((await put("abc", { lines: [line("A")] })).status).toBe(400);
      expect((await put(foreign, { lines: [line("A")] })).status).toBe(404);
      expect((await put(id, { lines: [] })).body.message).toBe("At least one line is required");
      expect((await put(id, { lines: [line("A", { productName: "" })] })).body.message).toMatch(
        /must have articleCode/
      );
      expect((await put(id, { lines: [line("Q"), line("q")] })).body.message).toBe(
        "Article code already exists in this proforma"
      );
      expect(await linePrices(w, id)).toEqual([
        ["A1", 1],
        ["B1", 2],
        ["C1", 3],
      ]);
      expect(await linePrices(w, foreign)).toHaveLength(3);
    });
  });

  it("replaces every line", async () => {
    await withFactoryWorld(async (w) => {
      const id = await proformaWithLines(w);
      const res = await w.agent
        .put(`${BASE}/${id}/replace-lines`)
        .send({ lines: [line("Z", { pricingMode: "per_kg", pricePerKg: "2" }), line("Y", { pricePerBale: "" })] });
      expect(res.status).toBe(200);
      expect(await linePrices(w, id)).toEqual([
        ["Y", 0],
        ["Z", 10],
      ]);
    });
  });
});

describe("apply catalog prices", () => {
  it("refuses a bad or unknown id and reports nothing for a proforma without lines", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.post(`${BASE}/abc/apply-catalog-prices`)).status).toBe(400);
      const unknown = await w.agent.post(`${BASE}/999999999/apply-catalog-prices`);
      expect(unknown.status).toBe(404);
      expect(unknown.body.message).toBe("Proforma not found");
      const empty = await w.one(
        `INSERT INTO customer_proformas (company_id, customer_id, name) VALUES ($1, $2, 'Empty') RETURNING id`,
        [w.companyId, await customer(w)]
      );
      const res = await w.agent.post(`${BASE}/${empty}/apply-catalog-prices`);
      expect(res.body).toEqual({ updated: 0, skipped: 0 });
    });
  });

  it("re-prices unfixed lines from positive catalog prices only", async () => {
    await withFactoryWorld(async (w) => {
      const id = await proformaWithLines(w);
      for (const [code, price] of [
        ["a1", "11"],
        ["B1", "22"],
        ["C1", "0"],
      ]) {
        await w.q(
          `INSERT INTO factory_bale_products (company_id, code, name, article_code, selling_price) VALUES ($1, $2::text, $2::text, $3, $4)`,
          [w.companyId, `${w.tag}${code}`, code, price]
        );
      }
      const res = await w.agent.post(`${BASE}/${id}/apply-catalog-prices`);
      expect(res.body).toEqual({ updated: 1, skipped: 1, fixed: 1 });
      expect(await linePrices(w, id)).toEqual([
        ["A1", 11],
        ["B1", 2],
        ["C1", 3],
      ]);
    });
  });

  it("refuses another company's proforma and leaves its lines unchanged", async () => {
    await withFactoryWorld(async (w) => {
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}Y`,
      ]);
      const foreign = await proformaWithLines(w, other);
      await w.q(
        `INSERT INTO factory_bale_products (company_id, code, name, article_code, selling_price) VALUES ($1, $2, 'A1', 'A1', 99)`,
        [w.companyId, `${w.tag}A1`]
      );
      const res = await w.agent.post(`${BASE}/${foreign}/apply-catalog-prices`);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe("Proforma not found");
      expect(await linePrices(w, foreign)).toEqual([
        ["A1", 1],
        ["B1", 2],
        ["C1", 3],
      ]);
    });
  });
});
