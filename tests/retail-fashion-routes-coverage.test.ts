/**
 * server/routes/registerRetailFashionRoutes.ts over HTTP against PostgreSQL,
 * one rolled-back retail company per test.
 *
 * Pinned: quick add refuses a non-retail company, an invalid body, repeated
 * colour/size or barcode in one submission, another company's location or
 * brand, an existing variant and a barcode already in use; it creates a style
 * under an explicit brand or the default "no brand", extends and reactivates
 * an archived style, generates or keeps barcodes, and replays the same key.
 * Styles filter by brand; labels refuse unknown variants and mark reprints;
 * label history and archive/restore validate ids and refuse another
 * company's variant or product.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { nextSeq, otherCompany } from "./helpers/voucherReadFixture";

const retail = (w: FactoryWorld) => w.q(`UPDATE companies SET company_type = 'retail' WHERE id = $1`, [w.companyId]);

const quickAdd = (w: FactoryWorld, body: Record<string, unknown>) =>
  w.agent.post("/api/retail/quick-add").send({
    idempotencyKey: `${w.tag}-QA${nextSeq()}`,
    name: "Linen Shirt",
    locationId: w.locationId,
    variants: [{ size: "M", sellingPrice: 20, cost: 8, quantity: 2 }],
    ...body,
  });

describe("retail quick add refusals", () => {
  it("refuses a non-retail company and invalid or self-conflicting bodies", () =>
    withFactoryWorld(async (w) => {
      expect((await quickAdd(w, {})).status).toBe(409);
      await retail(w);
      expect((await quickAdd(w, { variants: [] })).status).toBe(400);
      const dupSize = await quickAdd(w, {
        variants: [
          { size: "M", sellingPrice: 1 },
          { size: " m ", sellingPrice: 2 },
        ],
      });
      expect(dupSize.status).toBe(400);
      expect(dupSize.body.message).toMatch(/Duplicate color\/size/);
      const dupBarcode = await quickAdd(w, {
        variants: [
          { size: "S", sellingPrice: 1, barcode: "B-1" },
          { size: "L", sellingPrice: 1, barcode: "B-1" },
        ],
      });
      expect(dupBarcode.body.message).toMatch(/Duplicate barcode/);
      const other = await otherCompany(w);
      const far = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Far') RETURNING id`, [
        other,
        `${w.tag}FAR`,
      ]);
      expect((await quickAdd(w, { locationId: far })).status).toBe(400);
      const foreignBrand = await w.one(
        `INSERT INTO retail_brands (company_id, name, normalized_name) VALUES ($1, 'Foreign', 'foreign') RETURNING id`,
        [other]
      );
      const brand = await quickAdd(w, { brandId: foreignBrand });
      expect(brand.status).toBe(400);
      expect(brand.body.message).toBe("Brand not found for this company");
      const products = await w.q(`SELECT 1 FROM retail_products WHERE company_id = $1`, [w.companyId]);
      expect(products).toEqual([]);
    }));

  it("refuses an existing variant and a barcode already in use", () =>
    withFactoryWorld(async (w) => {
      await retail(w);
      const first = await quickAdd(w, {
        brandName: "Acme",
        variants: [{ size: "M", sellingPrice: 20, barcode: "TYPED-1" }],
      });
      expect(first.status, first.text).toBe(201);
      const again = await quickAdd(w, { brandName: "Acme", variants: [{ size: "m", sellingPrice: 20 }] });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("VARIANT_EXISTS");
      const barcode = await quickAdd(w, {
        name: "Other Style",
        variants: [{ size: "L", sellingPrice: 5, barcode: "TYPED-1" }],
      });
      expect(barcode.status).toBe(409);
      expect(barcode.body.code).toBe("BARCODE_EXISTS");
    }));
});

describe("retail quick add", () => {
  it("creates under an explicit brand, extends an archived style and replays a key", () =>
    withFactoryWorld(async (w) => {
      await retail(w);
      const brandId = await w.one(
        `INSERT INTO retail_brands (company_id, name, normalized_name) VALUES ($1, 'House', 'house') RETURNING id`,
        [w.companyId]
      );
      const key = `${w.tag}-FIXED`;
      const created = await quickAdd(w, {
        idempotencyKey: key,
        brandId,
        category: "Shirts",
        description: "Summer",
        variants: [
          { size: "S", sellingPrice: 10, quantity: 0 },
          { color: "Red", size: "M", sellingPrice: 12, quantity: 3, sku: "SKU-1" },
        ],
      });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ replayed: false, createdProduct: true });
      expect(created.body.variants.map((v: { receivedQuantity: number }) => v.receivedQuantity).sort()).toEqual([0, 3]);
      const replay = await quickAdd(w, { idempotencyKey: key, brandId });
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ replayed: true, productId: created.body.productId });

      await w.q(`UPDATE retail_products SET active = false WHERE id = $1`, [created.body.productId]);
      const extended = await quickAdd(w, {
        brandId,
        name: "  linen   SHIRT ",
        variants: [{ size: "XL", sellingPrice: 15 }],
      });
      expect(extended.status).toBe(201);
      expect(extended.body).toMatchObject({ createdProduct: false, productId: created.body.productId });
      const [style] = await w.q(`SELECT active FROM retail_products WHERE id = $1`, [created.body.productId]);
      expect(style.active).toBe(true);

      const styles = await w.agent.get("/api/retail/styles").query({ brandId });
      expect(styles.body.map((s: { name: string }) => s.name)).toEqual(["Linen Shirt"]);
      const unbranded = await quickAdd(w, { name: "Plain Tee" });
      expect(unbranded.status).toBe(201);
      expect((await w.agent.get("/api/retail/styles").query({ brandId: "x" })).body).toHaveLength(2);
    }));
});

describe("retail labels and archive", () => {
  it("prints labels, marks reprints and refuses unknown variants", () =>
    withFactoryWorld(async (w) => {
      await retail(w);
      const created = await quickAdd(w, { variants: [{ size: "M", sellingPrice: 20 }] });
      const variantId = created.body.variantIds[0];
      expect((await w.agent.post("/api/retail/labels").send({ layout: "nope", items: [{ variantId }] })).status).toBe(
        400
      );
      const missing = await w.agent
        .post("/api/retail/labels")
        .send({ layout: "a4-24", items: [{ variantId: 999999999 }] });
      expect(missing.status).toBe(404);
      const first = await w.agent
        .post("/api/retail/labels")
        .send({ layout: "a4-24", items: [{ variantId, copies: 2 }, { variantId }] });
      expect(first.status).toBe(201);
      expect(first.body.labels[0]).toMatchObject({ copies: 3, isReprint: false, brand: expect.any(String) });
      const reprint = await w.agent
        .post("/api/retail/labels")
        .send({ layout: "thermal-50x30", items: [{ variantId }] });
      expect(reprint.body.labels[0].isReprint).toBe(true);
      expect((await w.agent.get("/api/retail/variants/abc/labels")).status).toBe(400);
      expect((await w.agent.get(`/api/retail/variants/${variantId}/labels`)).body).toHaveLength(2);
    }));

  it("archives and restores variants and products within the company only", () =>
    withFactoryWorld(async (w) => {
      await retail(w);
      const created = await quickAdd(w, { variants: [{ size: "M", sellingPrice: 20 }] });
      const variantId = created.body.variantIds[0];
      const productId = created.body.productId;
      expect((await w.agent.patch("/api/retail/variants/0/active").send({ active: false })).status).toBe(400);
      expect((await w.agent.patch(`/api/retail/variants/${variantId}/active`).send({ active: "no" })).status).toBe(400);
      expect((await w.agent.patch("/api/retail/variants/999999999/active").send({ active: false })).status).toBe(404);
      expect((await w.agent.patch(`/api/retail/products/${productId}/active`).send({ active: false })).status).toBe(
        200
      );
      expect((await w.agent.patch(`/api/retail/variants/${variantId}/active`).send({ active: false })).body).toEqual({
        id: variantId,
        active: false,
      });
      expect((await w.agent.patch(`/api/retail/variants/${variantId}/active`).send({ active: true })).status).toBe(200);
      const [style] = await w.q(`SELECT active FROM retail_products WHERE id = $1`, [productId]);
      expect(style.active).toBe(true);
      expect((await w.agent.patch("/api/retail/products/abc/active").send({ active: true })).status).toBe(400);
      expect((await w.agent.patch("/api/retail/products/999999999/active").send({ active: true })).status).toBe(404);
      expect((await w.agent.patch(`/api/retail/products/${productId}/active`).send({})).status).toBe(400);

      const other = await otherCompany(w);
      const foreignProduct = await w.one(
        `INSERT INTO retail_products (company_id, code, name) VALUES ($1, $2, 'Foreign') RETURNING id`,
        [other, `${w.tag}FP`]
      );
      expect(
        (await w.agent.patch(`/api/retail/products/${foreignProduct}/active`).send({ active: false })).status
      ).toBe(404);
      const [foreign] = await w.q(`SELECT active FROM retail_products WHERE id = $1`, [foreignProduct]);
      expect(foreign.active).toBe(true);
    }));
});
