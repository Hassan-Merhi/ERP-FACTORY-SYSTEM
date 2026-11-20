/**
 * Factory worker template, Excel import and code reassignment
 * (server/routes/factory-workers/import-export.ts): missing file, row
 * mapping (dates as text and Excel serials, numeric fields), matching an
 * existing worker by code, passport or national id, HMD auto-codes, row
 * errors, the daybook entry, and reassign-codes including a body companyId
 * of another company. Rolled back per test.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const IMPORT = "/api/factory/workers/import-excel";
const REASSIGN = "/api/factory/workers/reassign-codes";

async function workbook(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Workers");
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const worker = (w: FactoryWorld, name: string, fields: { code?: string; passport?: string; nid?: string } = {}) =>
  w.one(
    `INSERT INTO factory_workers (company_id, full_name, employee_code, passport_number, national_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [w.companyId, name, fields.code ?? null, fields.passport ?? null, fields.nid ?? null]
  );

describe("worker import template", () => {
  it("downloads the template with the header, hint and example rows", async () => {
    await withFactoryWorld(async (w) => {
      const res = await w.agent
        .get("/api/factory/workers/template.xlsx")
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => done(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toContain("worker_import_template.xlsx");
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as Parameters<typeof wb.xlsx.load>[0]);
      const sheet = wb.getWorksheet("Workers")!;
      expect(sheet.getRow(1).getCell(1).value).toBe("Full Name");
      expect(sheet.getRow(2).getCell(5).value).toBe("YYYY-MM-DD");
      expect(sheet.getRow(3).getCell(1).value).toBe("Ahmed Hassan");
    });
  });
});

describe("POST /api/factory/workers/import-excel", () => {
  it("refuses a request without a file", async () => {
    await withFactoryWorld(async (w) => {
      const res = await w.agent.post(IMPORT);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("No file uploaded");
    });
  });

  it("creates, updates and skips rows, assigning HMD codes after the highest existing one", async () => {
    await withFactoryWorld(async (w) => {
      const byCode = await worker(w, "Old Code", { code: "HMD007" });
      const byPassport = await worker(w, "Old Passport", { passport: "P-1" });
      const byNid = await worker(w, "Old Nid", { nid: "N-1" });
      await worker(w, "Odd code", { code: "X-12" });

      // Every row fills the numeric columns: a blank numeric cell is written
      // as "" and fails the row (bug reported), which would abort this
      // rolled-back transaction.
      const file = await workbook([
        [
          "Full Name",
          "Employee Code",
          "Passport Number",
          "National ID",
          "Date of Birth",
          "Date Joined",
          "Base Salary",
          "Per KG Rate",
          "Ignored Column",
        ],
        ["New Code", "HMD007", "", "", "1990-05-15", "", "3000", "1", "x"],
        ["New Passport", "", "P-1", "", 32874, "not a date", "1", "1", ""],
        ["New Nid", "", "", "N-1", "", "", "1", "0.15", ""],
        ["Fresh One", "", "", "", "", "2024-01-15", "100.5", "1", ""],
        ["Fresh Two", "FW-9", "", "", "", "", "abc", "1", ""],
        ["", "NONAME", "", "", "", "", "1", "1", ""],
      ]);
      const res = await w.agent.post(IMPORT).attach("file", file, "workers.xlsx");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ created: 2, updated: 3, skipped: 1, errors: ["Row 7: missing Full Name"] });

      const rows = await w.q<{
        id: number;
        full_name: string;
        employee_code: string | null;
        date_of_birth: string | null;
        base_salary: string | null;
        date_joined: string | null;
      }>(
        `SELECT id, full_name, employee_code, date_of_birth::text, base_salary::text, date_joined::text
           FROM factory_workers WHERE company_id = $1 ORDER BY id`,
        [w.companyId]
      );
      const by = (id: number) => rows.find((r) => r.id === id)!;
      expect(by(byCode)).toMatchObject({ full_name: "New Code", date_of_birth: "1990-05-15" });
      expect(by(byPassport)).toMatchObject({
        full_name: "New Passport",
        date_of_birth: "1990-01-01",
        date_joined: null,
      });
      expect(by(byNid).full_name).toBe("New Nid");
      expect(rows.find((r) => r.full_name === "Fresh One")).toMatchObject({
        employee_code: "HMD008",
        date_joined: "2024-01-15",
      });
      expect(rows.find((r) => r.full_name === "Fresh Two")).toMatchObject({
        employee_code: "FW-9",
        base_salary: "0.00",
      });

      const daybook = await w.q(
        `SELECT description FROM factory_daybook_entries WHERE company_id = $1 AND tx_type = 'WORKER_IMPORT'`,
        [w.companyId]
      );
      expect(daybook).toEqual([{ description: "Worker import: 2 created, 3 updated, 1 skipped" }]);
    });
  });
});

describe("POST /api/factory/workers/reassign-codes", () => {
  it("renumbers this company's workers in id order with the given or default prefix", async () => {
    await withFactoryWorld(async (w) => {
      const first = await worker(w, "A", { code: "Z9" });
      const second = await worker(w, "B");
      const res = await w.agent.post(REASSIGN).send({ prefix: "FW" });
      expect(res.status).toBe(200);
      expect(res.body.codes).toEqual([
        { id: first, name: "A", code: "FW001" },
        { id: second, name: "B", code: "FW002" },
      ]);
      const again = await w.agent.post(REASSIGN).send({});
      expect(again.body.codes.map((c: { code: string }) => c.code)).toEqual(["HMD001", "HMD002"]);
    });
  });

  it("refuses a body companyId of another company and leaves its workers alone", async () => {
    await withFactoryWorld(async (w) => {
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const foreign = await w.one(
        `INSERT INTO factory_workers (company_id, full_name, employee_code) VALUES ($1, 'Foreign', 'KEEP-1') RETURNING id`,
        [other]
      );
      const res = await w.agent.post(REASSIGN).send({ companyId: other, prefix: "PWN" });
      // The route itself trusts req.body.companyId; the company-scope
      // middleware refuses the foreign id before the handler runs.
      expect(res.status).toBe(403);
      const [row] = await w.q(`SELECT employee_code FROM factory_workers WHERE id = $1`, [foreign]);
      expect(row.employee_code).toBe("KEEP-1");
    });
  });
});
