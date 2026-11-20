/**
 * Factory worker template, Excel import and code reassignment
 * (server/routes/factory-workers/import-export.ts): missing file, row
 * mapping (dates as text and Excel serials, numeric fields), matching an
 * existing worker by code, passport or national id, HMD auto-codes, row
 * errors, the daybook entry, and reassign-codes including a body companyId
 * of another company. Rolled back per test.
 */
import ExcelJS from "exceljs";
import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { db } from "../server/db";
import { registerFactoryWorkerImportExportRoutes } from "../server/routes/factory-workers/import-export";

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

describe("worker import with blank numeric cells", () => {
  it("imports rows with blank rates: new workers take the default, updates keep the stored value", async () => {
    await withFactoryWorld(async (w) => {
      const existing = await w.one(
        `INSERT INTO factory_workers (company_id, full_name, employee_code, base_salary, per_kg_rate)
         VALUES ($1, 'Kept Rates', $2, 500, 0.25) RETURNING id`,
        [w.companyId, `${w.tag}K1`]
      );
      const file = await workbook([
        ["Full Name", "Employee Code", "Base Salary", "Per KG Rate", "Hourly Rate"],
        ["Blank Rates", `${w.tag}B1`, "", "", ""],
        ["Kept Rates", `${w.tag}K1`, "", "", "3"],
        ["Spaces", `${w.tag}S1`, "   ", "0.5", ""],
      ]);
      const res = await w.agent.post(IMPORT).attach("file", file, "workers.xlsx");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ created: 2, updated: 1, skipped: 0, errors: [] });

      const rows = await w.q<{ employee_code: string; base_salary: string; per_kg_rate: string; hourly_rate: string }>(
        `SELECT employee_code, base_salary::text, per_kg_rate::text, hourly_rate::text
           FROM factory_workers WHERE company_id = $1 ORDER BY employee_code`,
        [w.companyId]
      );
      const by = (code: string) => rows.find((r) => r.employee_code === `${w.tag}${code}`)!;
      expect(by("B1")).toMatchObject({ base_salary: "0.00", per_kg_rate: "0.0000", hourly_rate: "0.0000" });
      expect(by("K1")).toMatchObject({ base_salary: "500.00", per_kg_rate: "0.2500", hourly_rate: "3.0000" });
      expect(by("S1")).toMatchObject({ base_salary: "0.00", per_kg_rate: "0.5000" });
      expect(existing).toBeGreaterThan(0);
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
      // The company-scope middleware refuses the foreign id before the handler runs.
      expect(res.status).toBe(403);
      const [row] = await w.q(`SELECT employee_code FROM factory_workers WHERE id = $1`, [foreign]);
      expect(row.employee_code).toBe("KEEP-1");
    });
  });

  it("uses only the session company even when the handler is reached with a foreign body companyId", async () => {
    await withFactoryWorld(async (w) => {
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}Y`,
      ]);
      const foreign = await w.one(
        `INSERT INTO factory_workers (company_id, full_name, employee_code) VALUES ($1, 'Foreign', 'KEEP-2') RETURNING id`,
        [other]
      );
      const own = await worker(w, "Own");
      // Mount the handler alone (no company-scope middleware) to check the
      // handler itself ignores the body companyId.
      const bare = express();
      bare.use(express.json());
      bare.use((req, _res, next) => {
        (req as unknown as { session: Record<string, unknown> }).session = { factoryCompanyId: w.companyId };
        next();
      });
      const passThrough: RequestHandler = (_req, _res, next) => next();
      registerFactoryWorkerImportExportRoutes(bare, passThrough, db);
      const res = await request(bare).post(REASSIGN).send({ companyId: other, prefix: "OWN" });
      expect(res.status).toBe(200);
      expect(res.body.codes).toEqual([{ id: own, name: "Own", code: "OWN001" }]);
      const [row] = await w.q(`SELECT employee_code FROM factory_workers WHERE id = $1`, [foreign]);
      expect(row.employee_code).toBe("KEEP-2");
    });
  });
});
