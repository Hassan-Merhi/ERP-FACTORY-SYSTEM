/**
 * French catalogue translation routes
 * (server/routes/factory/factoryFrenchTranslationRoutes.ts) over HTTP, one
 * rolled-back factory company per test: search and status filters, product
 * and category edits with invalid, missing and another company's ids, the
 * template download, the import preview (missing file, missing columns, header
 * aliases, blank and unknown codes) and apply (empty, unknown, blank code,
 * with and without a category translation).
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const BASE = "/api/factory/french-catalog";

async function catalog(w: FactoryWorld) {
  const category = await w.one(`INSERT INTO factory_categories (company_id, name) VALUES ($1, 'Shoes') RETURNING id`, [
    w.companyId,
  ]);
  const product = (code: string | null, name: string, categoryId: number | null, nameFr: string | null) =>
    w.one(
      `INSERT INTO factory_bale_products (company_id, code, name, article_code, category_id, name_fr, description)
       VALUES ($1, $2, $3, $4, $5, $6, 'desc') RETURNING id`,
      [w.companyId, `${w.tag}${name}`, name, code, categoryId, nameFr]
    );
  const shoe = await product("SH-1", "Shoe", category, null);
  const bag = await product("BG-1", "Bag", null, "Sac");
  const other = await w.one(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
    [`${w.tag}O`]
  );
  const foreignCategory = await w.one(
    `INSERT INTO factory_categories (company_id, name) VALUES ($1, 'Foreign') RETURNING id`,
    [other]
  );
  const foreignProduct = await w.one(
    `INSERT INTO factory_bale_products (company_id, code, name, article_code) VALUES ($1, $2, 'Foreign', 'SH-1') RETURNING id`,
    [other, `${w.tag}F`]
  );
  return { category, shoe, bag, foreignCategory, foreignProduct };
}

async function workbook(headers: string[], rows: string[][], sheets = 1) {
  const book = new ExcelJS.Workbook();
  for (let i = 0; i < sheets; i++) {
    const sheet = book.addWorksheet(`S${i}`);
    sheet.addRow(headers);
    for (const row of rows) sheet.addRow(row);
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

describe("french catalogue reads and edits", () => {
  it("filters by search text and translation status", () =>
    withFactoryWorld(async (w) => {
      const { shoe, bag } = await catalog(w);
      const ids = async (filters: Record<string, string>) =>
        ((await w.agent.get(`${BASE}?${new URLSearchParams(filters)}`)).body as Array<{ id: number }>)
          .map((r) => r.id)
          .sort();
      expect(await ids({})).toEqual([shoe, bag].sort());
      expect(await ids({ status: "missing" })).toEqual([shoe]);
      expect(await ids({ status: "complete" })).toEqual([bag]);
      expect(await ids({ q: " shoes " })).toEqual([shoe]);
      expect(await ids({ q: "zzz" })).toEqual([]);
    }));

  it("edits products and categories and refuses invalid, missing and foreign ids", () =>
    withFactoryWorld(async (w) => {
      const { category, shoe, foreignCategory, foreignProduct } = await catalog(w);
      for (const kind of ["products", "categories"]) {
        expect((await w.agent.patch(`${BASE}/${kind}/abc`).send({})).status).toBe(400);
        expect((await w.agent.patch(`${BASE}/${kind}/0`).send({})).status).toBe(400);
        expect((await w.agent.patch(`${BASE}/${kind}/999999999`).send({ nameFr: "x" })).status).toBe(404);
      }
      expect((await w.agent.patch(`${BASE}/products/${foreignProduct}`).send({ nameFr: "Vol" })).status).toBe(404);
      expect((await w.agent.patch(`${BASE}/categories/${foreignCategory}`).send({ nameFr: "Vol" })).status).toBe(404);
      const [foreign] = await w.q(
        `SELECT (SELECT name_fr FROM factory_bale_products WHERE id = $1) AS p,
                (SELECT name_fr FROM factory_categories WHERE id = $2) AS c`,
        [foreignProduct, foreignCategory]
      );
      expect(foreign).toEqual({ p: null, c: null });

      const product = await w.agent
        .patch(`${BASE}/products/${shoe}`)
        .send({ nameFr: "  Chaussure ", descriptionFr: "   " });
      expect(product.status).toBe(200);
      expect(product.body).toMatchObject({ id: shoe, nameFr: "Chaussure", descriptionFr: null });
      const cat = await w.agent.patch(`${BASE}/categories/${category}`).send({ nameFr: 7 });
      expect(cat.body).toEqual({ id: category, nameFr: null });
      const named = await w.agent.patch(`${BASE}/categories/${category}`).send({ nameFr: "Chaussures" });
      expect(named.body.nameFr).toBe("Chaussures");
    }));

  it("downloads the template workbook with every product", () =>
    withFactoryWorld(async (w) => {
      await catalog(w);
      const res = await w.agent
        .get(`${BASE}/template`)
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => done(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toContain("factory-french-translations.xlsx");
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(res.body as never);
      expect(book.worksheets[0].rowCount).toBe(3);
      expect(book.worksheets[0].getRow(1).getCell(1).text).toBe("Article Code / Barcode");
    }));
});

describe("french catalogue import", () => {
  it("refuses a missing file and missing required columns", () =>
    withFactoryWorld(async (w) => {
      const none = await w.agent.post(`${BASE}/import/preview`);
      expect(none.status).toBe(400);
      expect(none.body.message).toMatch(/Excel file is required/);
      const missing = await w.agent
        .post(`${BASE}/import/preview`)
        .attach("file", await workbook(["Article Code"], [["SH-1"]]), "t.xlsx");
      expect(missing.status).toBe(400);
      expect(missing.body.message).toMatch(/Required columns/);
    }));

  it("previews a workbook without code rows", () =>
    withFactoryWorld(async (w) => {
      await catalog(w);
      const empty = await w.agent
        .post(`${BASE}/import/preview`)
        .attach("file", await workbook(["Article Code", "French Product Name"], [["", "blank code"]]), "t.xlsx");
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({ rows: [], totalRows: 0, readyRows: 0, blocked: false });
    }));

  it("previews one coded row matched to this company's product, not another company's", () =>
    withFactoryWorld(async (w) => {
      const { shoe, category } = await catalog(w);
      const res = await w.agent
        .post(`${BASE}/import/preview`)
        .attach("file", await workbook(["Article Code", "French Product Name"], [["SH-1", "Chaussure"]]), "t.xlsx");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        rows: [
          {
            rowNumber: 2,
            articleCode: "SH-1",
            nameFr: "Chaussure",
            categoryNameFr: null,
            descriptionFr: null,
            productId: shoe,
            categoryId: category,
            status: "ready",
          },
        ],
        totalRows: 1,
        readyRows: 1,
        blocked: false,
      });
    }));

  it("previews normalised and unknown codes and blocks the import on an unknown code", () =>
    withFactoryWorld(async (w) => {
      const { shoe, category } = await catalog(w);
      const res = await w.agent.post(`${BASE}/import/preview`).attach(
        "file",
        await workbook(
          ["Article Code / Barcode", "French Product Name", "French Category", "French Description"],
          [
            [" sh-1 ", "Chaussure", "Chaussures", ""],
            ["NOPE", "x", "", ""],
          ]
        ),
        "t.xlsx"
      );
      expect(res.status).toBe(200);
      expect(res.body.totalRows).toBe(2);
      expect(res.body.readyRows).toBe(1);
      expect(res.body.blocked).toBe(true);
      expect(res.body.rows).toEqual([
        expect.objectContaining({
          rowNumber: 2,
          articleCode: "SH-1",
          nameFr: "Chaussure",
          categoryNameFr: "Chaussures",
          productId: shoe,
          categoryId: category,
          status: "ready",
        }),
        expect.objectContaining({
          rowNumber: 3,
          articleCode: "NOPE",
          productId: null,
          categoryId: null,
          status: "unknown",
        }),
      ]);
    }));

  it("applies product and category translations, skipping blank and unknown codes", () =>
    withFactoryWorld(async (w) => {
      const { shoe, bag, category, foreignProduct } = await catalog(w);
      expect((await w.agent.post(`${BASE}/import/apply`).send({ rows: [] })).status).toBe(400);
      expect((await w.agent.post(`${BASE}/import/apply`).send({ rows: "x" })).status).toBe(400);
      const res = await w.agent.post(`${BASE}/import/apply`).send({
        rows: [
          { articleCode: " sh-1 ", nameFr: "Chaussure", descriptionFr: "Paire", categoryNameFr: "Chaussures" },
          { articleCode: "BG-1", nameFr: "Sacoche", categoryNameFr: "ignored: no category" },
          { articleCode: "", nameFr: "blank" },
          { articleCode: 12, nameFr: "not a string" },
          { articleCode: "NOPE", nameFr: "Inconnu" },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, updatedProducts: 2, updatedCategories: 1 });
      const rows = await w.q(
        `SELECT id, name_fr, description_fr FROM factory_bale_products WHERE id = ANY($1::int[]) ORDER BY id`,
        [[shoe, bag, foreignProduct]]
      );
      expect(rows).toEqual([
        { id: shoe, name_fr: "Chaussure", description_fr: "Paire" },
        { id: bag, name_fr: "Sacoche", description_fr: null },
        { id: foreignProduct, name_fr: null, description_fr: null },
      ]);
      const [cat] = await w.q(`SELECT name_fr FROM factory_categories WHERE id = $1`, [category]);
      expect(cat.name_fr).toBe("Chaussures");

      // Without a categoryNameFr key the category keeps its translation.
      await w.agent.post(`${BASE}/import/apply`).send({ rows: [{ articleCode: "SH-1", nameFr: "C2" }] });
      const [kept] = await w.q(`SELECT name_fr FROM factory_categories WHERE id = $1`, [category]);
      expect(kept.name_fr).toBe("Chaussures");
    }));
});
