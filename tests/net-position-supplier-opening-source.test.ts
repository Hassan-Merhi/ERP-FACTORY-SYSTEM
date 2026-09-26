/**
 * ERP Net Position must include a company's supplier opening balances even when
 * the supplier has no voucher activity (#1837), in both the live report and the
 * Excel export, and must never read another company's supplier masters.
 */
import ExcelJS from "exceljs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "npsupopen";
const OWN_SUPPLIER = `${TEST_PREFIX} Opening Only Supplier`;
const FOREIGN_SUPPLIER = `${TEST_PREFIX} Other Company Supplier`;

let ctx: TestContext;
let agent: request.SuperAgentTest;
let foreignCompanyId = 0;

async function maintenance(sql: string, params: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.company_scope_maintenance = 'on'");
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function supplierNames(accounts: Array<{ name: string; category: string }>) {
  return accounts.filter((account) => account.category.startsWith("Supplier")).map((account) => account.name);
}

async function workbookText(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const cells: string[] = [];
  workbook.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.text ?? "")))));
  return cells.join("\n");
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  const foreign = await maintenance(
    `INSERT INTO companies (code, name, company_type) VALUES ($1, $2, 'erp') RETURNING id`,
    [`${TEST_PREFIX}-OTHER`, `${TEST_PREFIX} Other Company`]
  );
  foreignCompanyId = foreign.rows[0].id;
  await maintenance(
    `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance)
     VALUES ($1, $2, $3, $4, '1250.00'), ($5, $6, $7, $8, '900.00')`,
    [
      ctx.companyId,
      `${TEST_PREFIX}-OWN`,
      OWN_SUPPLIER,
      `${TEST_PREFIX}-own@example.test`,
      foreignCompanyId,
      `${TEST_PREFIX}-FOREIGN`,
      FOREIGN_SUPPLIER,
      `${TEST_PREFIX}-foreign@example.test`,
    ]
  );
}, 60000);

afterAll(async () => {
  await maintenance(`DELETE FROM suppliers WHERE code LIKE $1`, [`${TEST_PREFIX}-%`]);
  if (foreignCompanyId) await maintenance(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("ERP Net Position supplier opening balances", () => {
  it("shows an opening-balance-only supplier as owed in the live report, never another company's", async () => {
    const response = await agent.get("/api/stats/net-profit?toDate=2099-01-01");
    expect(response.status).toBe(200);

    const owed = response.body.onUs.accounts as Array<{ name: string; value: number; category: string }>;
    expect(owed).toContainEqual(expect.objectContaining({ name: OWN_SUPPLIER, value: 1250, category: "Supplier" }));
    const everySupplier = [...supplierNames(owed), ...supplierNames(response.body.forUs.accounts)];
    expect(everySupplier).not.toContain(FOREIGN_SUPPLIER);
  });

  it("carries the same supplier into the Excel export and keeps other companies out", async () => {
    const response = await agent
      .get("/api/stats/net-position-excel?toDate=2099-01-01")
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
    expect(response.status).toBe(200);

    const text = await workbookText(response.body as Buffer);
    expect(text).toContain(OWN_SUPPLIER);
    expect(text).not.toContain(FOREIGN_SUPPLIER);
  });
});
