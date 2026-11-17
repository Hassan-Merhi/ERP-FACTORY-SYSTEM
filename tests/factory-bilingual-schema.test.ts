import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  baleRecodeItems,
  customerDispatchBaleScans,
  customerOrderBaleRemovals,
  customerOrderBales,
  customerOrderBalesHistory,
  customerOrderExpectedLines,
  customerOrderLines,
  customerProformaLines,
  factoryBaleProducts,
  factoryBales,
  factoryCategories,
  factoryInvoiceLoadingBales,
  factoryPosSaleItems,
  factoryV3LoadBales,
  insertFactoryBaleProductSchema,
  insertFactoryBaleSchema,
  insertFactoryCategorySchema,
} from "../shared/schema";

function expectColumnProperties(table: Parameters<typeof getTableColumns>[0], properties: string[]) {
  const columns = getTableColumns(table);
  expect(Object.keys(columns)).toEqual(expect.arrayContaining(properties));
}

describe("Phase 2 Factory bilingual schema", () => {
  it("exposes additive Arabic catalog and snapshot columns", () => {
    expectColumnProperties(factoryCategories, ["nameAr"]);
    expectColumnProperties(factoryBaleProducts, ["nameAr", "descriptionAr"]);
    expectColumnProperties(factoryBales, ["productNameAr", "categoryAr"]);
    expectColumnProperties(customerProformaLines, ["productNameAr"]);
    expectColumnProperties(customerOrderLines, ["baleNameAr"]);
    expectColumnProperties(customerOrderBales, ["baleNameAr"]);
    expectColumnProperties(customerOrderBalesHistory, ["baleNameAr"]);
    expectColumnProperties(customerOrderExpectedLines, ["productNameAr"]);
    expectColumnProperties(factoryPosSaleItems, ["productNameAr"]);
    expectColumnProperties(customerOrderBaleRemovals, ["productNameAr"]);
    expectColumnProperties(factoryV3LoadBales, ["productNameAr"]);
    expectColumnProperties(factoryInvoiceLoadingBales, ["productNameAr"]);
    expectColumnProperties(customerDispatchBaleScans, ["productNameAr"]);
    expectColumnProperties(baleRecodeItems, ["productNameAr"]);
  });

  it("keeps Arabic Unicode unchanged through catalog and bale input schemas", () => {
    const productNameAr = "حقيبة رجالية كريمي 20 كغ";
    const categoryNameAr = "حقائب وأحزمة";
    const descriptionAr = "وصف عربي محفوظ كما أُدخل";

    const category = insertFactoryCategorySchema.parse({
      companyId: 1,
      name: "BAGS & BELTS",
      nameAr: categoryNameAr,
    });
    const product = insertFactoryBaleProductSchema.parse({
      companyId: 1,
      articleCode: "00-AR-019",
      name: "MEN BAG CREAM 20KG",
      nameAr: productNameAr,
      descriptionAr,
    });
    const bale = insertFactoryBaleSchema.parse({
      companyId: 1,
      baleCode: "B000001",
      referenceNumber: "REF-000001",
      articleCode: "00-AR-019",
      productName: "MEN BAG CREAM 20KG",
      productNameAr,
      category: "BAGS & BELTS",
      categoryAr: categoryNameAr,
      weightKg: "20.000",
    });
    const roundTrip = JSON.parse(JSON.stringify({ category, product, bale }));

    expect(roundTrip.category.nameAr).toBe(categoryNameAr);
    expect(roundTrip.product.nameAr).toBe(productNameAr);
    expect(roundTrip.product.descriptionAr).toBe(descriptionAr);
    expect(roundTrip.bale.productNameAr).toBe(productNameAr);
    expect(roundTrip.bale.categoryAr).toBe(categoryNameAr);
    expect(roundTrip.product.name).toBe("MEN BAG CREAM 20KG");
  });

  const databaseIt = process.env.DATABASE_URL ? it : it.skip;

  databaseIt(
    "has the migrated bilingual columns and round-trips Arabic text without changing English snapshots",
    async () => {
      // The database is built from migrations/ (the bilingual catalog columns are
      // part of the baseline); nothing is installed at runtime.
      const { pool } = await import("../server/db");

      const requiredColumns = [
        ["factory_categories", "name_ar"],
        ["factory_bale_products", "name_ar"],
        ["factory_bale_products", "description_ar"],
        ["factory_bales", "product_name_ar"],
        ["factory_bales", "category_ar"],
        ["customer_proforma_lines", "product_name_ar"],
        ["customer_order_lines", "bale_name_ar"],
        ["customer_order_bales", "bale_name_ar"],
        ["customer_order_bales_history", "bale_name_ar"],
        ["customer_order_expected_lines", "product_name_ar"],
      ];

      for (const [tableName, columnName] of requiredColumns) {
        const result = await pool.query(
          `SELECT 1
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = $1
            AND column_name = $2`,
          [tableName, columnName]
        );
        expect(result.rowCount).toBe(1);
      }

      const indexResult = await pool.query(
        `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'factory_bale_products_company_article_code_normalized_idx'`
      );
      expect(indexResult.rowCount).toBe(1);
      // article_code is text in the migrated schema, so PostgreSQL renders no ::text cast.
      expect(indexResult.rows[0].indexdef.toUpperCase()).toContain("UPPER(BTRIM(ARTICLE_CODE))");

      const client = await pool.connect();
      const suffix = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
      const englishProductName = `PHASE2 ENGLISH PRODUCT ${suffix}`;
      const arabicProductName = "حقيبة رجالية كريمي 20 كغ";
      const englishCategoryName = `PHASE2 ENGLISH CATEGORY ${suffix}`;
      const arabicCategoryName = "حقائب وأحزمة";
      const arabicDescription = "وصف عربي محفوظ كما أُدخل";
      const articleCode = `00-AR-${suffix}`.slice(0, 50);

      try {
        await client.query("BEGIN");
        const companyResult = await client.query(
          `INSERT INTO companies (code, name, company_type, base_currency)
         VALUES ($1, $2, 'factory', 'USD')
         RETURNING id`,
          [`P2C${suffix}`.slice(0, 50), `Phase 2 Bilingual Test ${suffix}`]
        );
        const companyId = companyResult.rows[0].id;

        const categoryResult = await client.query(
          `INSERT INTO factory_categories (company_id, name, name_ar)
         VALUES ($1, $2, $3)
         RETURNING id, name, name_ar`,
          [companyId, englishCategoryName, arabicCategoryName]
        );
        const categoryId = categoryResult.rows[0].id;

        const productResult = await client.query(
          `INSERT INTO factory_bale_products
           (company_id, code, article_code, name, name_ar, description_ar, category_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, name_ar, description_ar`,
          [
            companyId,
            `P2${suffix}`.slice(0, 50),
            articleCode,
            englishProductName,
            arabicProductName,
            arabicDescription,
            categoryId,
          ]
        );
        const productId = productResult.rows[0].id;

        const baleResult = await client.query(
          `INSERT INTO factory_bales
           (company_id, product_id, bale_code, reference_number, article_code,
            product_name, product_name_ar, category, category_ar, weight_kg)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING product_name, product_name_ar, category, category_ar`,
          [
            companyId,
            productId,
            `B${suffix}`.slice(0, 50),
            `REF-${suffix}`.slice(0, 100),
            articleCode,
            englishProductName,
            arabicProductName,
            englishCategoryName,
            arabicCategoryName,
            "20.000",
          ]
        );

        expect(categoryResult.rows[0]).toMatchObject({
          name: englishCategoryName,
          name_ar: arabicCategoryName,
        });
        expect(productResult.rows[0]).toMatchObject({
          name: englishProductName,
          name_ar: arabicProductName,
          description_ar: arabicDescription,
        });
        expect(baleResult.rows[0]).toMatchObject({
          product_name: englishProductName,
          product_name_ar: arabicProductName,
          category: englishCategoryName,
          category_ar: arabicCategoryName,
        });
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    }
  );
});
