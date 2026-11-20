/**
 * POST /api/factory/bale-products/:id/cascade-update (productCascadeRoutes)
 * through the real app inside one rolled-back transaction: body, id and
 * company checks, name and article-code conflicts, grade rules (invalid grade,
 * manual code outside the grade range, generated code past taken ones),
 * price validation, the admin-only label colour, and the cascade of name,
 * weight, article code and grade onto the product's bales. Every refusal
 * leaves the product and its bales unchanged.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const url = (id: number | string) => `/api/factory/bale-products/${id}/cascade-update`;

async function productWithBale(w: FactoryWorld, articleCode = "HMD11001", name = "Cream mix") {
  const productId = await w.one(
    `INSERT INTO factory_bale_products (company_id, code, article_code, name, weight_per_bale_kg, label_design_color)
     VALUES ($1, $2, $3, $4, 45, '#111111') RETURNING id`,
    [w.companyId, articleCode.replace(/[^A-Z0-9]/gi, "").toUpperCase(), articleCode, name]
  );
  const baleId = await w.one(
    `INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, product_name, product_id,
       weight_kg, status)
     VALUES ($1, $2, $2, $3, $4, $5, 45, 'IN_STOCK') RETURNING id`,
    [w.companyId, `${w.tag}-${articleCode}`, articleCode, name, productId]
  );
  return { productId, baleId };
}

const state = async (w: FactoryWorld, productId: number, baleId: number) => ({
  product: (
    await w.q(
      `SELECT name, article_code, code, selling_price::text AS selling, label_design_color AS color
         FROM factory_bale_products WHERE id = $1`,
      [productId]
    )
  )[0],
  bale: (
    await w.q(`SELECT product_name, article_code, weight_kg::text AS kg, grade FROM factory_bales WHERE id = $1`, [
      baleId,
    ])
  )[0],
});

describe("product cascade update refusals", () => {
  it("refuses bad ids, other companies, conflicts, bad grades and prices", () =>
    withFactoryWorld(async (w) => {
      const { productId, baleId } = await productWithBale(w);
      await productWithBale(w, "HMD12001", "Grade two");
      const before = await state(w, productId, baleId);
      const post = (body: unknown, id: number | string = productId) =>
        w.agent.post(url(id)).set("Content-Type", "application/json").send(JSON.stringify(body));

      expect((await post({}, "abc")).status).toBe(400);
      expect((await post([1, 2])).body.message).toBe("A valid product update is required");
      expect((await post({ name: "x" }, 2147483000)).status).toBe(404);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const theirs = await w.one(
        `INSERT INTO factory_bale_products (company_id, code, name) VALUES ($1, $2, 'Theirs') RETURNING id`,
        [other, `${w.tag}T`]
      );
      expect((await post({ name: "Mine" }, theirs)).status).toBe(404);

      expect((await post({ name: null })).body.message).toBe("Product name must be a non-empty string");
      expect((await post({ name: "GRADE TWO" })).body.message).toBe('A product named "GRADE TWO" already exists');
      expect((await post({ grade: "#9" })).body.message).toMatch(/Valid grade is required/);
      expect((await post({ grade: "#1", articleCode: "HMD12077" })).body.message).toBe(
        "Article code for grade #1 must start with HMD11"
      );
      expect((await post({ articleCode: "HMD12001" })).body.message).toBe(
        "A product with this article code already exists"
      );
      expect((await post({ sellingPrice: "abc" })).body.message).toBe(
        "Selling price must be a valid non-negative number"
      );
      expect((await post({ productionPrice: -1 })).body.message).toBe("Cost price must be a valid non-negative number");
      expect((await post({ productionPrice: true })).status).toBe(400);
      const manager = await w.agentFor("Manager");
      const color = await manager.post(url(productId)).send({ labelDesignColor: "#ff0000" });
      expect(color.status).toBe(403);
      expect(await state(w, productId, baleId)).toEqual(before);
    }));
});

describe("product cascade update", () => {
  it("cascades name, weight and a regenerated grade code to the bales", () =>
    withFactoryWorld(async (w) => {
      const { productId, baleId } = await productWithBale(w);
      await productWithBale(w, "HMD13001", "Three a");
      await w.one(
        `INSERT INTO factory_bale_products (company_id, code, article_code, name) VALUES ($1, 'HMD13002', 'X-13', 'Three b') RETURNING id`,
        [w.companyId]
      );
      const res = await w.agent.post(url(productId)).send({
        name: "Renamed",
        weightPerBaleKg: 50,
        grade: "#3",
        sellingPrice: "12.5",
        productionPrice: "",
        labelDesignColor: "#222222",
        description: "d",
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.balesUpdated).toBe(1);
      const after = await state(w, productId, baleId);
      expect(after.product).toMatchObject({
        name: "Renamed",
        article_code: "HMD13003",
        code: "HMD13003",
        color: "#222222",
      });
      expect(Number(after.product.selling)).toBe(12.5);
      expect(after.bale).toMatchObject({ product_name: "Renamed", article_code: "HMD13003", grade: "#3" });
      expect(Number(after.bale.kg)).toBe(50);
    }));

  it("keeps the grade and bales when only prices or an unchanged colour are sent", () =>
    withFactoryWorld(async (w) => {
      const { productId, baleId } = await productWithBale(w);
      const manager = await w.agentFor("Manager");
      const res = await manager
        .post(url(productId))
        .send({ sellingPrice: 3, labelDesignColor: "#111111", weightPerBaleKg: 45, grade: "#1", name: "cream MIX" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.balesUpdated).toBe(1);
      const after = await state(w, productId, baleId);
      expect(after.bale).toMatchObject({ article_code: "HMD11001", product_name: "cream MIX" });

      const manual = await w.agent
        .post(url(productId))
        .send({ grade: "#1", articleCode: "HMD11050", weightPerBaleKg: null });
      expect(manual.status).toBe(200);
      expect((await state(w, productId, baleId)).bale.article_code).toBe("HMD11050");

      const plain = await w.agent.post(url(productId)).send({ articleCode: "CUSTOM-1" });
      expect(plain.body.product.articleCode).toBe("CUSTOM-1");
    }));
});
