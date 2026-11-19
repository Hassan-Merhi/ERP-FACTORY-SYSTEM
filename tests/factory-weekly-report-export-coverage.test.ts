/**
 * Weekly raw-material production report export over HTTP against PostgreSQL
 * (one rolled-back transaction per test): Excel and PDF for several weeks,
 * the period filter with no matching weeks, an empty company, and an
 * unsupported format.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/weekly-report/export";

const binary = (res: any, callback: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
};

/** Two production weeks in 2025 for two categories plus an uncategorised supplier. */
async function seed(w: FactoryWorld) {
  const category = (name: string) =>
    w.one(`INSERT INTO factory_supplier_categories (company_id, name) VALUES ($1, $2) RETURNING id`, [
      w.companyId,
      name,
    ]);
  const supplier = (name: string, categoryId: number | null) =>
    w.one(`INSERT INTO factory_suppliers (company_id, name, supplier_category_id) VALUES ($1, $2, $3) RETURNING id`, [
      w.companyId,
      name,
      categoryId,
    ]);
  const cotton = await supplier("Cotton Mill", await category("Cotton"));
  const wool = await supplier("Wool Mill", await category("Wool"));
  const loose = await supplier("Loose Mill", null);
  const container = async (number: string, supplierId: number, received: string, used: string, offloaded: string) => {
    const id = await w.one(
      `INSERT INTO factory_containers (company_id, container_number, supplier_id, status) VALUES ($1, $2, $3, 'OFFLOADED') RETURNING id`,
      [w.companyId, `${w.tag}${number}`, supplierId]
    );
    await w.q(
      `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, quantity_kg, offloaded_at)
       VALUES ($1, $2, $3, $4, $3, $5)`,
      [w.companyId, id, received, used, offloaded]
    );
    return id;
  };
  const c1 = await container("C1", cotton, "1000", "300", "2025-03-03T08:00:00Z");
  await container("C2", wool, "500", "120", "2025-03-11T08:00:00Z");
  await container("C3", loose, "200", "0", "2025-03-12T08:00:00Z");
  const batch = await w.one(
    `INSERT INTO factory_mix_batches (company_id, batch_date, name) VALUES ($1, '2025-03-05', 'Mix A') RETURNING id`,
    [w.companyId]
  );
  await w.q(`INSERT INTO factory_mix_batch_sources (mix_batch_id, container_id, weight_kg) VALUES ($1, $2, 250)`, [
    batch,
    c1,
  ]);
  await w.q(
    `INSERT INTO factory_raw_material_adjustments (company_id, supplier_id, date, type, kg)
     VALUES ($1, $2, '2025-03-12', 'ADD', 40), ($1, $3, '2025-03-13', 'REMOVE', 15)`,
    [w.companyId, wool, cotton]
  );
}

describe("weekly production report export", () => {
  it("builds one Excel block per week with category rows and totals", async () => {
    await withFactoryWorld(async (w) => {
      await seed(w);
      const res = await w.agent.get(URL).query({ format: "excel", period: "all" }).buffer(true).parse(binary);
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toContain("weekly-production-report.xlsx");
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(res.body);
      const sheet = book.getWorksheet("Weekly Report")!;
      const firstColumn: string[] = [];
      sheet.eachRow((row) => firstColumn.push(String(row.getCell(1).value ?? "")));
      const titles = firstColumn.filter((v) => v.startsWith("Week of"));
      expect(titles).toHaveLength(2);
      expect(firstColumn).toEqual(expect.arrayContaining(["Cotton", "Wool", "Uncategorized", "TOTAL"]));
      expect(firstColumn.filter((v) => v === "TOTAL")).toHaveLength(2);
    });
  });

  it("renders a multi-week PDF, and a no-data PDF and sheet for a period without weeks", async () => {
    await withFactoryWorld(async (w) => {
      await seed(w);
      const pdf = await w.agent.get(URL).query({ format: "pdf" }).buffer(true).parse(binary);
      expect(pdf.status).toBe(200);
      expect(pdf.headers["content-type"]).toBe("application/pdf");
      const text = (pdf.body as Buffer).toString("latin1");
      expect(text.startsWith("%PDF")).toBe(true);
      expect(text.match(/\/Type \/Page\b/g)!.length).toBe(2);

      const emptyPdf = await w.agent.get(URL).query({ format: "pdf", period: "week" }).buffer(true).parse(binary);
      expect(emptyPdf.status).toBe(200);
      expect((emptyPdf.body as Buffer).toString("latin1").match(/\/Type \/Page\b/g)!.length).toBe(1);

      for (const period of ["month", "year"]) {
        const sheetRes = await w.agent.get(URL).query({ format: "excel", period }).buffer(true).parse(binary);
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(sheetRes.body);
        expect(String(book.getWorksheet("Weekly Report")!.getCell("A1").value)).toMatch(
          /^No production data found for period: This (Month|Year)$/
        );
      }
      const invalid = await w.agent.get(URL).query({ format: "csv" });
      expect(invalid.status).toBe(400);
      expect(invalid.body.message).toBe("Invalid format.");
    });
  });

  it("answers an empty company with a no-data workbook or message", async () => {
    await withFactoryWorld(async (w) => {
      const excel = await w.agent.get(URL).buffer(true).parse(binary);
      expect(excel.status).toBe(200);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(excel.body);
      expect(book.getWorksheet("Weekly Report")!.getCell("A1").value).toBe("No data found");
      const json = await w.agent.get(URL).query({ format: "json" });
      expect(json.body).toEqual({ message: "No data" });
    });
  });
});
