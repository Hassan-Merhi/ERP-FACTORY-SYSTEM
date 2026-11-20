/**
 * Bale product catalogue, categories and pending barcodes
 * (server/routes/baleProductRoutes.ts) through the real app and storage, one
 * rolled-back transaction per test.
 *
 * Pinned: validation and conflict refusals write nothing; product edits and
 * deletes are company-scoped; the Excel import creates, updates, skips and
 * creates categories; malformed uploads are refused.
 *
 * Pending-barcode and category edits/deletes are scoped to the active company
 * (another company's row is 404 and stays unchanged), their PATCH bodies are
 * whitelisted, and the bulk mark-printed route is reachable and company-scoped.
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

  it("scopes product reads, edits and deletes to the selected company", async () => {
    await withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const foreign = await w.one(
        `INSERT INTO bale_products (company_id, code, article_code, name) VALUES ($1, 'F1', 'F1', 'Foreign') RETURNING id`,
        [other]
      );
      const foreignRead = await w.agent.get(`/api/bale-products/${foreign}`);
      expect(foreignRead.status).toBe(404);
      expect(foreignRead.body).toEqual({ message: "Product not found" });
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

  it("answers 404 for another company's category and leaves it unchanged", async () => {
    await withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const foreign = await w.one(
        `INSERT INTO bale_product_categories (company_id, name) VALUES ($1, 'Theirs') RETURNING id`,
        [other]
      );
      const state = () =>
        w.q(`SELECT company_id, name, is_active FROM bale_product_categories WHERE id = $1`, [foreign]);
      const before = await state();
      const patch = await w.agent.patch(`/api/bale-product-categories/${foreign}`).send({ name: "Changed" });
      expect(patch.status).toBe(404);
      expect((await w.agent.delete(`/api/bale-product-categories/${foreign}`)).status).toBe(404);
      expect(await state()).toEqual(before);
      expect(before).toEqual([{ company_id: other, name: "Theirs", is_active: true }]);
    });
  });

  it("only applies the name and active flag from a PATCH body", async () => {
    await withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const own = await w.one(
        `INSERT INTO bale_product_categories (company_id, name) VALUES ($1, 'Mine') RETURNING id`,
        [w.companyId]
      );
      // A foreign companyId in the body is refused by the company-scope boundary.
      const moved = await w.agent
        .patch(`/api/bale-product-categories/${own}`)
        .send({ isActive: false, companyId: other });
      expect(moved.status).toBe(403);
      const res = await w.agent
        .patch(`/api/bale-product-categories/${own}`)
        .send({ isActive: false, companyId: w.companyId, id: own + 1000, createdAt: "2000-01-01" });
      expect(res.status).toBe(200);
      const [row] = await w.q(
        `SELECT id, company_id, name, is_active, created_at > '2001-01-01' AS recent FROM bale_product_categories
          WHERE id = $1`,
        [own]
      );
      expect(row).toEqual({ id: own, company_id: w.companyId, name: "Mine", is_active: false, recent: true });
      expect((await w.agent.patch(`/api/bale-product-categories/${own}`).send({ name: "" })).status).toBe(400);
      expect((await w.agent.patch(`/api/bale-product-categories/${own}`).send({ isActive: "no" })).status).toBe(400);
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

      // The bulk route is registered before PATCH /:id, so it is reachable.
      const ids = imported.body.barcodes.map((b: { id: number }) => b.id);
      const marked = await w.agent.patch("/api/pending-barcodes/mark-printed").send({ ids });
      expect(marked.status).toBe(200);
      expect(marked.body).toEqual({ success: true, count: 3 });
      const printed = await w.q(`SELECT COUNT(*)::int AS n FROM pending_barcodes WHERE id = ANY($1) AND printed`, [
        ids,
      ]);
      expect(printed[0].n).toBe(3);
      for (const bad of [{}, { ids: "x" }, { ids: ["1"] }, { ids: [1.5] }]) {
        expect((await w.agent.patch("/api/pending-barcodes/mark-printed").send(bad)).status).toBe(400);
      }

      expect((await w.agent.patch("/api/pending-barcodes/abc").send({})).status).toBe(400);
      expect((await w.agent.patch(`/api/pending-barcodes/${one.body.id}`).send({ grade: "Z" })).body.grade).toBe("Z");
      expect((await w.agent.patch("/api/pending-barcodes/2000000000").send({ grade: "Z" })).status).toBe(404);
      expect((await w.agent.delete("/api/pending-barcodes/abc")).status).toBe(400);
      expect((await w.agent.delete("/api/pending-barcodes/2000000000")).status).toBe(404);
      expect((await w.agent.delete(`/api/pending-barcodes/${one.body.id}`)).status).toBe(204);
    });
  });

  it("scopes edits, deletes and mark-printed to the active company", async () => {
    await withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const foreign = await w.one(
        `INSERT INTO pending_barcodes (company_id, barcode, grade) VALUES ($1, $2, 'A') RETURNING id`,
        [other, `${w.tag}-F`]
      );
      const own = await w.one(
        `INSERT INTO pending_barcodes (company_id, barcode, grade) VALUES ($1, $2, 'A') RETURNING id`,
        [w.companyId, `${w.tag}-O`]
      );
      const state = () =>
        w.q(`SELECT company_id, barcode, grade, printed, used FROM pending_barcodes WHERE id = $1`, [foreign]);
      const before = await state();
      expect((await w.agent.patch(`/api/pending-barcodes/${foreign}`).send({ grade: "Z" })).status).toBe(404);
      expect((await w.agent.delete(`/api/pending-barcodes/${foreign}`)).status).toBe(404);
      const marked = await w.agent.patch("/api/pending-barcodes/mark-printed").send({ ids: [foreign, own] });
      expect(marked.body).toEqual({ success: true, count: 1 });
      expect(await state()).toEqual(before);
      expect(before[0]).toMatchObject({ company_id: other, grade: "A", printed: false });
      const [ownRow] = await w.q(`SELECT printed FROM pending_barcodes WHERE id = $1`, [own]);
      expect(ownRow.printed).toBe(true);
    });
  });

  it("ignores non-label fields in a PATCH body and validates the label fields", async () => {
    await withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const own = await w.one(`INSERT INTO pending_barcodes (company_id, barcode) VALUES ($1, $2) RETURNING id`, [
        w.companyId,
        `${w.tag}-P`,
      ]);
      // A foreign companyId in the body is refused by the company-scope boundary.
      expect((await w.agent.patch(`/api/pending-barcodes/${own}`).send({ companyId: other, used: true })).status).toBe(
        403
      );
      const res = await w.agent
        .patch(`/api/pending-barcodes/${own}`)
        .send({ companyId: w.companyId, id: own + 1000, createdAt: "2000-01-01", used: true, origin: "UK" });
      expect(res.status).toBe(200);
      const [row] = await w.q(
        `SELECT id, company_id, used, origin, created_at > '2001-01-01' AS recent FROM pending_barcodes WHERE id = $1`,
        [own]
      );
      expect(row).toEqual({ id: own, company_id: w.companyId, used: true, origin: "UK", recent: true });
      expect((await w.agent.patch(`/api/pending-barcodes/${own}`).send({ printed: "yes" })).status).toBe(400);
      expect((await w.agent.patch(`/api/pending-barcodes/${own}`).send({ barcode: "" })).status).toBe(400);
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
        // A blank cell in a present "active" column keeps the default (active).
        { article_code: "ART-TWO", code: "ART-TWO", name: "Second", kg: "30", active: true, category: "Fresh" },
        { article_code: "HMD03000", code: "OLD", name: "Updated name", kg: "40", active: true, category: "Existing" },
      ]);
    });
  });

  it("keeps an existing product's active flag on a blank cell and deactivates only on false-like values", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(
        `INSERT INTO bale_products (company_id, code, article_code, name, active)
         VALUES ($1, 'A1', 'ART-A1', 'Was inactive', false), ($1, 'A2', 'ART-A2', 'Was active', true),
                ($1, 'A3', 'ART-A3', 'Says no', true), ($1, 'A4', 'ART-A4', 'Says yes', false)`,
        [w.companyId]
      );
      const file = await xlsx([
        { articleCode: "ART-A1", name: "Was inactive", active: "  " },
        { articleCode: "ART-A2", name: "Was active", active: null },
        { articleCode: "ART-A3", name: "Says no", active: "No" },
        { articleCode: "ART-A4", name: "Says yes", active: "yes" },
        { articleCode: "ART-A5", name: "New false", active: "FALSE" },
        { articleCode: "ART-A6", name: "New bool", active: false },
        { articleCode: "ART-A7", name: "New blank", active: "" },
      ]);
      const res = await w.agent.post("/api/bale-products/import-excel").attach("file", file, "products.xlsx");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ created: 3, updated: 4 });
      const active = (await products(w)).map((p) => [p.article_code, p.active]);
      expect(active).toEqual([
        ["ART-A1", false],
        ["ART-A2", true],
        ["ART-A3", false],
        ["ART-A4", true],
        ["ART-A5", false],
        ["ART-A6", false],
        ["ART-A7", true],
      ]);
    });
  });
});
