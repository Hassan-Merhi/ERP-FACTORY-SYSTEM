/**
 * Bilingual Factory catalog middleware (factoryBilingualCatalogRoutes.ts)
 * through the real HTTP app in one rolled-back transaction per test. The
 * existing factory-bilingual-catalog-api suite covers the English list reads;
 * this pins the Arabic-language reads (query, header and cookie) and the deferred Arabic writes wrapped around product and
 * category create / edit, including the fallback suppression and the failure
 * path when the deferred write is refused by the database.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

async function catalog(w: FactoryWorld) {
  const categoryId = await w.one(
    `INSERT INTO factory_categories (company_id, name, name_ar) VALUES ($1, 'BAGS', 'حقائب') RETURNING id`,
    [w.companyId]
  );
  const productId = await w.one(
    `INSERT INTO factory_bale_products (company_id, code, article_code, name, name_ar, description, category_id)
     VALUES ($1, $2, 'HMD10001', 'MEN BAG', 'حقيبة رجالية', 'Cream grade', $3) RETURNING id`,
    [w.companyId, `${w.tag}P1`, categoryId]
  );
  const plainId = await w.one(
    `INSERT INTO factory_bale_products (company_id, code, article_code, name) VALUES ($1, $2, 'HMD10002', 'BELTS')
     RETURNING id`,
    [w.companyId, `${w.tag}P2`]
  );
  return { categoryId, productId, plainId };
}

describe("bilingual catalog reads", () => {
  it("resolves Arabic display text from the query, header or cookie and searches Arabic text", async () => {
    await withFactoryWorld(async (w) => {
      const { productId, plainId } = await catalog(w);
      const ar = await w.agent.get("/api/factory/bale-products?lang=ar&q=حقيبة");
      expect(ar.status).toBe(200);
      expect(ar.body).toEqual([
        expect.objectContaining({
          id: productId,
          displayName: "حقيبة رجالية",
          displayCategoryName: "حقائب",
          language: "ar",
        }),
      ]);
      const header = await w.agent.get("/api/factory/bale-products").set("x-factory-catalog-language", "ar");
      const plain = header.body.find((p: { id: number }) => p.id === plainId);
      expect(plain).toMatchObject({ displayName: "BELTS", categoryName: null, language: "ar" });

      const categories = await w.agent
        .get("/api/factory/categories?q=حقائب")
        .set("Cookie", "factory_catalog_language=ar");
      expect(categories.status).toBe(200);
      expect(categories.body).toHaveLength(1);
      expect(categories.body[0]).toMatchObject({ nameEn: "BAGS", nameAr: "حقائب" });

      const detail = await w.agent.get(`/api/factory/bale-products/${productId}?lang=ar`);
      expect(detail.status).toBe(200);
      const legacy = await w.agent.get("/api/factory/categories?legacy=1");
      expect(legacy.status).toBe(200);
      expect(legacy.body[0]).not.toHaveProperty("displayName");
    });
  });
});

describe("bilingual catalog writes", () => {
  it("stores Arabic names given at product and category creation", async () => {
    await withFactoryWorld(async (w) => {
      const product = await w.agent.post("/api/factory/bale-products").send({
        code: `${w.tag}NEW`,
        articleCode: "HMD10099",
        nameEn: "  KIDS MIX ",
        nameAr: " خليط أطفال ",
        descriptionEn: "Mixed",
        descriptionAr: "",
      });
      expect(product.status).toBeLessThan(300);
      const [stored] = await w.q(
        `SELECT name, name_ar, description, description_ar FROM factory_bale_products WHERE company_id = $1 AND article_code = 'HMD10099'`,
        [w.companyId]
      );
      expect(stored).toEqual({ name: "KIDS MIX", name_ar: "خليط أطفال", description: "Mixed", description_ar: null });

      const category = await w.agent.post("/api/factory/categories").send({ name: "SHOES", nameAr: "أحذية" });
      expect(category.status).toBe(200);
      expect(category.body).toMatchObject({ name: "SHOES", nameAr: "أحذية" });
      const noArabic = await w.agent.post("/api/factory/categories").send({ name: "HATS", nameAr: 7 });
      expect(noArabic.body.nameAr).toBeNull();
    });
  });

  it("edits Arabic names in Arabic mode without promoting unchanged fallbacks", async () => {
    await withFactoryWorld(async (w) => {
      const { categoryId, productId, plainId } = await catalog(w);
      const renamed = await w.agent
        .patch(`/api/factory/bale-products/${productId}?lang=ar`)
        .send({ name: "حقيبة جديدة", description: "وصف" });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ name: "MEN BAG", nameAr: "حقيبة جديدة", descriptionAr: "وصف" });

      const fallback = await w.agent.patch(`/api/factory/bale-products/${plainId}?lang=ar`).send({ name: "BELTS" });
      expect(fallback.status).toBe(200);
      const [plain] = await w.q(`SELECT name, name_ar FROM factory_bale_products WHERE id = $1`, [plainId]);
      expect(plain).toEqual({ name: "BELTS", name_ar: null });

      const explicit = await w.agent.patch(`/api/factory/bale-products/${plainId}`).send({ nameAr: "أحزمة" });
      expect(explicit.body.nameAr).toBe("أحزمة");
      const missing = await w.agent.patch(`/api/factory/bale-products/999999999`).send({ nameAr: "x" });
      expect(missing.status).toBe(404);

      const cat = await w.agent.patch(`/api/factory/categories/${categoryId}`).send({ nameAr: "حقائب يد" });
      expect(cat.body).toMatchObject({ name: "BAGS", nameAr: "حقائب يد" });
      const catAr = await w.agent.patch(`/api/factory/categories/${categoryId}?lang=ar`).send({ name: "شنط" });
      expect(catAr.body).toMatchObject({ name: "BAGS", nameAr: "شنط" });
      const unchanged = await w.agent.patch(`/api/factory/categories/${categoryId}`).send({ name: "BAGS 2" });
      expect(unchanged.body).toMatchObject({ name: "BAGS 2", nameAr: "شنط" });
    });
  });

  it("returns 500 when the deferred Arabic category name is refused by the database", async () => {
    await withFactoryWorld(async (w) => {
      const { categoryId } = await catalog(w);
      const res = await w.agent.patch(`/api/factory/categories/${categoryId}`).send({ nameAr: "ع".repeat(150) });
      expect(res.status).toBe(500);
      expect(res.body.message).toEqual(expect.any(String));
    });
  });
});
