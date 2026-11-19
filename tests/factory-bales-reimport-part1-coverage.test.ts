import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const REIMPORT = "/api/factory/bales/reimport";
const HEADERS = [
  "Reference Number",
  "Article Code",
  "Product Name",
  "Category",
  "Weight (kg)",
  "Cost per kg",
  "Total Cost",
  "Location ID",
  "Status",
  "Mix Batch",
  "Bale Code",
  "Grade",
  "Finalized At",
];

async function workbook(headers: string[], rows: unknown[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Bales");
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

function upload(w: FactoryWorld, file: Buffer, agent = w.agent) {
  return agent.post(REIMPORT).attach("file", file, "reimport.xlsx");
}

async function importBatches(w: FactoryWorld) {
  return w.q(`SELECT bale_count FROM factory_bale_import_batches WHERE company_id = $1`, [w.companyId]);
}

describe("bale reimport validation", () => {
  it("refuses missing files, missing columns, empty sheets and duplicate references", async () => {
    await withFactoryWorld(async (w) => {
      const none = await w.agent.post(REIMPORT).field("note", "x");
      expect(none.status).toBe(400);
      expect(none.body.message).toBe("No file uploaded");

      const noWeight = await upload(w, await workbook(["Reference Number", "Product Name"], [["R1", "Rags"]]));
      expect(noWeight.body.message).toMatch(/at least: Reference Number, Product Name, Weight/);

      const empty = await upload(w, await workbook(HEADERS, [["", "A", "Rags"]]));
      expect(empty.body.message).toBe("No bale rows found in Excel");

      const dup = await upload(
        w,
        await workbook(HEADERS, [
          ["R1", "", "Rags", "", 10],
          ["R1", "", "Rags", "", 12],
        ])
      );
      expect(dup.body.message).toBe("Duplicate reference numbers within the file: R1");
      expect(await importBatches(w)).toEqual([]);
    });
  });

  it("rolls back on existing references, foreign locations and an applied perpetual cut-over", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(`INSERT INTO factory_bales (company_id, reference_number) VALUES ($1, 'TAKEN-1')`, [w.companyId]);
      const existing = await upload(w, await workbook(HEADERS, [["TAKEN-1", "", "Rags", "", 10]]));
      expect(existing.status).toBe(400);
      expect(existing.body.message).toMatch(/already exist: TAKEN-1/);

      const badLocation = await upload(
        w,
        await workbook(HEADERS, [["NEW-1", "", "Rags", "", 10, 1, 10, 2_000_000_000]])
      );
      expect(badLocation.body.message).toMatch(/Invalid location IDs found: NEW-1/);

      await w.q(
        `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, status)
         VALUES ($1, CURRENT_DATE - 1, '{}'::jsonb, 'ACTIVE')`,
        [w.companyId]
      );
      const refused = await upload(w, await workbook(HEADERS, [["NEW-2", "", "Rags", "", 10]]));
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
      expect(await importBatches(w)).toEqual([]);
      const bales = await w.q(`SELECT reference_number FROM factory_bales WHERE company_id = $1`, [w.companyId]);
      expect(bales).toEqual([{ reference_number: "TAKEN-1" }]);
    });
  });

  it("is limited to Admin and Owner", async () => {
    await withFactoryWorld(async (w) => {
      const manager = await w.agentFor("Manager");
      const res = await upload(w, await workbook(HEADERS, [["R1", "", "Rags", "", 10]]), manager);
      expect(res.status).toBe(403);
    });
  });
});

describe("bale reimport", () => {
  it("creates bales, products and stock with spreadsheet cost and audits dropped mix batches", async () => {
    await withFactoryWorld(async (w) => {
      const categoryId = await w.one(
        `INSERT INTO factory_categories (company_id, name) VALUES ($1, 'Cotton') RETURNING id`,
        [w.companyId]
      );
      await w.q(`INSERT INTO stock_groups (company_id, name, code) VALUES ($1, 'Wool', $2)`, [
        w.companyId,
        `${w.tag}W`,
      ]);
      const knownByArticle = await w.one(
        `INSERT INTO factory_bale_products (company_id, code, name, article_code) VALUES ($1, $2, 'Known A', 'KA-1') RETURNING id`,
        [w.companyId, `${w.tag}KA`]
      );
      const knownByName = await w.one(
        `INSERT INTO factory_bale_products (company_id, code, name, article_code) VALUES ($1, $2, 'Known Name', 'KN-1') RETURNING id`,
        [w.companyId, `${w.tag}KN`]
      );
      const costedMix = await w.one(
        `INSERT INTO factory_mix_batches (company_id, batch_code, batch_number, cost_per_kg) VALUES ($1, $2::text, $2::text, 1.2) RETURNING id`,
        [w.companyId, `${w.tag}M1`]
      );
      const freeMix = await w.one(
        `INSERT INTO factory_mix_batches (company_id, batch_code, batch_number, cost_per_kg) VALUES ($1, $2::text, $2::text, 0) RETURNING id`,
        [w.companyId, `${w.tag}M2`]
      );
      const loc = w.locationId;
      const file = await workbook(HEADERS, [
        ["RI-1", "KA-1", "Known A", "Cotton", 50, 2, 100, loc, "IN_STOCK", costedMix, "BC-1", "A", "2026-01-05"],
        ["RI-2", "", "known name", "Wool", 40, 1.5, 60, loc, "", freeMix, "", "", "not a date"],
        ["RI-3", "NEW-ART", "New Product", "Cotton", 30, 1, 30, loc, "IN_STOCK", "", "", "", ""],
        ["RI-4", "", "Fresh Name!", "", 20, 1, 20, loc, "IN_STOCK"],
        ["RI-5", "KA-1", "Known A", "", 10, 2, 20, loc, "REMOVED"],
        ["RI-6", "KA-1", "Known A", "Cotton", 15, 2, 30, "", "IN_STOCK"],
        ["RI-7", "KA-1", "Known A", "Cotton", 25, 2, 50, loc, "IN_STOCK"],
      ]);
      const res = await upload(w, file);
      expect(res.status, res.text).toBe(200);
      expect(res.body.imported).toBe(7);
      expect(res.body.totalWeight).toBe(190);

      const bales = await w.q(
        `SELECT reference_number AS ref, product_id, mix_batch_id, status, bale_code, grade, category, import_batch_id
           FROM factory_bales WHERE company_id = $1 ORDER BY reference_number`,
        [w.companyId]
      );
      const byRef = Object.fromEntries(bales.map((bale) => [bale.ref, bale]));
      expect(byRef["RI-1"]).toMatchObject({
        product_id: knownByArticle,
        mix_batch_id: costedMix,
        bale_code: "BC-1",
        grade: "A",
      });
      expect(byRef["RI-2"]).toMatchObject({
        product_id: knownByName,
        mix_batch_id: null,
        status: "IN_STOCK",
        grade: null,
      });
      expect(byRef["RI-5"].status).toBe("REMOVED");
      expect(new Set(bales.map((bale) => bale.import_batch_id)).size).toBe(1);

      const created = await w.q(
        `SELECT name, article_code, category_id FROM factory_bale_products
          WHERE company_id = $1 AND id NOT IN ($2, $3) ORDER BY name`,
        [w.companyId, knownByArticle, knownByName]
      );
      expect(created).toEqual([
        { name: "Fresh Name!", article_code: expect.stringMatching(/^IMP-FRESHNAME-/), category_id: null },
        { name: "New Product", article_code: "NEW-ART", category_id: categoryId },
      ]);

      const [batch] = await importBatches(w);
      expect(batch.bale_count).toBe(7);
      const [audit] = await w.q(
        `SELECT changes->'metadata'->'new' AS metadata FROM audit_log
          WHERE company_id = $1 AND table_name = 'factory_bale_import_batches'`,
        [w.companyId]
      );
      expect(audit.metadata).toMatchObject({ droppedMixBatchIds: [freeMix], totalCost: "310.00" });

      // RI-5 (removed) and RI-6 (no location) never reach stock; KA-1 is received three times.
      const items = await w.q(
        `SELECT si.code, sg.name AS group_name FROM stock_items si LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id
          WHERE si.company_id = $1 ORDER BY si.code`,
        [w.companyId]
      );
      const codes = items.map((item) => item.code as string);
      expect(codes).toHaveLength(4);
      expect(codes).toEqual(expect.arrayContaining(["KA-1", "KN-1", "NEW-ART"]));
      expect(codes.some((code) => code.startsWith("IMP-FRESHNAME-"))).toBe(true);
      expect(items.find((item) => item.code === "KN-1")?.group_name).toBe("Wool");
      const daybook = await w.q(
        `SELECT 1 FROM factory_daybook_entries WHERE company_id = $1 AND tx_type = 'BALE_REIMPORT'`,
        [w.companyId]
      );
      expect(daybook).toHaveLength(1);
    });
  });
});
