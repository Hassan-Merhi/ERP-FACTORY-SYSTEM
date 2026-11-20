/**
 * Factory all-locations inventory workbook
 * (/api/factory/location-inventory/export/all) through the real app in one
 * rolled-back transaction: in-stock bales across two locations and none,
 * product and bale categories (wipers / garbage on their own sheets), bales
 * held on an active loading left out, and the cost columns with cost shown,
 * turned off by the request, or hidden by the factory settings.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { loadingWithBales } from "./helpers/dispatchFlowFixture";

const URL = "/api/factory/location-inventory/export/all";
let seq = 0;

function binary(res: { on: (e: string, cb: (c?: Buffer) => void) => void }, cb: (e: Error | null, b: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (c) => chunks.push(c!));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

async function seed(w: FactoryWorld) {
  const store = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Annex') RETURNING id`, [
    w.companyId,
    `${w.tag}AX`,
  ]);
  const wipers = await w.one(`INSERT INTO factory_categories (company_id, name) VALUES ($1, 'Wipers') RETURNING id`, [
    w.companyId,
  ]);
  const product = (name: string, categoryId: number | null) =>
    w.one(
      `INSERT INTO factory_bale_products (company_id, code, name, category_id, production_price) VALUES ($1, $2, $3, $4, 1.5) RETURNING id`,
      [w.companyId, `${w.tag}P${++seq}`, name, categoryId]
    );
  const wiperProduct = await product("Wiper Mix", wipers);
  const cream = await product("Cream", null);
  const bale = (
    locationId: number | null,
    productId: number | null,
    name: string | null,
    category: string | null,
    kg = "20"
  ) =>
    w.q(
      `INSERT INTO factory_bales (company_id, bale_code, reference_number, product_id, product_name, category, article_code,
         grade, weight_kg, cost_per_kg, total_cost, status, erp_location_id)
       VALUES ($1, $2, $2, $3, $4, $5, $6, 'A', $7, 0.5, $7::numeric * 0.5, 'IN_STOCK', $8)`,
      [w.companyId, `${w.tag}-E${++seq}`, productId, name, category, productId ? "ART-1" : null, kg, locationId]
    );
  await bale(w.locationId, cream, "Cream", null);
  await bale(w.locationId, cream, "Cream", null, "30");
  await bale(store, cream, "Cream", null);
  await bale(store, wiperProduct, "Wiper Mix", null);
  await bale(null, null, null, "Garbage");
  await bale(w.locationId, null, null, null);
  // A bale on an active loading stays out of stock reports.
  const { bales } = await loadingWithBales(w, ["10.00"]);
  await w.q(`UPDATE factory_bales SET status = 'IN_STOCK' WHERE id = $1`, [bales[0].baleId]);
  return { reservedRef: bales[0].reference };
}

async function workbook(w: FactoryWorld, query = "") {
  const res = await w.agent.get(`${URL}${query}`).buffer(true).parse(binary);
  expect(res.status).toBe(200);
  expect(res.headers["content-disposition"]).toMatch(/inventory_all_locations_/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body as unknown as ExcelJS.Buffer);
  return wb;
}

const text = (ws: ExcelJS.Worksheet) => JSON.stringify(ws.getSheetValues());
const headers = (ws: ExcelJS.Worksheet) =>
  (ws.getRow(1).values as unknown[]).filter((v) => typeof v === "string").join("|");

describe("factory all-locations inventory workbook", () => {
  it("splits main and wiper / garbage stock, skips loading bales and shows cost", () =>
    withFactoryWorld(async (w) => {
      const { reservedRef } = await seed(w);
      const wb = await workbook(w);
      expect(wb.worksheets.map((s) => s.name)).toEqual([
        "Stock Summary",
        "Wipers & Garbage",
        "Bale Details",
        "Garbage & Wiper Details",
      ]);
      const summary = text(wb.getWorksheet("Stock Summary")!);
      expect(summary).toContain("Yard");
      expect(summary).toContain("Annex");
      expect(summary).toContain("Unknown");
      const wg = text(wb.getWorksheet("Wipers & Garbage")!);
      expect(wg).toContain("Wiper Mix");
      expect(wg).toContain("Location #0");
      expect(text(wb.getWorksheet("Bale Details")!)).not.toContain(reservedRef);
      expect(headers(wb.getWorksheet("Bale Details")!)).toMatch(/Cost/i);
    }));

  it("drops the cost columns when the request or the factory settings hide cost", () =>
    withFactoryWorld(async (w) => {
      await seed(w);
      const noCost = await workbook(w, "?includeCost=0");
      expect(headers(noCost.getWorksheet("Bale Details")!)).not.toMatch(/Cost/i);
      await w.q(
        `INSERT INTO factory_settings (company_id, hide_avg_cost) VALUES ($1, TRUE)
           ON CONFLICT (company_id) DO UPDATE SET hide_avg_cost = TRUE`,
        [w.companyId]
      );
      const hidden = await workbook(w);
      expect(headers(hidden.getWorksheet("Garbage & Wiper Details")!)).not.toMatch(/Cost/i);
    }));

  it("writes empty sheets when nothing is in stock", () =>
    withFactoryWorld(async (w) => {
      const wb = await workbook(w);
      expect(wb.worksheets).toHaveLength(4);
    }));
});
