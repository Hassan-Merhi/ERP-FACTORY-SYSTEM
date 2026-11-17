/**
 * Phase 4 — Real XLSX Export Tests
 * ----------------------------------
 * Downloads actual Excel responses from factory export endpoints and opens
 * the workbook with ExcelJS to verify:
 *   - Returned binary is valid XLSX (PK magic bytes + ExcelJS can load it)
 *   - Expected sheet names exist
 *   - Required column headers are present on the header row
 *   - No other company's data leaks into the workbook (real cross-company bale)
 *   - Unauthenticated requests are rejected with 401
 *
 * Factory endpoints fall back to currentCompanyId, so the standard
 * seedTestData + set-company auth flow works without a factoryCompanyId.
 *
 * Note on shared-DB environment: this test suite runs against a shared database
 * that may contain production factory bales. The structural tests (valid XLSX,
 * sheet names, headers, auth) work regardless of what data is present. The
 * data-presence tests (seeded bale appears, export-full.xlsx success path) are
 * run conditionally — they are skipped when the test infrastructure detects that
 * the session's company does not match the freshly-created test company (which
 * can happen on a shared DB when a previous run left factory_bales behind,
 * blocking location cleanup and causing a new company to be created).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import ExcelJS from "exceljs";
import { db, pool } from "../server/db";
import { eq, sql } from "drizzle-orm";
import * as schema from "../shared/schema";
import { factoryBales } from "../shared/schema/factory";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "xlsexp";
const BALE_FINALIZED_DATE = "2000-06-15";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let seededBaleId: number | null = null;
// CI uses an isolated PostgreSQL database, so the seeded bale must always be
// visible through the authenticated test company's export endpoints.
// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadWorkbook(body: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(body);
  return wb;
}

function isValidXlsxMagic(buf: Buffer): boolean {
  return buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

function getBinary(agentOrApp: any, url: string): request.Test {
  const req =
    typeof agentOrApp.get === "function"
      ? (agentOrApp as request.SuperAgentTest).get(url)
      : request(agentOrApp).get(url);
  return req.buffer(true).parse((_res: any, fn: any) => {
    const chunks: Buffer[] = [];
    _res.on("data", (c: Buffer) => chunks.push(c));
    _res.on("end", () => fn(null, Buffer.concat(chunks)));
  });
}

async function login() {
  const loginRes = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  if (loginRes.status !== 200) throw new Error(`Login failed: ${loginRes.status} — ${JSON.stringify(loginRes.body)}`);

  const setCoRes = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (setCoRes.status !== 200)
    throw new Error(`set-company failed: ${setCoRes.status} — ${JSON.stringify(setCoRes.body)}`);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  await login();

  // Seed one factory bale for the test company.
  // erpLocationId is intentionally omitted (null) so that the location deletion
  // in cleanupTestData is not blocked by a FK constraint, preventing orphaned rows
  // from accumulating across test runs.
  const [bale] = await db
    .insert(factoryBales)
    .values({
      companyId: ctx.companyId,
      baleCode: `${TEST_PREFIX}-BALE-001`,
      referenceNumber: `${TEST_PREFIX}-REF-001`,
      articleCode: `${TEST_PREFIX}-ART`,
      productName: "Test Export Bale",
      category: "Test Category",
      grade: "A",
      weightKg: "50.500",
      costPerKg: "2.00",
      totalCost: "101.00",
      status: "FINALIZED",
      finalizedAt: new Date(`${BALE_FINALIZED_DATE}T12:00:00Z`),
      quantity: 1,
      // erpLocationId: null (default) — avoids FK constraint on location cleanup
    })
    .returning({ id: factoryBales.id });
  seededBaleId = bale.id;
}, 60000);

afterAll(async () => {
  // Clean up factory bales BEFORE cleanupTestData deletes locations
  // (location deletion fails with FK constraint if factory_bales.erpLocationId
  // references any location in the test company).
  if (seededBaleId !== null) {
    await db.delete(factoryBales).where(eq(factoryBales.id, seededBaleId));
  }
  // Also sweep any orphaned xlsexp factory bales left by previous failed runs
  const testCompanies = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(sql`${schema.companies.name} LIKE ${"%" + TEST_PREFIX + "%"}`);
  for (const co of testCompanies) {
    await db.delete(factoryBales).where(eq(factoryBales.companyId, co.id));
  }
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

// ── Bale Stock Register ───────────────────────────────────────────────────────

describe("XLSX Export — Bale Stock Register", () => {
  it("GET /api/factory/bales/stock-register.xlsx returns 200 with Excel content-type", async () => {
    const res = await getBinary(agent, "/api/factory/bales/stock-register.xlsx");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"] ?? "").toMatch(/spreadsheet|excel|octet-stream/i);
  });

  it("returned buffer is valid XLSX (PK magic bytes)", async () => {
    const res = await getBinary(agent, "/api/factory/bales/stock-register.xlsx");
    expect(res.status).toBe(200);
    const buf = res.body as Buffer;
    expect(buf.length).toBeGreaterThan(1000);
    expect(isValidXlsxMagic(buf)).toBe(true);
  });

  it("ExcelJS can open the returned buffer without error", async () => {
    const res = await getBinary(agent, "/api/factory/bales/stock-register.xlsx");
    expect(res.status).toBe(200);
    const wb = await loadWorkbook(res.body as Buffer);
    expect(wb).toBeDefined();
  });

  it('sheet "Stock Register" exists', async () => {
    const res = await getBinary(agent, "/api/factory/bales/stock-register.xlsx");
    const wb = await loadWorkbook(res.body as Buffer);
    expect(wb.getWorksheet("Stock Register")).toBeDefined();
  });

  it('sheet "Summary" exists', async () => {
    const res = await getBinary(agent, "/api/factory/bales/stock-register.xlsx");
    const wb = await loadWorkbook(res.body as Buffer);
    expect(wb.getWorksheet("Summary")).toBeDefined();
  });

  it('"Stock Register" sheet has expected column headers', async () => {
    const res = await getBinary(agent, "/api/factory/bales/stock-register.xlsx");
    const wb = await loadWorkbook(res.body as Buffer);
    const ws = wb.getWorksheet("Stock Register")!;
    const headers: string[] = [];
    ws.getRow(1).eachCell((cell) => {
      if (cell.value) headers.push(String(cell.value));
    });
    expect(headers).toContain("Reference Number");
    expect(headers).toContain("Weight (KG)");
    expect(headers).toContain("Status");
  });

  it('"Summary" sheet has Status, Bale Count, Total Weight headers', async () => {
    const res = await getBinary(agent, "/api/factory/bales/stock-register.xlsx");
    const wb = await loadWorkbook(res.body as Buffer);
    const ws = wb.getWorksheet("Summary")!;
    const headers: string[] = [];
    ws.getRow(1).eachCell((cell) => {
      if (cell.value) headers.push(String(cell.value));
    });
    expect(headers).toContain("Status");
    expect(headers).toContain("Bale Count");
    expect(headers).toContain("Total Weight (KG)");
  });

  it("seeded bale reference number appears in the export", async () => {
    // This test doubles as a session-company diagnostic: if our seeded bale
    // (company_id = ctx.companyId) does not appear, the session is pointing to
    // a different company (shared-DB environment issue). We record the outcome
    // so the export-full.xlsx success-path tests can skip gracefully.
    const res = await getBinary(agent, "/api/factory/bales/stock-register.xlsx");
    const wb = await loadWorkbook(res.body as Buffer);
    const ws = wb.getWorksheet("Stock Register")!;

    const refNumbers: string[] = [];
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const val = row.getCell(1).value;
      if (val) refNumbers.push(String(val));
    });
    expect(refNumbers).toContain(`${TEST_PREFIX}-REF-001`);
  });

  it("export does not contain another company's bale reference", async () => {
    // Use a unique suffix to avoid collision if a previous run was interrupted
    const suffix = Date.now().toString(36).slice(-4).toUpperCase();
    const [otherCompany] = await db
      .insert(schema.companies)
      .values({ code: `XO${suffix}`, name: `${TEST_PREFIX}_OtherCo_${suffix}`, baseCurrency: "USD" })
      .returning();

    let otherBaleId: number | null = null;
    try {
      const [otherBale] = await db
        .insert(factoryBales)
        .values({
          companyId: otherCompany.id,
          baleCode: `${TEST_PREFIX}-OTHER-BALE`,
          referenceNumber: `${TEST_PREFIX}-OTHER-REF`,
          articleCode: `${TEST_PREFIX}-OTHER-ART`,
          productName: "Other Company Bale",
          category: "Foreign",
          grade: "B",
          weightKg: "30.000",
          costPerKg: "1.00",
          totalCost: "30.00",
          status: "IN_STOCK",
          quantity: 1,
        })
        .returning({ id: factoryBales.id });
      otherBaleId = otherBale.id;

      const res = await getBinary(agent, "/api/factory/bales/stock-register.xlsx");
      const wb = await loadWorkbook(res.body as Buffer);
      const ws = wb.getWorksheet("Stock Register")!;

      const refNumbers: string[] = [];
      ws.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const val = row.getCell(1).value;
        if (val) refNumbers.push(String(val));
      });

      // The other company's bale reference must NOT appear in our company's export
      expect(refNumbers).not.toContain(`${TEST_PREFIX}-OTHER-REF`);
    } finally {
      if (otherBaleId !== null) {
        await db.delete(factoryBales).where(eq(factoryBales.id, otherBaleId));
      }
      await db.delete(schema.companies).where(eq(schema.companies.id, otherCompany.id));
    }
  });

  it("unauthenticated request returns 401", async () => {
    const res = await getBinary(request.agent(ctx.app), "/api/factory/bales/stock-register.xlsx");
    expect(res.status).toBe(401);
  });
});

// ── Location Inventory Export ─────────────────────────────────────────────────

describe("XLSX Export — Location Inventory", () => {
  it("GET /api/factory/location-inventory/:id/export/excel returns 200 with Excel content-type", async () => {
    const res = await getBinary(agent, `/api/factory/location-inventory/${ctx.locationId}/export/excel`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"] ?? "").toMatch(/spreadsheet|excel|octet-stream/i);
  });

  it("returned buffer is valid XLSX (PK magic bytes)", async () => {
    const res = await getBinary(agent, `/api/factory/location-inventory/${ctx.locationId}/export/excel`);
    expect(res.status).toBe(200);
    const buf = res.body as Buffer;
    expect(buf.length).toBeGreaterThan(1000);
    expect(isValidXlsxMagic(buf)).toBe(true);
  });

  it("ExcelJS can open the returned buffer without error", async () => {
    const res = await getBinary(agent, `/api/factory/location-inventory/${ctx.locationId}/export/excel`);
    const wb = await loadWorkbook(res.body as Buffer);
    expect(wb).toBeDefined();
  });

  it('contains "Stock Summary" sheet', async () => {
    const res = await getBinary(agent, `/api/factory/location-inventory/${ctx.locationId}/export/excel`);
    const wb = await loadWorkbook(res.body as Buffer);
    expect(wb.getWorksheet("Stock Summary")).toBeDefined();
  });

  it('contains "Bale Details" sheet', async () => {
    const res = await getBinary(agent, `/api/factory/location-inventory/${ctx.locationId}/export/excel`);
    const wb = await loadWorkbook(res.body as Buffer);
    expect(wb.getWorksheet("Bale Details")).toBeDefined();
  });

  it('contains "Wipers & Garbage" sheet', async () => {
    const res = await getBinary(agent, `/api/factory/location-inventory/${ctx.locationId}/export/excel`);
    const wb = await loadWorkbook(res.body as Buffer);
    expect(wb.getWorksheet("Wipers & Garbage")).toBeDefined();
  });

  it('contains "Garbage & Wiper Details" sheet', async () => {
    const res = await getBinary(agent, `/api/factory/location-inventory/${ctx.locationId}/export/excel`);
    const wb = await loadWorkbook(res.body as Buffer);
    expect(wb.getWorksheet("Garbage & Wiper Details")).toBeDefined();
  });

  it('"Stock Summary" sheet has Article Code, Product Name, Total KG headers', async () => {
    const res = await getBinary(agent, `/api/factory/location-inventory/${ctx.locationId}/export/excel`);
    const wb = await loadWorkbook(res.body as Buffer);
    const ws = wb.getWorksheet("Stock Summary")!;
    const headers: string[] = [];
    ws.getRow(1).eachCell((cell) => {
      if (cell.value) headers.push(String(cell.value));
    });
    expect(headers).toContain("Article Code");
    expect(headers).toContain("Product Name");
    expect(headers).toContain("Total KG");
  });

  it("non-existent location ID returns < 500 (empty workbook or 4xx, never 500)", async () => {
    const res = await agent.get("/api/factory/location-inventory/999999999/export/excel");
    expect(res.status).toBeLessThan(500);
  });

  it("unauthenticated request returns 401", async () => {
    const res = await getBinary(
      request.agent(ctx.app),
      `/api/factory/location-inventory/${ctx.locationId}/export/excel`
    );
    expect(res.status).toBe(401);
  });
});

// ── Daily Production Report Export ───────────────────────────────────────────

describe("XLSX Export — Daily Production Report", () => {
  it("GET /api/factory/daily-report/export?format=excel returns 200 with Excel content-type", async () => {
    const res = await getBinary(agent, "/api/factory/daily-report/export?format=excel");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"] ?? "").toMatch(/spreadsheet|excel|octet-stream/i);
  });

  it("returned buffer is valid XLSX (PK magic bytes)", async () => {
    const res = await getBinary(agent, "/api/factory/daily-report/export?format=excel");
    expect(res.status).toBe(200);
    const buf = res.body as Buffer;
    expect(buf.length).toBeGreaterThan(1000);
    expect(isValidXlsxMagic(buf)).toBe(true);
  });

  it("ExcelJS can open the returned buffer without error", async () => {
    const res = await getBinary(agent, "/api/factory/daily-report/export?format=excel");
    const wb = await loadWorkbook(res.body as Buffer);
    expect(wb).toBeDefined();
  });

  it('contains "Production Report" sheet', async () => {
    const res = await getBinary(agent, "/api/factory/daily-report/export?format=excel");
    const wb = await loadWorkbook(res.body as Buffer);
    expect(wb.getWorksheet("Production Report")).toBeDefined();
  });

  it('"Production Report" sheet has Date, Batch Code, KG Used, Notes headers', async () => {
    const res = await getBinary(agent, "/api/factory/daily-report/export?format=excel");
    const wb = await loadWorkbook(res.body as Buffer);
    const ws = wb.getWorksheet("Production Report")!;
    // The universal workbook (#3204) puts a title block above the table, so
    // find the header row instead of assuming it is row 1.
    let headers: string[] = [];
    for (let rowNumber = 1; rowNumber <= 15 && !headers.includes("Date"); rowNumber += 1) {
      headers = [];
      ws.getRow(rowNumber).eachCell((cell) => {
        if (cell.value) headers.push(String(cell.value));
      });
    }
    expect(headers).toContain("Date");
    expect(headers).toContain("Batch Code");
    expect(headers).toContain("KG Used");
    expect(headers).toContain("Notes");
  });

  it("unauthenticated request returns 401", async () => {
    const res = await getBinary(request.agent(ctx.app), "/api/factory/daily-report/export?format=excel");
    expect(res.status).toBe(401);
  });
});

// ── Bale Full Export ──────────────────────────────────────────────────────────
//
// Error and success paths both run against the isolated CI database.

describe("XLSX Export — Bale Full Export (error cases)", () => {
  it("GET without date param returns 400 with message mentioning 'date'", async () => {
    const res = await agent.get("/api/factory/bales/export-full.xlsx");
    expect(res.status).toBe(400);
    expect(String(res.body?.message ?? "")).toMatch(/date/i);
  });

  it("with a valid date but no matching bales returns 404", async () => {
    const res = await agent.get("/api/factory/bales/export-full.xlsx?date=1999-01-01");
    expect(res.status).toBe(404);
  });

  it("unauthenticated request returns 401", async () => {
    const res = await request(ctx.app).get(`/api/factory/bales/export-full.xlsx?date=${BALE_FINALIZED_DATE}`);
    expect(res.status).toBe(401);
  });
});

describe("XLSX Export — Bale Full Export (success path)", () => {
  it("with seeded bale date returns 200 with valid XLSX", async () => {
    const res = await getBinary(agent, `/api/factory/bales/export-full.xlsx?date=${BALE_FINALIZED_DATE}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"] ?? "").toMatch(/spreadsheet|excel|octet-stream/i);
    const buf = res.body as Buffer;
    expect(buf.length).toBeGreaterThan(1000);
    expect(isValidXlsxMagic(buf)).toBe(true);
  });

  it("ExcelJS can open the returned buffer without error", async () => {
    const res = await getBinary(agent, `/api/factory/bales/export-full.xlsx?date=${BALE_FINALIZED_DATE}`);
    const wb = await loadWorkbook(res.body as Buffer);
    expect(wb).toBeDefined();
  });

  it('contains "Bales" sheet', async () => {
    const res = await getBinary(agent, `/api/factory/bales/export-full.xlsx?date=${BALE_FINALIZED_DATE}`);
    const wb = await loadWorkbook(res.body as Buffer);
    expect(wb.getWorksheet("Bales")).toBeDefined();
  });

  it('"Bales" sheet contains the seeded bale reference number', async () => {
    const res = await getBinary(agent, `/api/factory/bales/export-full.xlsx?date=${BALE_FINALIZED_DATE}`);
    const wb = await loadWorkbook(res.body as Buffer);
    const ws = wb.getWorksheet("Bales")!;
    const refNumbers: string[] = [];
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const val = row.getCell(1).value;
      if (val) refNumbers.push(String(val));
    });
    expect(refNumbers).toContain(`${TEST_PREFIX}-REF-001`);
  });

  it('"Bales" sheet has expected column headers (Reference Number, Weight, Status)', async () => {
    const res = await getBinary(agent, `/api/factory/bales/export-full.xlsx?date=${BALE_FINALIZED_DATE}`);
    const wb = await loadWorkbook(res.body as Buffer);
    const ws = wb.getWorksheet("Bales")!;
    const headers: string[] = [];
    ws.getRow(1).eachCell((cell) => {
      if (cell.value) headers.push(String(cell.value));
    });
    expect(headers).toContain("Reference Number");
    expect(headers).toContain("Weight (kg)");
    expect(headers).toContain("Status");
  });
});
