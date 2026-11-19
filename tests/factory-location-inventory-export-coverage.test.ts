/**
 * Location inventory Excel export over HTTP against PostgreSQL (one rolled-back
 * transaction per test): only free IN_STOCK bales of the location, grouped
 * by product into main and wiper/garbage sheets, with cost and selling price
 * columns hidden by query, company settings or the user's export visibility.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const url = (locationId: number | string) => `/api/factory/location-inventory/${locationId}/export/excel`;

const binary = (res: any, callback: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
};

async function seed(w: FactoryWorld) {
  const category = (name: string) =>
    w.one(`INSERT INTO factory_categories (company_id, name) VALUES ($1, $2) RETURNING id`, [w.companyId, name]);
  const product = async (code: string, name: string, categoryId: number) =>
    w.one(
      `INSERT INTO factory_bale_products (company_id, code, name, article_code, category_id, production_price, selling_price)
       VALUES ($1, $2, $3, $2, $4, '10.5', '20') RETURNING id`,
      [w.companyId, `${w.tag}${code}`, name, categoryId]
    );
  const shirts = await product("SH", "Shirts", await category("Mixed Clothing"));
  const wipers = await product("WP", "Wipers", await category("Wiper Rags"));
  let n = 0;
  const bale = (
    productId: number | null,
    name: string | null,
    extra: { status?: string; category?: string; location?: number } = {}
  ) =>
    w.one(
      `INSERT INTO factory_bales (company_id, bale_code, reference_number, product_id, product_name, article_code, category,
         grade, weight_kg, cost_per_kg, total_cost, status, erp_location_id)
       VALUES ($1, $2, $2, $3, $4, NULL, $5, 'A', 25, 0.4, 10, $6, $7) RETURNING id`,
      [
        w.companyId,
        `${w.tag}B${++n}`,
        productId,
        name,
        extra.category ?? null,
        extra.status ?? "IN_STOCK",
        extra.location ?? w.locationId,
      ]
    );
  for (let i = 0; i < 3; i++) await bale(shirts, "Shirts");
  await bale(wipers, "Wipers");
  await bale(wipers, "Wipers");
  await bale(null, null, { category: "Garbage" });
  await bale(null, "Loose Mix");
  await bale(shirts, "Shirts", { status: "SOLD" });
  const loaded = await bale(shirts, "Shirts");
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Loader') RETURNING id`,
    [w.companyId, `${w.tag}C`]
  );
  const orderId = await w.one(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status) VALUES ($1, $2, '2026-06-01', 'LOADING') RETURNING id`,
    [w.companyId, customerId]
  );
  await w.q(
    `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used) VALUES ($1, $2, 'ref', $3, 25, 5)`,
    [orderId, loaded, w.locationId]
  );
}

async function workbook(w: FactoryWorld, query: Record<string, string> = {}) {
  const res = await w.agent.get(url(w.locationId)).query(query).buffer(true).parse(binary);
  expect(res.status).toBe(200);
  expect(res.headers["content-disposition"]).toMatch(
    new RegExp(`inventory_location_${w.locationId}_\\d{4}-\\d{2}-\\d{2}\\.xlsx`)
  );
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(res.body);
  const sheet = (name: string) => {
    const rows: unknown[][] = [];
    book.getWorksheet(name)!.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
    return rows;
  };
  return sheet;
}

describe("location inventory Excel export", () => {
  it("groups free stock into main and wiper/garbage sheets with cost and selling values", async () => {
    await withFactoryWorld(async (w) => {
      await seed(w);
      const sheet = await workbook(w);
      const summary = sheet("Stock Summary");
      expect(summary[0]).toEqual([
        "Article Code",
        "Product Name",
        "Category",
        "Bales",
        "Wt/Bale (kg)",
        "Total KG",
        "Rate (Cost)",
        "Total Cost",
        "Sell Price",
        "Total Sell Value",
      ]);
      const shirts = summary.find((r) => r[1] === "Shirts")!;
      expect(shirts.slice(2, 10)).toEqual(["Mixed Clothing", 3, 25, 75, 10.5, 31.5, 20, 60]);
      expect(summary.some((r) => r[1] === "Loose Mix")).toBe(true);
      expect(summary.at(-1)![1]).toBe("TOTAL — 2 products");

      const wipers = sheet("Wipers & Garbage");
      expect(wipers.find((r) => r[1] === "Wipers")!.slice(2, 6)).toEqual(["Wiper Rags", 2, 25, 50]);
      expect(wipers.find((r) => r[1] === "Unknown")![2]).toBe("Garbage");

      expect(sheet("Bale Details")).toHaveLength(1 + 4);
      const garbage = sheet("Garbage & Wiper Details");
      expect(garbage.at(-1)!.slice(3, 9)).toEqual(["TOTAL — 3 bales", "", "", 75, "", 30]);
    });
  });

  it("hides cost and selling columns by query, by company settings and for an empty location", async () => {
    await withFactoryWorld(async (w) => {
      await seed(w);
      const plain = await workbook(w, { includeCost: "0", includeSellPrice: "0" });
      expect(plain("Stock Summary")[0]).toHaveLength(6);
      expect(plain("Bale Details")[0]).toHaveLength(6);
      expect(plain("Garbage & Wiper Details")[0]).toHaveLength(7);

      await w.q(
        `INSERT INTO factory_settings (company_id, hide_avg_cost, hide_selling_price) VALUES ($1, TRUE, FALSE)`,
        [w.companyId]
      );
      const settings = await workbook(w);
      expect(settings("Stock Summary")[0]).toEqual(expect.arrayContaining(["Sell Price"]));
      expect(settings("Stock Summary")[0]).not.toContain("Rate (Cost)");

      const emptyLocation = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Empty') RETURNING id`,
        [w.companyId, `${w.tag}E`]
      );
      const res = await w.agent.get(url(emptyLocation)).buffer(true).parse(binary);
      expect(res.status).toBe(200);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(res.body);
      expect(book.getWorksheet("Garbage & Wiper Details")!.rowCount).toBe(1);
      expect((await w.agent.get(url("abc"))).status).toBe(400);
    });
  });
});
