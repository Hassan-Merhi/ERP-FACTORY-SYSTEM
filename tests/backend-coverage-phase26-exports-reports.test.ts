/**
 * Phase 26 — Exports and reports.
 *
 * Covers representative accounting, Factory, and Supplier Partner generators
 * with real PostgreSQL fixtures. The suite validates PDF/XLSX/CSV bytes, empty
 * datasets, a large Factory dataset, invalid references, and tenant-scoped
 * report behavior. The broad read-only manifest sweep remains the companion
 * coverage for the rest of the report/export surface.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import ExcelJS from "exceljs";

import { pool } from "../server/db";
import {
  cleanupTestData,
  closeTestServer,
  seedTestData,
  type TestContext,
} from "./setup";

const PREFIX = `p26exp-${Date.now().toString(36)}`;
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const LARGE_ROW_COUNT = 600;

let ctx: TestContext;
let agent: request.SuperAgentTest;
let factoryCompanyId = 0;
let spCompanyId = 0;

function binary(test: request.Test): request.Test {
  return test.buffer(true).parse((res, callback) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => callback(null, Buffer.concat(chunks)));
  });
}

function expectPdf(buffer: Buffer) {
  expect(buffer.subarray(0, 4).toString("ascii")).toBe("%PDF");
}

function expectXlsx(buffer: Buffer) {
  expect([...buffer.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
}

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

async function createCompany(
  companyType: "factory" | "supplier_partner",
  suffix: string
): Promise<number> {
  const created = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, active, base_currency)
     VALUES ($1, $2, $3, true, 'USD')
     RETURNING id`,
    [
      `P26-${suffix}-${Date.now().toString(36)}`.slice(0, 50),
      `${PREFIX}_${suffix}`,
      companyType,
    ]
  );
  const companyId = created.rows[0].id;
  await pool.query(
    `INSERT INTO user_company_roles (user_id, company_id, role, can_delete_records, can_sell_negative_stock)
     VALUES ($1, $2, 'Admin', true, true)`,
    [ctx.userId, companyId]
  );
  return companyId;
}

async function selectCompany(companyId: number): Promise<void> {
  const response = await agent
    .post("/api/auth/set-company")
    .send({ companyId });
  expect(response.status, response.text).toBe(200);
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app) as request.SuperAgentTest;

  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  if (login.status !== 200) {
    throw new Error(`Login failed: ${login.status} ${login.text}`);
  }

  factoryCompanyId = await createCompany("factory", "FACTORY");
  spCompanyId = await createCompany("supplier_partner", "SP");
  await selectCompany(ctx.companyId);
}, 120_000);

afterAll(async () => {
  const auxiliaryIds = [factoryCompanyId, spCompanyId].filter((id) => id > 0);
  if (auxiliaryIds.length > 0) {
    await pool
      .query(`DELETE FROM factory_payrolls WHERE company_id = ANY($1::int[])`, [
        auxiliaryIds,
      ])
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM factory_workers WHERE company_id = ANY($1::int[])`, [
        auxiliaryIds,
      ])
      .catch(() => undefined);
    await pool
      .query(
        `DELETE FROM user_location_cash_accounts WHERE company_id = ANY($1::int[])`,
        [auxiliaryIds]
      )
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM user_locations WHERE company_id = ANY($1::int[])`, [
        auxiliaryIds,
      ])
      .catch(() => undefined);
    await pool
      .query(
        `DELETE FROM user_security_permissions WHERE company_id = ANY($1::int[])`,
        [auxiliaryIds]
      )
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM user_company_roles WHERE company_id = ANY($1::int[])`, [
        auxiliaryIds,
      ])
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM audit_log WHERE company_id = ANY($1::int[])`, [
        auxiliaryIds,
      ])
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM login_history WHERE company_id = ANY($1::int[])`, [
        auxiliaryIds,
      ])
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [auxiliaryIds])
      .catch(() => undefined);
  }
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 120_000);

describe("Phase 26 exports and reports", () => {
  it("generates an accounting XLSX report for an empty period", async () => {
    await selectCompany(ctx.companyId);
    const response = await binary(
      agent
        .get("/api/reports/net-position-monthly-excel")
        .query({ startDate: "2025-01-01", endDate: "2025-03-31" })
    );

    expect(response.status, response.text).toBe(200);
    expect(response.headers["content-type"]).toContain(XLSX_MIME);
    const body = response.body as Buffer;
    expectXlsx(body);
    const workbook = await loadWorkbook(body);
    expect(workbook.worksheets.length).toBeGreaterThan(0);
  }, 120_000);

  it("rejects invalid or inaccessible accounting report references cleanly", async () => {
    await selectCompany(ctx.companyId);

    const missingDate = await agent.get(
      "/api/reports/net-position-monthly-excel"
    );
    expect(missingDate.status).toBe(400);

    const invalidCompany = await agent
      .get("/api/reports/net-position-monthly-excel")
      .query({
        companyId: 999_999_999,
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });
    expect(invalidCompany.status).toBe(403);
    expect(invalidCompany.body.code).toBe("COMPANY_ACCESS_DENIED");
  });

  it("generates a valid Factory payroll PDF when there are no payroll rows", async () => {
    await selectCompany(factoryCompanyId);
    const response = await binary(
      agent.post("/api/factory/payroll/export-pdf").send({
        companyId: factoryCompanyId,
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      })
    );

    expect(response.status, response.text).toBe(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
    expectPdf(response.body as Buffer);
  }, 60_000);

  it("generates and reopens a large Factory payroll XLSX without truncating workers", async () => {
    await selectCompany(factoryCompanyId);

    await pool.query(
      `INSERT INTO factory_workers
         (company_id, employee_code, full_name, salary_type, base_salary, active)
       SELECT $1,
              $2 || '-' || g::text,
              'Phase 26 Worker ' || LPAD(g::text, 4, '0'),
              'Monthly',
              '1000.00',
              true
         FROM generate_series(1, $3::int) AS g`,
      [factoryCompanyId, PREFIX, LARGE_ROW_COUNT]
    );
    await pool.query(
      `INSERT INTO factory_payrolls
         (company_id, worker_id, period_start, period_end, base_salary, net_salary, total_working_days, present_days, status)
       SELECT $1, id, '2026-08-01', '2026-08-31', '1000.00', '1000.00', 26, '26.0', 'DRAFT'
         FROM factory_workers
        WHERE company_id = $1 AND employee_code LIKE $2`,
      [factoryCompanyId, `${PREFIX}-%`]
    );

    const response = await binary(
      agent.post("/api/factory/payroll/export-excel").send({
        companyId: factoryCompanyId,
        startDate: "2026-08-01",
        endDate: "2026-08-31",
      })
    );

    expect(response.status, response.text).toBe(200);
    expect(response.headers["content-type"]).toContain(XLSX_MIME);
    const body = response.body as Buffer;
    expectXlsx(body);
    expect(body.length).toBeGreaterThan(25_000);

    const workbook = await loadWorkbook(body);
    const summary = workbook.getWorksheet("Payroll Summary");
    expect(summary).toBeTruthy();
    expect(summary!.rowCount).toBeGreaterThan(LARGE_ROW_COUNT);

    const workerNames: string[] = [];
    summary!.eachRow({ includeEmpty: false }, (row) => {
      const value = row.getCell(2).value;
      if (typeof value === "string" && value.startsWith("Phase 26 Worker")) {
        workerNames.push(value);
      }
    });
    expect(workerNames).toHaveLength(LARGE_ROW_COUNT);
  }, 120_000);

  it("validates Factory export references instead of producing a broken download", async () => {
    await selectCompany(factoryCompanyId);
    const response = await agent
      .post("/api/factory/payroll/export-excel")
      .send({
        companyId: 0,
        startDate: "2026-08-01",
        endDate: "2026-08-31",
      });
    expect(response.status).toBe(400);
  });

  it("generates a valid empty Supplier Partner XLSX and rejects malformed location references", async () => {
    await selectCompany(spCompanyId);

    const response = await binary(
      agent
        .get("/api/sp/sales-form/export-v2")
        .query({ fromDate: "2026-01-01", toDate: "2026-01-02" })
    );
    expect(response.status, response.text).toBe(200);
    expect(response.headers["content-type"]).toContain(XLSX_MIME);
    const body = response.body as Buffer;
    expectXlsx(body);
    const workbook = await loadWorkbook(body);
    expect(workbook.worksheets.length).toBeGreaterThan(0);

    const invalidLocation = await agent
      .get("/api/sp/sales-form/export-v2")
      .query({
        fromDate: "2026-01-01",
        toDate: "2026-01-02",
        locationId: -1,
      });
    expect(invalidLocation.status).toBe(400);
    expect(invalidLocation.body.message).toMatch(/locationId/i);
  }, 120_000);

  it("generates Supplier Partner reconciliation CSV safely with an empty operational register", async () => {
    await selectCompany(spCompanyId);
    const response = await agent.get("/api/sp/reconciliation/full/export.csv");

    expect(response.status, response.text).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain(
      `sp-reconciliation-${spCompanyId}.csv`
    );
    expect(response.text).toContain(
      "surface,database_value,independent_value,status,evidence_status,basis,detail"
    );
    expect(response.text.split("\n").length).toBeGreaterThan(2);
  }, 120_000);
});
