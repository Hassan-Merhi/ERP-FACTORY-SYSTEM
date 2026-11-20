/**
 * Factory location inventory (GET /api/factory/location-inventory/:locationId
 * and its /available variant) over HTTP, one rolled-back transaction per test.
 *
 * Pinned: bales group by product id, else by article code (case-insensitive
 * product match), else by bale code; names, categories and prices fall back
 * from product to bale; bales on outbound orders of this company are hidden;
 * another company's location and products are never visible.
 *
 * Observed: loadingCount is always 0. The stock query already excludes bales on
 * this company's LOADING / PENDING_VERIFICATION / VERIFIED orders, and an
 * active order of another company that references the bale is not visible
 * through the tenant-scoped read, so the "loading" lookup never matches.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const BASE = "/api/factory/location-inventory";

async function otherCompany(w: FactoryWorld) {
  const companyId = await w.one(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
    [`${w.tag}X`]
  );
  const locationId = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Far') RETURNING id`, [
    companyId,
    `${w.tag}XL`,
  ]);
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Far customer') RETURNING id`,
    [companyId, `${w.tag}XC`]
  );
  return { companyId, locationId, customerId };
}

async function seed(w: FactoryWorld) {
  const other = await otherCompany(w);
  const categoryId = await w.one(
    `INSERT INTO factory_categories (company_id, name) VALUES ($1, 'Shirts') RETURNING id`,
    [w.companyId]
  );
  const foreignCategory = await w.one(
    `INSERT INTO factory_categories (company_id, name) VALUES ($1, 'Hidden') RETURNING id`,
    [other.companyId]
  );
  const shirt = await w.one(
    `INSERT INTO factory_bale_products (company_id, code, name, name_ar, article_code, category_id, production_price, selling_price)
     VALUES ($1, 'P-SH', 'Shirt', 'قميص', 'ART-SH', $2, '4', '19') RETURNING id`,
    [w.companyId, categoryId]
  );
  await w.one(
    `INSERT INTO factory_bale_products (company_id, code, name, article_code, category_id, production_price, selling_price)
     VALUES ($1, 'P-JK', 'Jacket', 'art-jk', $2, NULL, NULL) RETURNING id`,
    [w.companyId, foreignCategory]
  );
  const farProduct = await w.one(
    `INSERT INTO factory_bale_products (company_id, code, name, article_code) VALUES ($1, 'P-FAR', 'Far product', 'ART-FAR') RETURNING id`,
    [other.companyId]
  );
  const bale = (values: {
    ref: string;
    productId?: number | null;
    article?: string | null;
    name?: string | null;
    category?: string | null;
    quantity?: number;
    weight?: string;
    status?: string;
    locationId?: number;
    companyId?: number;
    reference?: string | null;
  }) =>
    w.one(
      `INSERT INTO factory_bales (company_id, bale_code, reference_number, product_id, article_code, product_name,
         category, quantity, weight_kg, status, erp_location_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        values.companyId ?? w.companyId,
        `${w.tag}${values.ref}`,
        values.reference === undefined ? `${w.tag}R${values.ref}` : values.reference,
        values.productId ?? null,
        values.article ?? null,
        values.name ?? null,
        values.category ?? null,
        values.quantity ?? 1,
        values.weight ?? "10",
        values.status ?? "IN_STOCK",
        values.locationId ?? w.locationId,
      ]
    );
  const order = async (companyId: number, customerId: number, status: string, baleId: number, deleted = false) => {
    const orderId = await w.one(
      `INSERT INTO customer_orders (company_id, customer_id, order_date, status, location_id, deleted_at)
       VALUES ($1, $2, '2026-06-01', $3, $4, $5) RETURNING id`,
      [companyId, customerId, status, w.locationId, deleted ? new Date() : null]
    );
    await w.one(
      `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used)
       VALUES ($1, $2, 'ref', $3, 10, 5) RETURNING id`,
      [orderId, baleId, w.locationId]
    );
  };
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Near customer') RETURNING id`,
    [w.companyId, `${w.tag}NC`]
  );

  await bale({ ref: "S1", productId: shirt, weight: "12.5", category: "ignored" });
  const shirtOnForeignOrder = await bale({ ref: "S2", productId: shirt, reference: "", weight: "7.5" });
  await order(other.companyId, other.customerId, "LOADING", shirtOnForeignOrder);
  await bale({ ref: "J1", article: "ART-JK", category: "Outerwear" });
  await bale({ ref: "U1", productId: farProduct, article: "NOPE", name: "Loose rag", category: "Rags" });
  await bale({ ref: "U2", article: null, name: null });
  await bale({ ref: "U3", article: "ART-FAR", name: "Far named" });
  const reserved = await bale({ ref: "H1", productId: shirt });
  await order(w.companyId, customerId, "VERIFIED", reserved);
  const sold = await bale({ ref: "H2", productId: shirt });
  await order(w.companyId, customerId, "SOLD", sold);
  const cancelled = await bale({ ref: "S3", productId: shirt });
  await order(w.companyId, customerId, "CANCELLED", cancelled);
  const deletedOrder = await bale({ ref: "S4", productId: shirt });
  await order(w.companyId, customerId, "LOADING", deletedOrder, true);
  await bale({ ref: "H3", productId: shirt, status: "SOLD" });
  await bale({ ref: "H4", productId: shirt, companyId: other.companyId, locationId: other.locationId });
  return { other, shirt, farProduct };
}

describe("factory location inventory", () => {
  it("groups bales with product, article and bale-code fallbacks", async () => {
    await withFactoryWorld(async (w) => {
      const { shirt, farProduct } = await seed(w);
      const res = await w.agent.get(`${BASE}/${w.locationId}`);
      expect(res.status).toBe(200);
      const byName = Object.fromEntries(res.body.map((row: { productName: string }) => [row.productName, row]));
      expect(Object.keys(byName).sort()).toEqual(["Far named", "Jacket", "Loose rag", "Shirt", "Unknown"]);
      expect(byName.Shirt).toMatchObject({
        productId: shirt,
        articleCode: "ART-SH",
        productNameAr: "قميص",
        category: "Shirts",
        quantity: 4,
        totalWeight: 40,
        totalCost: 16,
        baleCount: 4,
        loadingCount: 0,
        sellingPrice: "19.00",
        productionPrice: 4,
      });
      expect(byName.Shirt.referenceNumbers).toHaveLength(3);
      expect(byName.Jacket).toMatchObject({
        articleCode: "art-jk",
        category: "Outerwear",
        sellingPrice: "0",
        productionPrice: 0,
        productNameAr: null,
      });
      expect(byName["Loose rag"]).toMatchObject({ productId: farProduct, articleCode: "NOPE", category: "Rags" });
      expect(byName.Unknown).toMatchObject({
        productId: 0,
        articleCode: `${w.tag}U2`,
        category: null,
        categoryId: null,
      });
      expect(byName["Far named"]).toMatchObject({ productId: 0, articleCode: "ART-FAR" });
    });
  });

  it("the available view returns the same groups with no reservations", async () => {
    await withFactoryWorld(async (w) => {
      await seed(w);
      const res = await w.agent.get(`${BASE}/${w.locationId}/available`);
      expect(res.status).toBe(200);
      const shirt = res.body.find((row: { productName: string }) => row.productName === "Shirt");
      expect(shirt).toMatchObject({
        baleCount: 4,
        quantity: 4,
        reservedQty: 0,
        availableQty: 4,
        reservations: [],
        category: "Shirts",
      });
      expect(shirt).not.toHaveProperty("loadingCount");
      const jacket = res.body.find((row: { productName: string }) => row.productName === "Jacket");
      expect(jacket).toMatchObject({ category: "Outerwear", sellingPrice: "0" });
      expect(res.body.map((row: { productName: string }) => row.productName)).toEqual([
        "Far named",
        "Jacket",
        "Loose rag",
        "Shirt",
        "Unknown",
      ]);
    });
  });

  it("an empty location and another company's location both return nothing", async () => {
    await withFactoryWorld(async (w) => {
      const { other } = await seed(w);
      for (const suffix of ["", "/available"]) {
        const foreign = await w.agent.get(`${BASE}/${other.locationId}${suffix}`);
        expect(foreign.status).toBe(200);
        expect(foreign.body).toEqual([]);
      }
      const empty = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Empty') RETURNING id`,
        [w.companyId, `${w.tag}E`]
      );
      expect((await w.agent.get(`${BASE}/${empty}`)).body).toEqual([]);
      expect((await w.agent.get(`${BASE}/${empty}/available`)).body).toEqual([]);
    });
  });

  it("refuses a malformed location id", async () => {
    await withFactoryWorld(async (w) => {
      for (const path of [`${BASE}/abc`, `${BASE}/0/available`]) {
        const res = await w.agent.get(path);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe("Invalid id");
      }
    });
  });
});
