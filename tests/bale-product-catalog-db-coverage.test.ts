/**
 * Bale product catalogue, categories and pending barcodes
 * (server/routes/baleProductRoutes.ts) through the real app and storage, one
 * rolled-back transaction per test.
 *
 * Pinned: validation and conflict refusals write nothing; product edits and
 * deletes are company-scoped; the Excel import creates, updates, skips and
 * creates categories; malformed uploads are refused.
 *
 * Known defects pinned below (not fixed here): the pending-barcode PATCH and
 * DELETE and the category GET-by-id-backed PATCH/DELETE look rows up by id only,
 * so a user of one company can change another company's rows.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

async function xlsx(rows: Array<Record<string, unknown>>) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Products");
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(headers.map((h) => row[h] ?? null));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const otherCompany = (w: FactoryWorld) =>
  w.one(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
    [`${w.tag}O`]
  );

const products = (w: FactoryWorld) =>
  w.q(
    `SELECT p.article_code, p.code, p.name, p.weight_per_bale_kg::text AS kg, p.active, c.name AS category
       FROM bale_products p LEFT JOIN bale_product_categories c ON c.id = p.category_id
      WHERE p.company_id = $1 ORDER BY p.article_code`,
    [w.companyId]
  );

describe("bale products", () => {
  it("creates by item number, refuses a duplicate article code and invalid ids", async () => {
    await withFactoryWorld(async (w) => {
      const created = await w.agent.post("/api/bale-products").send({ itemNumber: 7, name: "Cotton Mix" });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({ articleCode: "HMD07000", code: "HMD07000" });
      const dup = await w.agent.post("/api/bale-products").send({ articleCode: "HMD07000", name: "Again" });
      expect(dup.status).toBe(409);
      // An item number outside 1-99 yields no article code, which the schema requires.
      const outOfRange = await w.agent.post("/api/bale-products").send({ itemNumber: 500, name: "No code" });
      expect(outOfRange.status).toBe(400);
      const coded = await w.agent
        .post("/api/bale-products")
        .send({ articleCode: "ART-X", code: "X-1", name: "No code" });
      expect(coded.status).toBe(200);
      const invalid = await w.agent.post("/api/bale-products").send({ name: 12 });
      expect(invalid.status).toBe(400);
      expect((await products(w)).map((p) => p.name).sort()).toEqual(["Cotton Mix", "No code"]);

      expect((await w.agent.get("/api/bale-products/abc")).status).toBe(400);
      expect((await w.agent.get("/api/bale-products/2000000000")).status).toBe(404);
      expect((await w.agent.get(`/api/bale-products/${created.body.id}`)).body.name).toBe("Cotton Mix");
      expect((await w.agent.get("/api/bale-products")).body).toHaveLength(2);
    });
  });

  it("scopes product edits and deletes to the selected company", async () => {
    await withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const foreign = await w.one(
        `INSERT INTO bale_products (company_id, code, article_code, name) VALUES ($1, 'F1', 'F1', 'Foreign') RETURNING id`,
        [other]
      );
      expect((await w.agent.patch(`/api/bale-products/${foreign}`).send({ name: "Taken" })).status).toBe(403);
      expect((await w.agent.delete(`/api/bale-products/${foreign}`)).status).toBe(403);
      const [kept] = await w.q(`SELECT name FROM bale_products WHERE id = $1`, [foreign]);
      expect(kept.name).toBe("Foreign");

      for (const method of ["patch", "delete"] as const) {
        expect((await w.agent[method]("/api/bale-products/abc").send({})).status).toBe(400);
        expect((await w.agent[method]("/api/bale-products/2000000000").send({})).status).toBe(404);
      }
      const own = await w.agent.post("/api/bale-products").send({ articleCode: "OWN1", name: "Own" });
      const renamed = await w.agent.patch(`/api/bale-products/${own.body.id}`).send({ name: "Own Renamed" });
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe("Own Renamed");
      const badPatch = await w.agent.patch(`/api/bale-products/${own.body.id}`).send({ name: 5 });
      expect(badPatch.status).toBe(400);
      expect((await w.agent.delete(`/api/bale-products/${own.body.id}`)).body).toEqual({ success: true });
      expect(await products(w)).toEqual([]);
    });
  });
});

describe("bale product categories", () => {
  it("creates, refuses a duplicate name, renames and deletes", async () => {
    await withFactoryWorld(async (w) => {
      const created = await w.agent.post("/api/bale-product-categories").send({ name: "Premium" });
      expect(created.status).toBe(200);
      const dup = await w.agent.post("/api/bale-product-categories").send({ name: "Premium" });
      expect(dup.status).toBe(409);
      expect((await w.agent.post("/api/bale-product-categories").send({})).status).toBe(400);
      for (const method of ["patch", "delete"] as const) {
        expect((await w.agent[method]("/api/bale-product-categories/abc").send({})).status).toBe(400);
        expect((await w.agent[method]("/api/bale-product-categories/2000000000").send({})).status).toBe(404);
      }
      const renamed = await w.agent.patch(`/api/bale-product-categories/${created.body.id}`).send({ name: "Gold" });
      expect(renamed.body.name).toBe("Gold");
      expect((await w.agent.get("/api/bale-product-categories")).body.map((c: { name: string }) => c.name)).toEqual([
        "Gold",
      ]);
      expect((await w.agent.delete(`/api/bale-product-categories/${created.body.id}`)).body).toEqual({ success: true });
    });
  });

  it("pins the unscoped category edit of another company's row", async () => {
    await withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const foreign = await w.one(
        `INSERT INTO bale_product_categories (company_id, name) VALUES ($1, 'Theirs') RETURNING id`,
        [other]
      );
      const res = await w.agent.patch(`/api/bale-product-categories/${foreign}`).send({ name: "Changed" });
      const [row] = await w.q(`SELECT name FROM bale_product_categories WHERE id = $1`, [foreign]);
      // Current behaviour: no company check, the foreign row is renamed.
      expect(res.status).toBe(200);
      expect(row.name).toBe("Changed");
    });
  });
});

describe("pending barcodes", () => {
  it("creates, imports, marks printed, updates and deletes", async () => {
    await withFactoryWorld(async (w) => {
      const one = await w.agent.post("/api/pending-barcodes").send({ barcode: `${w.tag}-1`, grade: "A" });
      expect(one.status).toBe(200);
      expect((await w.agent.post("/api/pending-barcodes").send({ grade: "A" })).status).toBe(400);
      expect((await w.agent.post("/api/pending-barcodes/import").send({ barcodes: "x" })).status).toBe(400);
      const imported = await w.agent.post("/api/pending-barcodes/import").send({
        barcodes: [
          { barcode: `${w.tag}-2`, category: "C", grade: "B", origin: "UK" },
          { code: `${w.tag}-3` },
          `${w.tag}-4`,
        ],
      });
      expect(imported.body).toMatchObject({ success: true, count: 3 });
      expect((await w.agent.post("/api/pending-barcodes/import").send({})).body.count).toBe(0);

      expect((await w.agent.get(`/api/pending-barcodes/${w.tag}-2`)).body.origin).toBe("UK");
      expect((await w.agent.get(`/api/pending-barcodes/${w.tag}-none`)).status).toBe(404);
      expect((await w.agent.get("/api/pending-barcodes")).body).toHaveLength(4);

      // Pinned defect: PATCH /:id is registered before /mark-printed, so
      // "mark-printed" is parsed as an id and the bulk route is unreachable.
      const ids = imported.body.barcodes.map((b: { id: number }) => b.id);
      const shadowed = await w.agent.patch("/api/pending-barcodes/mark-printed").send({ ids });
      expect(shadowed.status).toBe(400);
      expect(shadowed.body.message).toBe("Invalid barcode ID");
      const printed = await w.q(`SELECT COUNT(*)::int AS n FROM pending_barcodes WHERE id = ANY($1) AND printed`, [
        ids,
      ]);
      expect(printed[0].n).toBe(0);

      expect((await w.agent.patch("/api/pending-barcodes/abc").send({})).status).toBe(400);
      expect((await w.agent.patch(`/api/pending-barcodes/${one.body.id}`).send({ grade: "Z" })).body.grade).toBe("Z");
      expect((await w.agent.delete("/api/pending-barcodes/abc")).status).toBe(400);
      expect((await w.agent.delete(`/api/pending-barcodes/${one.body.id}`)).status).toBe(204);
    });
  });
});

describe("bale product Excel import", () => {
  it("refuses a missing or unreadable file", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.post("/api/bale-products/import-excel")).status).toBe(400);
      const garbage = await w.agent
        .post("/api/bale-products/import-excel")
        .attach("file", Buffer.from("not a spreadsheet"), "broken.xlsx");
      expect(garbage.status).toBe(400);
      expect(await products(w)).toEqual([]);
    });
  });

  it("creates, updates and skips rows and creates missing categories once", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(`INSERT INTO bale_product_categories (company_id, name) VALUES ($1, 'Existing')`, [w.companyId]);
      await w.q(
        `INSERT INTO bale_products (company_id, code, article_code, name, weight_per_bale_kg, description)
         VALUES ($1, 'OLD', 'HMD03000', 'Old name', 40, 'kept')`,
        [w.companyId]
      );
      const file = await xlsx([
        { itemNumber: 3, name: "Updated name", category: "existing" },
        { articleCode: "ART-NEW", name: "Brand new", category: "Fresh", weight: 45, code: "NEW-CODE", active: 0 },
        { article_code: "ART-TWO", Name: "Second", Category: "fresh", weight_per_bale_kg: 30 },
        { itemNumber: 120, name: "Out of range" },
        { articleCode: "ART-NONAME" },
      ]);
      const res = await w.agent.post("/api/bale-products/import-excel").attach("file", file, "products.xlsx");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, created: 2, updated: 1, categoriesCreated: 1, count: 3 });
      expect(await products(w)).toEqual([
        { article_code: "ART-NEW", code: "NEW-CODE", name: "Brand new", kg: "45", active: false, category: "Fresh" },
        // A blank cell in a present "active" column reads as inactive.
        { article_code: "ART-TWO", code: "ART-TWO", name: "Second", kg: "30", active: false, category: "Fresh" },
        { article_code: "HMD03000", code: "OLD", name: "Updated name", kg: "40", active: true, category: "Existing" },
      ]);
    });
  });
});
