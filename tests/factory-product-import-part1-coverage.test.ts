/**
 * POST /api/factory/bale-products/import-excel
 * (server/routes/factory/products/registerFactoryProductImportRoutesPart1.ts)
 * through the real app, one rolled-back transaction per test.
 *
 * Pinned: malformed uploads are refused before anything is written; every
 * accepted header spelling maps to the same product fields; existing products
 * are matched by article code or by normalized code and their bales renamed.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/bale-products/import-excel";

async function xlsx(headers: string[], rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Products");
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const upload = async (w: FactoryWorld, headers: string[], rows: unknown[][]) =>
  w.agent.post(URL).attach("file", await xlsx(headers, rows), "products.xlsx");

const catalogue = (w: FactoryWorld) =>
  w.q(
    `SELECT p.article_code, p.code, p.name, p.description, p.weight_per_bale_kg::float AS kg,
            p.selling_price::float AS sell, p.production_price::float AS prod, c.name AS category
       FROM factory_bale_products p LEFT JOIN factory_categories c ON c.id = p.category_id
      WHERE p.company_id = $1 ORDER BY p.article_code`,
    [w.companyId]
  );

describe("factory product import refusals", () => {
  it("refuses a missing file, a second file and an unexpected field without writing", async () => {
    await withFactoryWorld(async (w) => {
      const none = await w.agent.post(URL);
      expect(none.status).toBe(400);
      expect(none.body.message).toBe("No file uploaded");
      const file = await xlsx(["articleCode"], [["A1"]]);
      const two = await w.agent.post(URL).attach("file", file, "a.xlsx").attach("file", file, "b.xlsx");
      expect(two.status).toBe(400);
      const field = await w.agent.post(URL).attach("other", file, "a.xlsx");
      expect(field.status).toBe(400);
      expect(await catalogue(w)).toEqual([]);
    });
  });

  it("imports nothing from an empty sheet and reports no detected columns", async () => {
    await withFactoryWorld(async (w) => {
      const res = await upload(w, ["unrelated"], []);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        created: 0,
        updated: 0,
        detectedColumns: { articleCode: null, productionPrice: null, sellingPrice: null },
      });
    });
  });
});

describe("factory product import header spellings", () => {
  it("reads camelCase headers, creates categories once and skips rows without an article code", async () => {
    await withFactoryWorld(async (w) => {
      const res = await upload(
        w,
        ["articleCode", "name", "description", "weightPerBaleKg", "category", "sellingPrice", "productionPrice"],
        [
          ["ART-1", "First", "Soft", 45, "Cotton", "12.5", 8],
          ["ART-2", null, null, null, "cotton", "", null],
          [null, "No code", null, null, null, null, null],
        ]
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        created: 2,
        updated: 0,
        categoriesCreated: 1,
        pricesUpdated: 1,
        skippedNoArticleCode: 1,
      });
      expect(res.body.detectedColumns).toEqual({
        articleCode: "articleCode",
        productionPrice: "productionPrice",
        sellingPrice: "sellingPrice",
      });
      expect(await catalogue(w)).toEqual([
        {
          article_code: "ART-1",
          code: "ART1",
          name: "First",
          description: "Soft",
          kg: 45,
          sell: 12.5,
          prod: 8,
          category: "Cotton",
        },
        {
          article_code: "ART-2",
          code: "ART2",
          name: "ART-2",
          description: null,
          kg: null,
          sell: 0,
          prod: 0,
          category: "Cotton",
        },
      ]);
    });
  });

  it("reads snake_case and titled headers", async () => {
    await withFactoryWorld(async (w) => {
      const snake = await upload(
        w,
        ["article_code", "Name", "Description", "weight_per_bale_kg", "Category", "selling_price", "production_price"],
        [["S-1", "Snake", "d", 30, "Wool", 5, 4]]
      );
      expect(snake.body.detectedColumns).toEqual({
        articleCode: "article_code",
        productionPrice: "production_price",
        sellingPrice: "selling_price",
      });
      const titled = await upload(
        w,
        ["Article Code", "Product Name", "Weight Per Bale", "categoryName", "Selling Price", "Production Price"],
        [["T-1", "Titled", 20, "Wool", 7, 6]]
      );
      expect(titled.body).toMatchObject({ created: 1, categoriesCreated: 0 });
      const pascal = await upload(
        w,
        ["ArticleCode", "productName", "WeightPerBaleKg", "SELLING PRICE", "PRODUCTION PRICE"],
        [["P-1", "Pascal", 10, 3, 2]]
      );
      expect(pascal.body.created).toBe(1);
      const cost = await upload(
        w,
        ["barcode", "articleCode", "weight", "selling price", "cost price"],
        [["X", "C-1", 9, 0, 1]]
      );
      expect(cost.body.detectedColumns).toEqual({
        articleCode: "barcode",
        productionPrice: "cost price",
        sellingPrice: "selling price",
      });
      const costVariants = await upload(w, ["articleCode", "costPrice"], [["C-2", 2]]);
      expect(costVariants.body.pricesUpdated).toBe(1);
      const costSnake = await upload(w, ["articleCode", "cost_price", "productionPrice"], [["C-3", 3]]);
      expect(costSnake.body.pricesUpdated).toBe(1);
      const costTitled = await upload(w, ["articleCode", "Cost Price"], [["C-4", 4]]);
      expect(costTitled.body.pricesUpdated).toBe(1);
      const rows = await catalogue(w);
      expect(rows.map((r) => [r.article_code, r.kg, r.sell, r.prod])).toEqual([
        ["C-1", 9, 0, 1],
        ["C-2", null, 0, 2],
        ["C-3", null, 0, 3],
        ["C-4", null, 0, 4],
        ["P-1", 10, 3, 2],
        ["S-1", 30, 5, 4],
        ["T-1", 20, 7, 6],
      ]);
    });
  });
});

describe("factory product import updates", () => {
  it("updates by article code or normalized code, keeps old values and renames the product's bales", async () => {
    await withFactoryWorld(async (w) => {
      const categoryId = await w.one(
        `INSERT INTO factory_categories (company_id, name) VALUES ($1, 'Kept') RETURNING id`,
        [w.companyId]
      );
      const byArticle = await w.one(
        `INSERT INTO factory_bale_products (company_id, code, article_code, name, weight_per_bale_kg, category_id, selling_price)
         VALUES ($1, 'OLD1', 'OLD-1', 'Old one', 40, $2, 9) RETURNING id`,
        [w.companyId, categoryId]
      );
      await w.q(
        `INSERT INTO factory_bale_products (company_id, code, article_code, name) VALUES ($1, 'OLD2', 'legacy', 'Old two')`,
        [w.companyId]
      );
      await w.q(
        `INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, product_name, weight_kg, status, product_id)
         VALUES ($1, $2, $2, 'OLD-1', 'Old one', 40, 'IN_STOCK', $3)`,
        [w.companyId, `${w.tag}-B`, byArticle]
      );
      const res = await upload(
        w,
        ["articleCode", "name", "productionPrice"],
        [
          ["OLD-1", "New one", null],
          ["old-2", "New two", 3],
        ]
      );
      expect(res.body).toMatchObject({ created: 0, updated: 2, pricesUpdated: 1 });
      const rows = await catalogue(w);
      expect(rows.map((r) => [r.article_code, r.name, r.kg, r.sell, r.prod, r.category])).toEqual([
        ["OLD-1", "New one", 40, 9, 0, "Kept"],
        ["legacy", "New two", null, 0, 3, null],
      ]);
      const [bale] = await w.q(`SELECT product_name FROM factory_bales WHERE product_id = $1`, [byArticle]);
      expect(bale.product_name).toBe("New one");
    });
  });
});
