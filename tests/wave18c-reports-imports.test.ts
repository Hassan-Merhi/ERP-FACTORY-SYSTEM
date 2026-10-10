/**
 * Wave 18 (C) — accounts list, statements, imports and aging.
 *
 *   1. /api/accounts/all is the balance engine's: a line naming a ledger and a
 *      bank counts once (the ledger's), another company's voucher naming the
 *      bank is not counted, a sideless liability opening is Cr, an employee's
 *      sideless opening Cr, and a start date carries the engine's opening;
 *   2. the statement Excel opens bank and employee at the engine's period
 *      opening (it opened them at zero) and lists only the lines the engine
 *      counts; the PDF refuses another company's account (404);
 *   3. bale and raw-stock imports: Admin/Owner only, audited in their
 *      transaction, listed by the readiness report at spreadsheet cost, and
 *      refused once the perpetual cut-over is applied; a back-dated stock
 *      entry is refused once the cut-over applies on the business date;
 *   4. aging includes factory suppliers, ages USD base amounts and counts days
 *      from the company's business date.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { getCompanyBusinessDate } from "../server/lib/dateUtils";
import { perpetualReadinessReport } from "../server/services/accounting/perpetualInventory/readiness";
import { noMixCataloguePricedBales } from "../server/services/accounting/perpetualInventory/factoryCutoverBlockers";
import { stockEntryCutoverTx } from "../server/services/factory/stockImportPolicy";
import { ensureFactoryCostBasisSchema } from "../server/services/factory/factoryCostBasisSchema";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import { serveAccountListForCompany } from "../server/routes/accounts/all";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { normalizedLineFields } from "./helpers/normalizedVoucherLine";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "w18c";
const TIMEZONE = "Pacific/Kiritimati";

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
const now = new Date();
const daysAgo = (days: number) =>
  iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days)));

let ctx: TestContext;
let agent: request.SuperAgentTest;
let companyB: number;
const ids: Record<string, number> = {};
let sequence = 0;

const asMaintenance = <T>(work: () => Promise<T>) => runWithDatabaseMaintenanceScope("wave18c-test", work);

async function insertId(text: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(text, params);
  return rows[0].id;
}

interface Line {
  ledger?: number;
  bank?: number;
  employee?: number;
  factorySupplier?: number;
  debit?: string;
  credit?: string;
  baseDebit?: string;
  baseCredit?: string;
}

async function voucher(date: string, lines: Line[], opts: { legacy?: boolean; companyId?: number } = {}) {
  sequence += 1;
  return withFixtureTransaction(
    async (client) => {
      const created = await client.query<{ id: number }>(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, optional)
         VALUES ($1, $2, 'Journal', $3, 0, 'USD', false) RETURNING id`,
        [opts.companyId ?? ctx.companyId, `${PREFIX.toUpperCase()}-${sequence}`, date]
      );
      for (const line of lines) {
        // A line with a base amount is a EUR line normalized at the rate that
        // gives that base (its debit/credit columns hold the native amount, as
        // a legacy factory line does).
        const base = line.baseDebit ?? line.baseCredit;
        const native = line.baseDebit
          ? normalizedLineFields(line.baseDebit, line.debit ?? "0", "debit")
          : line.baseCredit
            ? normalizedLineFields(line.baseCredit, line.credit ?? "0", "credit")
            : null;
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, bank_account_id, employee_id,
                                        factory_supplier_id, debit_amount, credit_amount,
                                        transaction_currency, transaction_debit_amount, transaction_credit_amount,
                                        base_debit_amount, base_credit_amount, historical_exchange_rate,
                                        rate_convention)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            created.rows[0].id,
            line.ledger ?? null,
            line.bank ?? null,
            line.employee ?? null,
            line.factorySupplier ?? null,
            line.debit ?? "0",
            line.credit ?? "0",
            base && native ? "EUR" : null,
            native?.transactionDebit ?? null,
            native?.transactionCredit ?? null,
            native?.baseDebit ?? null,
            native?.baseCredit ?? null,
            native?.rate ?? null,
            native?.convention ?? null,
          ]
        );
      }
      return created.rows[0].id;
    },
    { legacyUnbalanced: opts.legacy }
  );
}

async function setCutover(effectiveFrom: string | null) {
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [ctx.companyId]);
  if (effectiveFrom) {
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by)
       VALUES ($1, $2, '{}'::jsonb, 'test')`,
      [ctx.companyId, effectiveFrom]
    );
  }
}

async function accountList(query: Record<string, string> = {}) {
  let body: { accounts: Array<Record<string, unknown>> } = { accounts: [] };
  const res = {
    status: () => res,
    json: (value: typeof body) => {
      body = value;
      return res;
    },
  };
  await serveAccountListForCompany({ query, headers: {} } as never, res as never, ctx.companyId);
  return body.accounts;
}

function binaryParser(res: NodeJS.ReadableStream, callback: (error: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
}

/** The statement worksheet's rows as [particulars, balance cell] pairs below the header. */
async function excelRows(query: string) {
  const response = await agent
    .get(`/api/accounts/statement/export-excel?${query}`)
    .buffer(true)
    .parse(binaryParser as never);
  expect(response.status).toBe(200);
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.body as Buffer);
  const sheet = workbook.getWorksheet("Statement")!;
  const rows: Array<{ particulars: string; balance: number | null; numFmt: string }> = [];
  let afterHeader = false;
  sheet.eachRow((row) => {
    if (row.getCell(1).value === "Date") {
      afterHeader = true;
      return;
    }
    if (!afterHeader) return;
    const balance = row.getCell(6).value;
    rows.push({
      particulars: String(row.getCell(3).value ?? ""),
      balance: typeof balance === "number" ? balance : null,
      numFmt: String(row.getCell(6).numFmt ?? ""),
    });
  });
  return rows.filter(
    (row) => row.particulars !== "TOTAL" && row.particulars !== "Closing Balance" && row.balance !== null
  );
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await ensureFactoryCostBasisSchema(pool);
  // The factory import routes need a factory company.
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
  const cash = ctx.cashAccountId;

  companyB = await insertId(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1, $2, 'erp', 'USD') RETURNING id`,
    [`${PREFIX.toUpperCase()}B`, `${PREFIX} company B`]
  );

  ids.LIAB = await insertId(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 'Liability', 100, NULL) RETURNING id`,
    [ctx.companyId, `${PREFIX}-LIAB-${ctx.companyId}`, `${PREFIX} liability`]
  );
  ids.BANKLEDGER = await insertId(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 'Bank', 0, 'Dr') RETURNING id`,
    [ctx.companyId, `${PREFIX}-BL-${ctx.companyId}`, `${PREFIX} bank ledger`]
  );
  ids.BANK = await insertId(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 'Bank', '001', 70, 'Dr') RETURNING id`,
    [ctx.companyId, `${PREFIX}-BANK-${ctx.companyId}`, `${PREFIX} bank`]
  );
  ids.BANK_B = await insertId(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 'Bank', '002', 0, 'Dr') RETURNING id`,
    [companyB, `${PREFIX}-BANKB-${ctx.companyId}`, `${PREFIX} bank B`]
  );
  ids.B_CASH = await insertId(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 'Cash', 0, 'Dr') RETURNING id`,
    [companyB, `${PREFIX}-BCASH-${ctx.companyId}`, `${PREFIX} B cash`]
  );
  ids.EMP = await insertId(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date, opening_balance, opening_balance_side)
     VALUES ($1, $2, 'W18', 'Employee', '2026-01-01', 40, NULL) RETURNING id`,
    [ctx.companyId, `${PREFIX}-EMP-${ctx.companyId}`]
  );

  // A legacy line naming the bank ledger and the bank: the ledger's only.
  await voucher(
    daysAgo(10),
    [
      { ledger: ids.BANKLEDGER, bank: ids.BANK, debit: "25.00" },
      { ledger: cash, credit: "25.00" },
    ],
    { legacy: true }
  );
  await voucher(daysAgo(10), [
    { bank: ids.BANK, debit: "5.00" },
    { ledger: cash, credit: "5.00" },
  ]);
  await voucher(daysAgo(1), [
    { bank: ids.BANK, debit: "7.00" },
    { ledger: cash, credit: "7.00" },
  ]);
  // Company B's voucher naming A's bank (legacy): not A's line.
  await voucher(
    daysAgo(2),
    [
      { bank: ids.BANK, debit: "1000.00" },
      { ledger: ids.B_CASH, credit: "1000.00" },
    ],
    { legacy: true, companyId: companyB }
  );
  // Employee: an advance of 10, then 4 owed to them.
  await voucher(daysAgo(10), [
    { employee: ids.EMP, debit: "10.00" },
    { ledger: cash, credit: "10.00" },
  ]);
  await voucher(daysAgo(1), [
    { ledger: cash, debit: "4.00" },
    { employee: ids.EMP, credit: "4.00" },
  ]);

  // Aging: a factory supplier credited 110 in the line currency, 100 USD base.
  ids.EXP = await insertId(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 'Expense', 0, 'Dr') RETURNING id`,
    [ctx.companyId, `${PREFIX}-EXP-${ctx.companyId}`, `${PREFIX} expense`]
  );
  ids.FS = await insertId(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
    ctx.companyId,
    `${PREFIX} factory supplier`,
  ]);
  await voucher(daysAgo(40), [
    { ledger: ids.EXP, debit: "110.00", baseDebit: "100.00" },
    { factorySupplier: ids.FS, credit: "110.00", baseCredit: "100.00" },
  ]);
  await pool.query(
    `INSERT INTO company_settings (company_id, timezone) VALUES ($1, $2)
     ON CONFLICT (company_id) DO UPDATE SET timezone = EXCLUDED.timezone`,
    [ctx.companyId, TIMEZONE]
  );
}, 120_000);

afterAll(async () => {
  const id = ctx.companyId;
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [id]);
  for (const table of ["factory_bales", "factory_bale_import_batches", "factory_bale_sequences", "factory_raw_stock"]) {
    await pool.query(`DELETE FROM ${table} WHERE company_id = $1`, [id]);
  }
  await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM factory_bale_products WHERE company_id = $1`, [id]);
  await withFixtureTransaction(async (client) => {
    await client.query(
      `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
      [companyB]
    );
    await client.query(`DELETE FROM vouchers WHERE company_id = $1`, [companyB]);
    // Lines on the company's factory suppliers go before the suppliers.
    await client.query(
      `DELETE FROM voucher_entries WHERE factory_supplier_id IN (SELECT id FROM factory_suppliers WHERE company_id = $1)`,
      [id]
    );
  });
  await pool.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [id]);
  for (const table of ["bank_accounts", "ledger_accounts"]) {
    await pool.query(`DELETE FROM ${table} WHERE company_id = $1`, [companyB]);
  }
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 120_000);

describe("1: /api/accounts/all on the balance engine", () => {
  it("counts each line once, by the voucher's company, with the engine's opening sides", async () => {
    const accounts = await accountList();
    const byId = (type: string, id: number) => accounts.find((a) => a.type === type && a.accountId === id);
    // A sideless liability opening is Cr (it was Dr).
    expect(byId("ledger", ids.LIAB)).toMatchObject({
      balance: "100.00",
      balanceSide: "Cr",
      openingBalance: 100,
      openingBalanceSide: "Cr",
    });
    // 70 + 5 + 7: the line also naming the bank ledger and company B's line are not the bank's.
    expect(byId("bank", ids.BANK)).toMatchObject({ balance: "82.00", balanceSide: "Dr" });
    expect(byId("ledger", ids.BANKLEDGER)).toMatchObject({ balance: "25.00", balanceSide: "Dr" });
    // Employee, Cr positive: 40 (sideless: Cr) − 10 + 4.
    expect(byId("employee", ids.EMP)).toMatchObject({ balance: "34.00", balanceSide: "Cr", openingBalanceSide: "Cr" });
  });

  it("carries the engine's opening into a period", async () => {
    const accounts = await accountList({ startDate: daysAgo(5) });
    const byId = (type: string, id: number) => accounts.find((a) => a.type === type && a.accountId === id);
    expect(byId("bank", ids.BANK)).toMatchObject({ openingBalance: 75, openingBalanceSide: "Dr", balance: "82.00" });
    expect(byId("employee", ids.EMP)).toMatchObject({ openingBalance: 30, openingBalanceSide: "Cr" });
  });
});

describe("2: statement exports open at the engine's period opening", () => {
  it("bank Excel carries the opening forward and lists only the bank's lines", async () => {
    const full = await excelRows(`accountType=bank&accountId=${ids.BANK}`);
    expect(full.map((row) => row.particulars)).toEqual(["Opening Balance", "Journal", "Journal"]);
    expect(full.map((row) => row.balance)).toEqual([70, 75, 82]);

    const period = await excelRows(`accountType=bank&accountId=${ids.BANK}&startDate=${daysAgo(5)}`);
    expect(period[0]).toMatchObject({ particulars: "Balance Brought Forward", balance: 75 });
    expect(period.at(-1)?.balance).toBe(82);
  });

  it("employee Excel opens at the engine's opening with its side (Cr)", async () => {
    const period = await excelRows(`accountType=employee&accountId=${ids.EMP}&startDate=${daysAgo(5)}`);
    expect(period[0]).toMatchObject({ particulars: "Balance Brought Forward", balance: 30 });
    expect(period[0].numFmt).toContain('"Cr"');
    expect(period.at(-1)).toMatchObject({ balance: 34 });
    expect(period.at(-1)?.numFmt).toContain('"Cr"');
  });

  it("the PDF refuses another company's account", async () => {
    expect((await agent.get(`/api/accounts/bank/${ids.BANK_B}/statement-pdf`)).status).toBe(404);
    const own = await agent
      .get(`/api/accounts/bank/${ids.BANK}/statement-pdf`)
      .buffer(true)
      .parse(binaryParser as never);
    expect(own.status).toBe(200);
  }, 30_000);
});

describe("3: spreadsheet stock imports and the cut-over", () => {
  it("is Admin/Owner only", async () => {
    const manager = request.agent(ctx.app);
    await manager.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
    await pool.query(`UPDATE user_company_roles SET role = 'Manager' WHERE user_id = $1 AND company_id = $2`, [
      ctx.userId,
      ctx.companyId,
    ]);
    try {
      await manager.post("/api/auth/set-company").send({ companyId: ctx.companyId });
      const refused = await manager.post("/api/factory/import/bales").send({ bales: [{ baleCode: "X", weightKg: 1 }] });
      expect(refused.status).toBe(403);
      expect(refused.body.message).toBe("Forbidden");
      expect((await manager.post("/api/factory/import/raw-stock").send({ items: [{}] })).status).toBe(403);
    } finally {
      await pool.query(`UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2`, [
        ctx.userId,
        ctx.companyId,
      ]);
    }
  });

  it("before the cut-over: imports, audits and lists them at spreadsheet cost", async () => {
    await setCutover(null);
    const bales = await agent.post("/api/factory/import/bales").send({
      fileName: "w18c.xlsx",
      bales: [{ baleCode: "W18C-B", articleCode: "W18C-ART", weightKg: "50", costPerKg: "2", status: "IN_STOCK" }],
    });
    expect(bales.status).toBe(200);
    expect(bales.body).toMatchObject({ imported: 1, errors: [] });
    const batchAudit = await pool.query(
      `SELECT 1 FROM audit_log WHERE company_id = $1 AND table_name = 'factory_bale_import_batches'
          AND action = 'import' AND record_id = $2`,
      [ctx.companyId, bales.body.batchId]
    );
    expect(batchAudit.rows).toHaveLength(1);

    const raw = await agent.post("/api/factory/import/raw-stock").send({
      items: [{ containerNumber: "W18C-CONT", receivedKg: "100", usedKg: "40", costPerKg: "1.5" }],
    });
    expect(raw.status).toBe(200);
    expect(raw.body).toMatchObject({ imported: 1, errors: [] });

    const report = await asMaintenance(() => perpetualReadinessReport(ctx.companyId));
    expect(report.importedAtSpreadsheetCost).toMatchObject({ bales: 1, rawStock: 1, value: "190.00" });
    expect(report.importedAtSpreadsheetCost.rows.map((row) => [row.source, row.value])).toEqual([
      ["factory_bales", "100.00"],
      ["factory_raw_stock", "90.00"],
    ]);
    // Owner decision (wave 18): an imported bale has no mix, so it still blocks
    // the cut-over like any no-mix bale until it is sold, written off or
    // re-entered from a costed mix; readiness also lists it at spreadsheet cost.
    expect((await asMaintenance(() => noMixCataloguePricedBales(db, ctx.companyId))).count).toBe(1);
  }, 60_000);

  it("after the cut-over: refuses every import and writes nothing", async () => {
    await setCutover("2026-01-01");
    const before = await pool.query(`SELECT COUNT(*)::int AS n FROM factory_bales WHERE company_id = $1`, [
      ctx.companyId,
    ]);
    const bales = await agent
      .post("/api/factory/import/bales")
      .send({ bales: [{ baleCode: "W18C-C", weightKg: "10", costPerKg: "1" }] });
    expect(bales.status).toBe(409);
    expect(bales.body).toMatchObject({ code: "FACTORY_STOCK_IMPORT_AFTER_CUTOVER", effectiveFrom: "2026-01-01" });
    expect(bales.body.message).toBe(
      "Perpetual inventory applies from 2026-01-01: stock cannot be imported from a spreadsheet. Enter it through costed receipts and mixes."
    );
    const raw = await agent
      .post("/api/factory/import/raw-stock")
      .send({ items: [{ containerNumber: "W18C-CONT2", receivedKg: "1", costPerKg: "1" }] });
    expect(raw.status).toBe(409);

    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Bales");
    sheet.addRow(["Reference Number", "Product Name", "Weight (kg)", "Cost per kg"]);
    sheet.addRow(["W18C-REF-1", "W18C product", 20, 1]);
    const file = Buffer.from(await workbook.xlsx.writeBuffer());
    const reimport = await agent.post("/api/factory/bales/reimport").attach("file", file, "w18c.xlsx");
    expect(reimport.status).toBe(409);
    expect(reimport.body.code).toBe("FACTORY_STOCK_IMPORT_AFTER_CUTOVER");

    const after = await pool.query(`SELECT COUNT(*)::int AS n FROM factory_bales WHERE company_id = $1`, [
      ctx.companyId,
    ]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const containers = await pool.query(
      `SELECT 1 FROM factory_containers WHERE company_id = $1 AND container_number = 'W18C-CONT2'`,
      [ctx.companyId]
    );
    expect(containers.rows).toEqual([]);

    // Before the cut-over the reimport is accepted, batched and audited.
    await setCutover(null);
    const accepted = await agent.post("/api/factory/bales/reimport").attach("file", file, "w18c.xlsx");
    expect(accepted.status).toBe(200);
    expect(accepted.body.imported).toBe(1);
    const reimported = await pool.query(
      `SELECT import_batch_id FROM factory_bales WHERE company_id = $1 AND reference_number = 'W18C-REF-1'`,
      [ctx.companyId]
    );
    expect(reimported.rows[0].import_batch_id).toBe(accepted.body.batchId);
  }, 60_000);

  it("refuses a back-dated stock entry once the cut-over applies on the business date", async () => {
    await setCutover("2026-01-01");
    await expect(
      asMaintenance(() => db.transaction((tx) => stockEntryCutoverTx(tx, ctx.companyId, "2025-12-31")))
    ).rejects.toMatchObject({ statusCode: 409, code: "FACTORY_STOCK_ENTRY_BEFORE_CUTOVER" });
    const today = getCompanyBusinessDate(TIMEZONE);
    const state = await asMaintenance(() => db.transaction((tx) => stockEntryCutoverTx(tx, ctx.companyId, today)));
    expect(state).toEqual({ perpetual: true, businessDate: today });
    // A cut-over still ahead: an earlier entry is not perpetual and not refused.
    await setCutover("2099-01-01");
    expect(
      await asMaintenance(() => db.transaction((tx) => stockEntryCutoverTx(tx, ctx.companyId, "2025-12-31")))
    ).toMatchObject({ perpetual: false });
    await setCutover(null);
  });
});

describe("4: aging", () => {
  it("ages factory suppliers in USD base amounts from the company's business date", async () => {
    const response = await agent.get("/api/reports/aging?kind=factorySupplier");
    expect(response.status).toBe(200);
    expect(response.body.referenceDate).toBe(getCompanyBusinessDate(TIMEZONE));
    expect(response.body.amountBasis).toBe("historicalBase");
    const row = response.body.parties.find((party: { id: number }) => party.id === ids.FS);
    expect(row.balance).toBe("100.00");
    expect(row.buckets).toMatchObject({ days31to60: "100.00", current: "0.00", opening: "0.00" });
    expect((await agent.get("/api/reports/aging?kind=other")).status).toBe(400);
  });
});
