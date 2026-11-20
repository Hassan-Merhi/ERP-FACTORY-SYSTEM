/**
 * server/routes/productionBaleRoutes.ts (bulk status + Excel import) against
 * PostgreSQL over HTTP, one rolled-back company per test.
 *
 * Pinned: an unknown status or an empty id list is refused before any write;
 * the bulk update only touches the active company's bales; the Excel import
 * accepts every header spelling the mapper knows (snake_case, camelCase and
 * the bare barcode/weight fallbacks), defaults blank columns, links a mix
 * batch when one is given, and refuses a missing file, an unreadable file and
 * a row the insert schema rejects without writing anything.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

async function xlsx(rows: Array<Record<string, unknown>>) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Bales");
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(headers.map((h) => row[h] ?? null));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const bale = (w: FactoryWorld, code: string, companyId = w.companyId) =>
  w.one(
    `INSERT INTO production_bales (company_id, bale_code, barcode_value, status) VALUES ($1, $2, $2, 'PENDING') RETURNING id`,
    [companyId, code]
  );

const otherCompany = (w: FactoryWorld) =>
  w.one(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
    [`${w.tag}O`]
  );

const bales = (w: FactoryWorld) =>
  w.q(
    `SELECT bale_code, barcode_value, category, grade, weight_kg::text AS kg, cost_per_kg::text AS cpk,
            total_cost::text AS total, warehouse_location AS loc, status, mix_batch_id
       FROM production_bales WHERE company_id = $1 ORDER BY bale_code`,
    [w.companyId]
  );

describe("PATCH /api/production-bales/bulk-status", () => {
  it("refuses an unknown status and an empty or missing id list", () =>
    withFactoryWorld(async (w) => {
      const id = await bale(w, `${w.tag}A`);
      const bad = await w.agent.patch("/api/production-bales/bulk-status").send({ ids: [id], status: "LOST" });
      expect(bad.status).toBe(400);
      expect(bad.body.message).toMatch(/Invalid status/);
      const empty = await w.agent.patch("/api/production-bales/bulk-status").send({ ids: [], status: "SOLD" });
      expect(empty.status).toBe(400);
      expect(empty.body.message).toBe("No bale IDs provided");
      const missing = await w.agent.patch("/api/production-bales/bulk-status").send({ ids: "x", status: "SOLD" });
      expect(missing.status).toBe(400);
      expect((await bales(w)).map((b) => b.status)).toEqual(["PENDING"]);
    }));

  it("updates only the active company's bales and leaves another company's id untouched", () =>
    withFactoryWorld(async (w) => {
      const own = await bale(w, `${w.tag}A`);
      const foreignCompany = await otherCompany(w);
      const foreign = await bale(w, `${w.tag}F`, foreignCompany);
      const res = await w.agent
        .patch("/api/production-bales/bulk-status")
        .send({ ids: [String(own), foreign], status: "PRESSED" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 1 });
      const rows = await w.q(`SELECT id, status FROM production_bales WHERE id = ANY($1::int[]) ORDER BY id`, [
        [own, foreign],
      ]);
      expect(rows).toEqual([
        { id: own, status: "PRESSED" },
        { id: foreign, status: "PENDING" },
      ]);
    }));

  it("answers 500 when the id list cannot be cast", () =>
    withFactoryWorld(async (w) => {
      await w.q(`SAVEPOINT bulk_cast`);
      const res = await w.agent.patch("/api/production-bales/bulk-status").send({ ids: ["abc"], status: "SOLD" });
      await w.q(`ROLLBACK TO SAVEPOINT bulk_cast`);
      // parseInt("abc") is NaN; Postgres rejects it and the handler reports a 500.
      expect(res.status).toBe(500);
    }));
});

describe("POST /api/production-bales/import-excel", () => {
  it("refuses a missing or unreadable file", () =>
    withFactoryWorld(async (w) => {
      const none = await w.agent.post("/api/production-bales/import-excel");
      expect(none.status).toBe(400);
      expect(none.body.message).toBe("No file uploaded");
      const garbage = await w.agent
        .post("/api/production-bales/import-excel")
        .attach("file", Buffer.from("not a spreadsheet"), "broken.xlsx");
      expect(garbage.status).toBe(400);
      expect(await bales(w)).toEqual([]);
    }));

  it("maps every header spelling and defaults blank columns", () =>
    withFactoryWorld(async (w) => {
      const mix = await w.one(
        `INSERT INTO mix_batches (company_id, batch_code, cost_per_kg, total_cost, total_weight_kg) VALUES ($1, $2, 0, 0, 0) RETURNING id`,
        [w.companyId, `${w.tag}MIX`]
      );
      const file = await xlsx([
        {
          bale_code: `${w.tag}1`,
          barcode_value: `${w.tag}BC1`,
          category: "Shirts",
          grade: "A",
          weight_kg: 45,
          cost_per_kg: 2,
          total_cost: 90,
          warehouse_location: "R1",
          status: "IN_STOCK",
        },
        {
          baleCode: `${w.tag}2`,
          barcodeValue: `${w.tag}BC2`,
          weightKg: 40,
          costPerKg: 3,
          totalCost: 120,
          warehouseLocation: "R2",
        },
        { baleCode: `${w.tag}3`, barcode: `${w.tag}BC3`, weight: 30 },
        { bale_code: `${w.tag}4`, weight: 10 },
        { baleCode: `${w.tag}5`, weight: 5 },
      ]);
      const res = await w.agent
        .post("/api/production-bales/import-excel")
        .field("mixBatchId", String(mix))
        .attach("file", file, "bales.xlsx");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, count: 5 });
      const rows = await bales(w);
      expect(rows.map((r) => [r.bale_code, r.barcode_value, r.kg, r.cpk, r.total, r.loc, r.status])).toEqual([
        [`${w.tag}1`, `${w.tag}BC1`, "45.000", "2.00", "90.00", "R1", "IN_STOCK"],
        [`${w.tag}2`, `${w.tag}BC2`, "40.000", "3.00", "120.00", "R2", "LABEL_PRINTED"],
        [`${w.tag}3`, `${w.tag}BC3`, "30.000", "0.00", "0.00", "", "LABEL_PRINTED"],
        [`${w.tag}4`, `${w.tag}4`, "10.000", "0.00", "0.00", "", "LABEL_PRINTED"],
        [`${w.tag}5`, `${w.tag}5`, "5.000", "0.00", "0.00", "", "LABEL_PRINTED"],
      ]);
      expect(new Set(rows.map((r) => r.mix_batch_id))).toEqual(new Set([mix]));
      expect(rows[0]).toMatchObject({ category: "Shirts", grade: "A" });
      expect(rows[1]).toMatchObject({ category: "", grade: "" });
    }));

  it("imports without a mix batch and refuses a row with no weight", () =>
    withFactoryWorld(async (w) => {
      const ok = await w.agent
        .post("/api/production-bales/import-excel")
        .attach("file", await xlsx([{ bale_code: `${w.tag}X`, weight_kg: 12 }]), "bales.xlsx");
      expect(ok.status).toBe(200);
      expect((await bales(w))[0].mix_batch_id).toBeNull();
      const bad = await w.agent
        .post("/api/production-bales/import-excel")
        .attach("file", await xlsx([{ bale_code: `${w.tag}Y` }]), "bales.xlsx");
      // A missing weight defaults to "0", which the insert schema refuses.
      expect(bad.status).toBe(400);
      expect(bad.body.message).toMatch(/Weight must be positive/);
      expect((await bales(w)).map((b) => b.bale_code)).toEqual([`${w.tag}X`]);
    }));
});
