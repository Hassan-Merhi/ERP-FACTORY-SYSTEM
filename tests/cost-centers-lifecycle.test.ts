/**
 * Cost centers (Phases 1–8) against real PostgreSQL with all six reviewed
 * migrations applied: allocation, automation, reporting reconciliation,
 * historical batches, source lifecycle and tenant isolation. Every scenario
 * also proves the accounting facts (voucher lines, voucher count) are
 * untouched — cost centers classify recognized expense, they never post it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "costctrlife";
const DATE = "2026-09-11";
const MIGRATIONS = [
  "20261021_001_cost_centers_phase1",
  "20261021_002_cost_centers_phase2_integrity",
  "20261021_003_cost_centers_phase5_automation",
  "20261021_004_cost_centers_phase6_budgets",
  "20261021_005_cost_centers_phase7_history",
  "20261021_006_cost_centers_phase8_hardening",
  "20261021_007_cost_centers_historical_batch_size",
];
const BASE = "/api/cost-centers";
const REPORT_WINDOW = "fromDate=2026-09-01&toDate=2026-09-30";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let expenseAccountId: number;
let adminId: number;
let hrId: number;
let opsId: number;

type Line = { id: number; ledger_account_id: number; debit_amount: string; credit_amount: string };

async function lines(voucherId: number): Promise<Line[]> {
  const result = await pool.query<Line>(
    `SELECT id, ledger_account_id, debit_amount::text, credit_amount::text
       FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
    [voucherId]
  );
  return result.rows;
}

async function voucherCount(): Promise<number> {
  const result = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1`, [
    ctx.companyId,
  ]);
  return result.rows[0].n;
}

async function postExpense(amount: string, notes: string): Promise<{ voucherId: number; expenseEntryId: number }> {
  const created = await agent.post("/api/vouchers/journal").send({
    voucherDate: DATE,
    notes,
    currency: "USD",
    entries: [
      { type: "DR", accountType: "ledger", accountId: expenseAccountId, amount, narration: notes },
      { type: "CR", accountType: "ledger", accountId: ctx.cashAccountId, amount, narration: notes },
    ],
  });
  expect(created.status, created.text).toBe(200);
  const body = created.body as { voucher?: { id?: number }; id?: number; voucherId?: number };
  const voucherId = Number(body.voucher?.id ?? body.id ?? body.voucherId);
  const expense = (await lines(voucherId)).find((line) => line.ledger_account_id === expenseAccountId);
  if (!expense) throw new Error("Expense line missing");
  return { voucherId, expenseEntryId: expense.id };
}

async function splitsOf(entryId: number) {
  const result = await pool.query<{ cost_center_id: number; amount_base: string; allocation_origin: string }>(
    `SELECT cost_center_id, amount_base::text, allocation_origin FROM cost_center_allocations
      WHERE voucher_entry_id = $1 ORDER BY cost_center_id`,
    [entryId]
  );
  return result.rows;
}

async function summary(extra = "") {
  const response = await agent.get(`${BASE}/reports/summary?${REPORT_WINDOW}${extra}`);
  expect(response.status, response.text).toBe(200);
  return response.body as {
    centers: Array<{ costCenterId: number; expense: string; budget: string; variance: string }>;
    totals: { expense: string; unallocated: string; recognizedExpense: string; budget: string };
  };
}

function parseCsv(text: string): string[][] {
  return text
    .replace(/^\uFEFF/, "")
    .split("\r\n")
    .filter(Boolean)
    .map((line) =>
      line
        .slice(1, -1)
        .split('","')
        .map((cell) => cell.replace(/""/g, '"'))
    );
}

async function binary(url: string) {
  return agent
    .get(url)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
}

function center(report: Awaited<ReturnType<typeof summary>>, id: number) {
  return report.centers.find((row) => row.costCenterId === id)!;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  for (const tag of MIGRATIONS) {
    await pool.query(readFileSync(path.join(__dirname, `../migrations/${tag}.sql`), "utf8"));
  }
  agent = request.agent(ctx.app) as request.SuperAgentTest;
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (selected.status !== 200) throw new Error(`set-company failed: ${selected.status} ${selected.text}`);
  const account = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, 'Office expense', 'Expense', '0', 'Dr') RETURNING id`,
    [ctx.companyId, `${PREFIX}_EXP`]
  );
  expenseAccountId = account.rows[0].id;
}, 120_000);

afterAll(async () => {
  if (ctx) {
    const cid = ctx.companyId;
    for (const table of [
      "cost_center_historical_batch_items",
      "cost_center_historical_batches",
      "cost_center_monthly_budgets",
      "cost_center_auto_failures",
      "cost_center_source_overrides",
      "cost_center_allocations",
      "cost_center_auto_rules",
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE company_id = $1`, [cid]).catch(() => undefined);
    }
    await pool.query(`UPDATE cost_centers SET parent_id = NULL WHERE company_id = $1`, [cid]).catch(() => undefined);
    await pool.query(`DELETE FROM cost_centers WHERE company_id = $1`, [cid]).catch(() => undefined);
    await cleanupTestData(PREFIX);
  }
  closeTestServer();
}, 120_000);

describe("Cost centers lifecycle (migrations applied)", () => {
  it("manages a per-company hierarchy and rejects cycles", async () => {
    const admin = await agent.post(BASE).send({ code: "ADMIN", name: "Administration" });
    expect(admin.status, admin.text).toBe(201);
    adminId = admin.body.costCenter.id;
    const hr = await agent.post(BASE).send({ code: "ADMIN-HR", name: "Human resources", parentId: adminId });
    expect(hr.status, hr.text).toBe(201);
    hrId = hr.body.costCenter.id;
    const ops = await agent.post(BASE).send({ code: "OPS", name: "Operations" });
    expect(ops.status, ops.text).toBe(201);
    opsId = ops.body.costCenter.id;

    expect((await agent.post(BASE).send({ code: "ADMIN", name: "Duplicate" })).status).toBe(409);
    expect((await agent.patch(`${BASE}/${adminId}`).send({ parentId: hrId })).status).toBe(409);
    expect((await agent.post(`${BASE}/${adminId}/archive`).send({})).status).toBe(409);
  });

  it("splits a posted expense line without touching the voucher", async () => {
    const before = await voucherCount();
    const { voucherId, expenseEntryId } = await postExpense("300.00", "Office rent");
    const original = await lines(voucherId);

    const eligible = await agent.get(`${BASE}/voucher/${voucherId}/entries`);
    expect(eligible.status, eligible.text).toBe(200);
    expect(eligible.body.entries.map((e: { entryId: number }) => e.entryId)).toEqual([expenseEntryId]);

    const url = `${BASE}/allocations/voucher_entry/${expenseEntryId}`;
    const over = await agent.put(url).send({
      reason: "Rent split",
      splits: [
        { costCenterId: hrId, amountNative: "250", amountBase: "250", costTreatment: "EXPENSE" },
        { costCenterId: opsId, amountNative: "100", amountBase: "100", costTreatment: "EXPENSE" },
      ],
    });
    expect(over.status).toBe(409);
    const skewed = await agent.put(url).send({
      reason: "Rent split",
      splits: [{ costCenterId: hrId, amountNative: "100", amountBase: "150", costTreatment: "EXPENSE" }],
    });
    expect(skewed.status).toBe(409);
    const wrongTreatment = await agent.put(url).send({
      reason: "Rent split",
      splits: [{ costCenterId: hrId, amountNative: "100", amountBase: "100", costTreatment: "INVENTORY_COST" }],
    });
    expect(wrongTreatment.status).toBe(403);

    const saved = await agent.put(url).send({
      reason: "Rent split",
      splits: [
        { costCenterId: hrId, amountNative: "200", amountBase: "200", costTreatment: "EXPENSE" },
        { costCenterId: opsId, amountNative: "100", amountBase: "100", costTreatment: "EXPENSE" },
      ],
    });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.unallocatedBase).toBe("0.000000");

    // A payment/cash line is never allocatable.
    const cashLine = original.find((line) => line.ledger_account_id === ctx.cashAccountId)!;
    expect((await agent.get(`${BASE}/allocations/voucher_entry/${cashLine.id}`)).status).toBe(409);

    expect(await lines(voucherId)).toEqual(original);
    expect(await voucherCount()).toBe(before + 1);
  });

  it("reconciles allocated plus unallocated expense to the recognized expense", async () => {
    let report = await summary();
    expect(Number(center(report, hrId).expense)).toBe(200);
    expect(Number(center(report, opsId).expense)).toBe(100);
    expect(Number(report.totals.unallocated)).toBe(0);
    expect(Number(report.totals.recognizedExpense)).toBe(300);

    await postExpense("50.00", "Stationery");
    report = await summary();
    expect(Number(report.totals.expense)).toBe(300);
    expect(Number(report.totals.unallocated)).toBe(50);
    expect(Number(report.totals.recognizedExpense)).toBe(350);

    // The center page uses the same eligibility and sign as the report.
    const balance = await agent.get(`${BASE}/${hrId}/balance`);
    expect(balance.status, balance.text).toBe(200);
    expect(Number(balance.body.byTreatment[0].amountBase)).toBe(200);
    const activity = await agent.get(`${BASE}/${hrId}/activity`);
    expect(activity.status, activity.text).toBe(200);
    expect(activity.body.activity).toHaveLength(1);

    const csv = await agent.get(`${BASE}/reports/export?${REPORT_WINDOW}&format=csv&view=summary`);
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain("UNALLOCATED");
  });

  it("exports every report tab in CSV, XLSX and PDF for company and consolidated scope", async () => {
    // Fixture at this point (historical USD, September 2026): HR 200 + OPS 100
    // allocated from "Office expense", 50 unallocated, no budgets yet.
    const headers: Record<string, string[]> = {
      summary: ["companyName", "code", "name", "expense", "budget", "variance", "inventoryCost", "entries"],
      activity: [
        "sourceDate",
        "companyId",
        "costCenterCode",
        "accountName",
        "sourceModule",
        "voucherNumber",
        "treatment",
        "allocationOrigin",
        "currency",
        "amountNative",
        "amountUsd",
      ],
      departments: ["companyName", "code", "name", "expense", "budget", "variance", "inventoryCost", "members"],
      accounts: ["companyId", "accountName", "expense", "inventoryCost", "entries"],
      months: ["month", "expense", "unallocated", "budget", "variance", "inventoryCost"],
    };
    const rowsOf = (table: string[][], key: string, value: string) => {
      const index = table[0].indexOf(key);
      return table.slice(1).filter((row) => row[index] === value);
    };
    const field = (table: string[][], row: string[], key: string) => row[table[0].indexOf(key)];
    for (const path of ["/reports/export", "/reports/consolidated/export"]) {
      for (const view of Object.keys(headers)) {
        const csv = await agent.get(`${BASE}${path}?${REPORT_WINDOW}&format=csv&view=${view}`);
        expect(csv.status, `${path} ${view}: ${csv.text}`).toBe(200);
        expect(csv.headers["content-type"]).toContain("text/csv");
        expect(csv.headers["content-disposition"]).toContain(`cost-centers-${view}-2026-09-01-2026-09-30.csv`);
        const table = parseCsv(csv.text);
        expect(table[0]).toEqual(headers[view]);
        if (view === "summary") {
          expect(Number(field(table, rowsOf(table, "code", "ADMIN-HR")[0], "expense"))).toBe(200);
          expect(Number(field(table, rowsOf(table, "code", "OPS")[0], "expense"))).toBe(100);
          expect(Number(field(table, rowsOf(table, "code", "UNALLOCATED")[0], "expense"))).toBe(50);
        }
        if (view === "activity") {
          const amounts = table.slice(1).map((row) => Number(field(table, row, "amountUsd")));
          expect(amounts.sort((a, b) => a - b)).toEqual([100, 200]);
          expect(rowsOf(table, "currency", "USD")).toHaveLength(2);
          expect(rowsOf(table, "sourceDate", DATE)).toHaveLength(2);
        }
        if (view === "departments") {
          const admin = rowsOf(table, "code", "ADMIN")[0];
          expect(Number(field(table, admin, "expense"))).toBe(200);
          expect(Number(field(table, admin, "members"))).toBe(2);
          expect(Number(field(table, rowsOf(table, "code", "OPS")[0], "expense"))).toBe(100);
        }
        if (view === "accounts") {
          const office = rowsOf(table, "accountName", "Office expense")[0];
          expect(Number(field(table, office, "expense"))).toBe(300);
          expect(Number(field(table, office, "companyId"))).toBe(ctx.companyId);
        }
        if (view === "months") {
          const month = rowsOf(table, "month", "2026-09")[0];
          expect(Number(field(table, month, "expense"))).toBe(300);
          expect(Number(field(table, month, "unallocated"))).toBe(50);
          expect(Number(field(table, month, "variance"))).toBe(350);
        }

        const xlsx = await binary(`${BASE}${path}?${REPORT_WINDOW}&format=xlsx&view=${view}`);
        expect(xlsx.status, `${path} ${view} xlsx`).toBe(200);
        expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
        expect(xlsx.headers["content-disposition"]).toContain(`cost-centers-${view}-2026-09-01-2026-09-30.xlsx`);
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(xlsx.body);
        const sheet = book.getWorksheet("Cost Centers")!;
        expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(headers[view]);
        expect(sheet.rowCount).toBe(table.length);

        const pdf = await binary(`${BASE}${path}?${REPORT_WINDOW}&format=pdf&view=${view}`);
        expect(pdf.status, `${path} ${view} pdf`).toBe(200);
        expect(pdf.headers["content-type"]).toContain("application/pdf");
        expect(pdf.headers["content-disposition"]).toContain(`cost-centers-${view}-2026-09-01-2026-09-30.pdf`);
        expect(pdf.body.subarray(0, 5).toString()).toBe("%PDF-");
      }
      // Date filters apply to every export: nothing was allocated in October.
      const october = await agent.get(`${BASE}${path}?fromDate=2026-10-01&toDate=2026-10-31&format=csv&view=activity`);
      expect(october.status, october.text).toBe(200);
      expect(parseCsv(october.text)).toHaveLength(1);
      for (const query of ["format=csv&view=unsupported", "format=csv&view=centers", "format=docx&view=summary"]) {
        const invalid = await agent.get(`${BASE}${path}?${REPORT_WINDOW}&${query}`);
        expect(invalid.status, `${path} ${query}`).toBe(400);
      }
    }
  });

  it("budgets are analytical and drive variance only", async () => {
    const before = await voucherCount();
    const saved = await agent
      .put(`${BASE}/budgets/${hrId}/2026-09`)
      .send({ amountUsd: "180", reason: "September plan" });
    expect(saved.status, saved.text).toBe(200);
    const report = await summary();
    expect(Number(center(report, hrId).budget)).toBe(180);
    expect(Number(center(report, hrId).variance)).toBe(20);
    expect(await voucherCount()).toBe(before);
  });

  it("never blocks a later accounting change to an allocated line", async () => {
    const { voucherId, expenseEntryId } = await postExpense("80.00", "Courier");
    const saved = await agent.put(`${BASE}/allocations/voucher_entry/${expenseEntryId}`).send({
      reason: "Courier",
      splits: [{ costCenterId: opsId, amountNative: "80", amountBase: "80", costTreatment: "EXPENSE" }],
    });
    expect(saved.status, saved.text).toBe(200);

    // A rate-metadata-only correction keeps the split.
    await pool.query(`UPDATE voucher_entries SET rate_convention = 'BASE_PER_TRANSACTION' WHERE id = $1`, [
      expenseEntryId,
    ]);
    expect(await splitsOf(expenseEntryId)).toHaveLength(1);

    // An amount correction (freight sync, FX repair) succeeds; the stale split
    // is cleared and listed for review instead of failing the posting.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const line of await lines(voucherId)) {
        const column = Number(line.debit_amount) > 0 ? "debit" : "credit";
        await client.query(
          `UPDATE voucher_entries SET ${column}_amount = 90, base_${column}_amount = 90,
             transaction_${column}_amount = 90 WHERE id = $1`,
          [line.id]
        );
      }
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await splitsOf(expenseEntryId)).toHaveLength(0);
    const failures = await agent.get(`${BASE}/automation/failures`);
    expect(failures.status).toBe(200);
    expect(failures.body.failures.some((f: { sourceId: number }) => f.sourceId === expenseEntryId)).toBe(true);

    // Rebuilding a voucher's lines cascades the splits and leaves a notice.
    const rebuilt = await postExpense("40.00", "Rebuilt");
    await agent.put(`${BASE}/allocations/voucher_entry/${rebuilt.expenseEntryId}`).send({
      reason: "Rebuilt",
      splits: [{ costCenterId: opsId, amountNative: "40", amountBase: "40", costTreatment: "EXPENSE" }],
    });
    await pool.query(`DELETE FROM voucher_entries WHERE voucher_id = $1`, [rebuilt.voucherId]);
    const notice = await pool.query(
      `SELECT last_error FROM cost_center_auto_failures WHERE company_id = $1 AND source_id = $2`,
      [ctx.companyId, rebuilt.expenseEntryId]
    );
    expect(notice.rows[0]?.last_error).toContain("manual cost center split");
  });

  it("automatic rules tag new expense lines inside the posting, never post", async () => {
    const rule = await agent.put(`${BASE}/automation/rules`).send({
      sourceKind: "VOUCHER_ENTRY",
      ledgerAccountId: expenseAccountId,
      sourceModule: null,
      splits: [
        { costCenterId: hrId, percent: "60" },
        { costCenterId: opsId, percent: "40" },
      ],
      reason: "Default office split",
    });
    expect(rule.status, rule.text).toBe(200);

    const before = await voucherCount();
    const { voucherId, expenseEntryId } = await postExpense("125.00", "Auto tagged");
    expect(await voucherCount()).toBe(before + 1);
    const lineRows = await lines(voucherId);
    expect(lineRows.map((l) => [l.debit_amount, l.credit_amount]).sort()).toEqual(
      [
        ["0.00", "125.00"],
        ["125.00", "0.00"],
      ].sort()
    );
    const splits = await splitsOf(expenseEntryId);
    expect(splits.map((s) => [s.cost_center_id, Number(s.amount_base), s.allocation_origin])).toEqual([
      [hrId, 75, "AUTO"],
      [opsId, 50, "AUTO"],
    ]);

    // A deliberate manual clear wins over automation permanently.
    const cleared = await agent
      .put(`${BASE}/allocations/voucher_entry/${expenseEntryId}`)
      .send({ reason: "Not departmental", splits: [] });
    expect(cleared.status, cleared.text).toBe(200);
    expect(await splitsOf(expenseEntryId)).toHaveLength(0);

    const off = await agent.put(`${BASE}/automation/rules`).send({
      sourceKind: "VOUCHER_ENTRY",
      ledgerAccountId: expenseAccountId,
      sourceModule: null,
      splits: [],
      reason: "Disable",
    });
    expect(off.status, off.text).toBe(200);
  });

  it("historical batches preview, require confirmation, apply once and detect stale sources", async () => {
    const first = await postExpense("33.33", "History A");
    const second = await postExpense("66.67", "History B");
    const plan = {
      sourceKind: "VOUCHER_ENTRY",
      fromDate: DATE,
      toDate: DATE,
      ledgerAccountId: expenseAccountId,
      limit: 100,
      splits: [
        { costCenterId: hrId, percent: "33.3333" },
        { costCenterId: opsId, percent: "66.6667" },
      ],
      reason: "Backfill September",
    };
    const preview = await agent.post(`${BASE}/historical/preview`).send(plan);
    expect(preview.status, preview.text).toBe(201);
    const candidateIds = preview.body.rows.map((row: { sourceId: number }) => row.sourceId);
    expect(candidateIds).toEqual(expect.arrayContaining([first.expenseEntryId, second.expenseEntryId]));
    expect(await splitsOf(first.expenseEntryId)).toHaveLength(0);

    const unconfirmed = await agent.post(`${BASE}/historical/${preview.body.batchId}/apply`).send({});
    expect(unconfirmed.status).toBe(400);
    const originals = await lines(first.voucherId);
    const applied = await agent
      .post(`${BASE}/historical/${preview.body.batchId}/apply`)
      .send({ confirmation: "APPLY" });
    expect(applied.status, applied.text).toBe(200);
    expect(await lines(first.voucherId)).toEqual(originals);
    const total = (await splitsOf(first.expenseEntryId)).reduce((sum, s) => sum + Number(s.amount_base), 0);
    expect(total).toBeLessThanOrEqual(33.33);
    expect(total).toBeGreaterThan(33.32);
    const again = await agent.post(`${BASE}/historical/${preview.body.batchId}/apply`).send({ confirmation: "APPLY" });
    expect(again.status).toBe(409);

    const third = await postExpense("10.00", "History C");
    const stalePreview = await agent.post(`${BASE}/historical/preview`).send(plan);
    expect(stalePreview.status, stalePreview.text).toBe(201);
    await pool.query(`UPDATE vouchers SET voucher_date = '2026-09-12', effective_date = '2026-09-12' WHERE id = $1`, [
      third.voucherId,
    ]);
    const stale = await agent
      .post(`${BASE}/historical/${stalePreview.body.batchId}/apply`)
      .send({ confirmation: "APPLY" });
    expect(stale.status).toBe(409);
    expect(await splitsOf(third.expenseEntryId)).toHaveLength(0);
  });

  it("historical batches filter several accounts, allow 10,000 entries and apply in bulk", async () => {
    const first = await postExpense("12.00", "History multi A");
    const second = await postExpense("18.00", "History multi B");
    const plan = {
      sourceKind: "VOUCHER_ENTRY",
      fromDate: DATE,
      toDate: DATE,
      // Duplicates collapse; an account with no lines simply matches nothing.
      ledgerAccountIds: [expenseAccountId, expenseAccountId, 2147483000],
      limit: 10000,
      splits: [{ costCenterId: opsId, percent: "100" }],
      reason: "Backfill several accounts",
    };
    const tooLarge = await agent.post(`${BASE}/historical/preview`).send({ ...plan, limit: 10001 });
    expect(tooLarge.status).toBe(400);
    const tooSmall = await agent.post(`${BASE}/historical/preview`).send({ ...plan, limit: 1 });
    expect(tooSmall.status).toBe(413);
    expect(tooSmall.body.message).toContain("Maximum entries");

    const recon = await agent.get(
      `${BASE}/historical/reconciliation?sourceKind=VOUCHER_ENTRY&fromDate=${DATE}&toDate=${DATE}` +
        `&ledgerAccountIds=${expenseAccountId},2147483000`
    );
    expect(recon.status, recon.text).toBe(200);
    expect(recon.body.sourceCount).toBeGreaterThanOrEqual(2);

    const preview = await agent.post(`${BASE}/historical/preview`).send(plan);
    expect(preview.status, preview.text).toBe(201);
    const ids = preview.body.rows.map((row: { sourceId: number }) => row.sourceId);
    expect(ids).toEqual(expect.arrayContaining([first.expenseEntryId, second.expenseEntryId]));
    const originals = await lines(first.voucherId);
    const applied = await agent
      .post(`${BASE}/historical/${preview.body.batchId}/apply`)
      .send({ confirmation: "APPLY" });
    expect(applied.status, applied.text).toBe(200);
    expect(applied.body.sourceCount).toBe(ids.length);
    expect(await lines(first.voucherId)).toEqual(originals);
    expect((await splitsOf(first.expenseEntryId)).map((s) => [s.cost_center_id, Number(s.amount_base)])).toEqual([
      [opsId, 12],
    ]);
    expect((await splitsOf(second.expenseEntryId)).map((s) => [s.cost_center_id, Number(s.amount_base)])).toEqual([
      [opsId, 18],
    ]);
    const items = await pool.query(
      `SELECT count(*)::int AS n FROM cost_center_historical_batch_items WHERE batch_id = $1`,
      [preview.body.batchId]
    );
    expect(items.rows[0].n).toBe(ids.length);
  });

  it("excludes reversed vouchers from allocation and reports", async () => {
    const { voucherId, expenseEntryId } = await postExpense("70.00", "To reverse");
    const tagged = await agent.put(`${BASE}/allocations/voucher_entry/${expenseEntryId}`).send({
      reason: "Before reversal",
      splits: [{ costCenterId: hrId, amountNative: "70", amountBase: "70", costTreatment: "EXPENSE" }],
    });
    expect(tagged.status, tagged.text).toBe(200);
    const before = await summary();
    const reversed = await agent.post(`/api/vouchers/${voucherId}/exact-reversal`).send({
      reversalDate: DATE,
      reversalVoucherNumber: `${PREFIX.toUpperCase()}-REV-${voucherId}`,
      description: "Reverse",
    });
    expect(reversed.status, reversed.text).toBe(201);
    const after = await summary();
    // Both halves of the pair leave the reports: the center loses the tagged
    // 70 and the reversal's credit line is not left behind as negative spend.
    expect(Number(after.totals.recognizedExpense)).toBeCloseTo(Number(before.totals.recognizedExpense) - 70, 6);
    expect(Number(center(after, hrId).expense)).toBeCloseTo(Number(center(before, hrId).expense) - 70, 6);
    expect(Number(after.totals.unallocated)).toBe(Number(before.totals.unallocated));
    await expect(
      pool.query(
        `INSERT INTO cost_center_allocations (company_id, cost_center_id, voucher_entry_id,
           amount_native, currency, amount_base, cost_treatment)
         VALUES ($1, $2, $3, 1, 'USD', 1, 'EXPENSE')`,
        [ctx.companyId, opsId, expenseEntryId]
      )
    ).rejects.toThrow(/cannot be allocated/);
    const blocked = await agent.put(`${BASE}/allocations/voucher_entry/${expenseEntryId}`).send({
      reason: "Late",
      splits: [{ costCenterId: hrId, amountNative: "70", amountBase: "70", costTreatment: "EXPENSE" }],
    });
    expect(blocked.status).toBe(409);
  });

  it("only standalone Factory daybook expenses can be tagged, never their voucher mirrors", async () => {
    const insert = async (referenceTable: string | null, referenceId: number | null) =>
      (
        await pool.query<{ id: number }>(
          `INSERT INTO factory_daybook_entries
             (company_id, tx_date, tx_type, reference_table, reference_id, description, currency_code,
              amount_currency, fx_rate_to_usd, amount_usd)
           VALUES ($1, $2, 'EXPENSE', $3, $4, 'Factory expense', 'USD', 25, 1, 25) RETURNING id`,
          [ctx.companyId, DATE, referenceTable, referenceId]
        )
      ).rows[0].id;
    const standalone = await insert(null, null);
    const mirror = await insert("vouchers", 1);
    const allocate = (daybookId: number) =>
      pool.query(
        `INSERT INTO cost_center_allocations (company_id, cost_center_id, factory_daybook_entry_id,
           amount_native, currency, amount_base, cost_treatment)
         VALUES ($1, $2, $3, 25, 'USD', 25, 'EXPENSE')`,
        [ctx.companyId, opsId, daybookId]
      );
    await expect(allocate(mirror)).rejects.toThrow(/standalone/);
    await allocate(standalone);
    // ERP mode cannot reach Factory daybook sources.
    expect((await agent.get(`${BASE}/allocations/factory_daybook/${standalone}`)).status).toBe(403);
    await pool.query(`DELETE FROM factory_daybook_entries WHERE id = ANY($1::int[])`, [[standalone, mirror]]);
  });

  it("release readiness reports every table, trigger and function installed", async () => {
    const readiness = await agent.get(`${BASE}/release-readiness`);
    expect(readiness.status, readiness.text).toBe(200);
    expect(readiness.body.missingTriggers).toEqual([]);
    expect(readiness.body.missingFunctions).toEqual([]);
    expect(readiness.body.structuralReady).toBe(true);
  });

  it("enforces the per-company ERP Accounts page grant on every Cost Center API", async () => {
    const setRole = (companyId: number, role: string) =>
      pool.query("UPDATE user_company_roles SET role = $3 WHERE user_id = $1 AND company_id = $2", [
        ctx.userId,
        companyId,
        role,
      ]);
    const grantAccounts = (companyId: number) =>
      pool.query("INSERT INTO erp_user_page_access (company_id, user_id, page_key) VALUES ($1, $2, 'accounts')", [
        companyId,
        ctx.userId,
      ]);
    const revokeAll = () => pool.query("DELETE FROM erp_user_page_access WHERE user_id = $1", [ctx.userId]);
    const { voucherId, expenseEntryId } = await postExpense("10.00", "Permission probe");
    const vouchersBefore = await voucherCount();
    const allocationsBefore = await splitsOf(expenseEntryId);
    const second = await pool.query<{ id: number }>(
      "INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1, $2, 'erp', 'USD') RETURNING id",
      [`${PREFIX.toUpperCase()}-B`, `${PREFIX}_SecondCompany`]
    );
    const secondId = second.rows[0].id;
    await pool.query("INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Owner')", [
      ctx.userId,
      secondId,
    ]);
    type Probe = [method: "get" | "post" | "put", url: string, body?: object];
    const probes: Probe[] = [
      ["get", BASE],
      ["post", BASE, { code: "DENIED", name: "Denied" }],
      ["get", `${BASE}/${hrId}`],
      ["get", `${BASE}/${hrId}/activity`],
      ["get", `${BASE}/${hrId}/balance`],
      ["get", `${BASE}/voucher/${voucherId}/entries`],
      ["get", `${BASE}/allocations/voucher_entry/${expenseEntryId}`],
      ["get", `${BASE}/allocations/voucher_entry/${expenseEntryId}/history`],
      [
        "put",
        `${BASE}/allocations/voucher_entry/${expenseEntryId}`,
        {
          reason: "Bypass attempt",
          splits: [{ costCenterId: opsId, amountNative: "10", amountBase: "10", costTreatment: "EXPENSE" }],
        },
      ],
      ["get", `${BASE}/automation/rules`],
      ["get", `${BASE}/reports/summary?${REPORT_WINDOW}`],
      ["get", `${BASE}/reports/activity?${REPORT_WINDOW}`],
      ["get", `${BASE}/reports/consolidated?${REPORT_WINDOW}`],
      ["get", `${BASE}/reports/export?${REPORT_WINDOW}&format=csv&view=accounts`],
      ["get", `${BASE}/reports/consolidated/export?${REPORT_WINDOW}&format=pdf&view=months`],
      ["get", `${BASE}/budgets?month=2026-09`],
      ["get", `${BASE}/historical/reconciliation?${REPORT_WINDOW}`],
      ["get", `${BASE}/historical/batches`],
      ["post", `${BASE}/historical/preview`, {}],
      ["get", `${BASE}/release-readiness`],
      // A trailing slash reaches the same catalog handler.
      ["get", `${BASE}/`],
      // Allocation membership through the Daybook voucher list.
      ["get", `/api/vouchers?page=1&limit=10&startDate=2026-09-01&endDate=2026-09-30&costCenterId=${hrId}`],
    ];
    const send = ([method, url, body]: Probe) => (body ? agent[method](url).send(body) : agent[method](url));
    try {
      await revokeAll();
      for (const role of ["Owner", "Manager"]) {
        await setRole(ctx.companyId, role);
        for (const probe of probes) {
          const response = await send(probe);
          expect(response.status, `${role} ${probe[0]} ${probe[1]}: ${response.text}`).toBe(403);
        }
        // The Daybook itself stays available without the cost-center filter.
        const daybook = await agent.get("/api/vouchers?page=1&limit=10&startDate=2026-09-01&endDate=2026-09-30");
        expect(daybook.status, daybook.text).toBe(200);
      }
      // A grant in ANOTHER company is not a grant in the selected company.
      await grantAccounts(secondId);
      expect((await agent.get(`${BASE}/reports/summary?${REPORT_WINDOW}`)).status).toBe(403);

      // With the grant in the selected company, reads work for Owner and Manager.
      await grantAccounts(ctx.companyId);
      for (const role of ["Manager", "Owner"]) {
        await setRole(ctx.companyId, role);
        for (const url of [
          BASE,
          `${BASE}/reports/summary?${REPORT_WINDOW}`,
          `${BASE}/reports/export?${REPORT_WINDOW}&format=csv&view=departments`,
          `${BASE}/allocations/voucher_entry/${expenseEntryId}`,
          `/api/vouchers?page=1&limit=10&startDate=2026-09-01&endDate=2026-09-30&costCenterId=${hrId}`,
        ]) {
          const response = await agent.get(url);
          expect(response.status, `${role} ${url}: ${response.text}`).toBe(200);
        }
      }

      // Consolidation only includes companies whose Accounts page is granted.
      const consolidated = async () => {
        const response = await agent.get(`${BASE}/reports/consolidated?${REPORT_WINDOW}`);
        expect(response.status, response.text).toBe(200);
        return response.body.companyIds as number[];
      };
      await pool.query("DELETE FROM erp_user_page_access WHERE user_id = $1 AND company_id = $2", [
        ctx.userId,
        secondId,
      ]);
      expect(await consolidated()).toEqual([ctx.companyId]);
      await grantAccounts(secondId);
      expect(await consolidated()).toEqual([ctx.companyId, secondId].sort((a, b) => a - b));
      // Admin in a company keeps full ERP access there without a page row.
      await pool.query("DELETE FROM erp_user_page_access WHERE user_id = $1 AND company_id = $2", [
        ctx.userId,
        secondId,
      ]);
      await setRole(secondId, "Admin");
      expect(await consolidated()).toEqual([ctx.companyId, secondId].sort((a, b) => a - b));

      // Admin needs no page row in the selected company either.
      await revokeAll();
      await setRole(ctx.companyId, "Admin");
      expect((await agent.get(`${BASE}/reports/summary?${REPORT_WINDOW}`)).status).toBe(200);
    } finally {
      await revokeAll();
      await setRole(ctx.companyId, "Admin");
      await pool.query("DELETE FROM user_company_roles WHERE user_id = $1 AND company_id = $2", [ctx.userId, secondId]);
      await pool.query("DELETE FROM companies WHERE id = $1", [secondId]);
    }
    // Denied requests changed nothing.
    expect(await voucherCount()).toBe(vouchersBefore);
    expect(await splitsOf(expenseEntryId)).toEqual(allocationsBefore);
  });

  it("row-level security isolates companies for a non-bypass application role", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cost_center_rls_probe') THEN
          CREATE ROLE cost_center_rls_probe NOLOGIN NOBYPASSRLS;
        END IF; END $$`);
      await client.query("GRANT SELECT, INSERT ON cost_centers, cost_center_allocations TO cost_center_rls_probe");
      await client.query("GRANT USAGE ON SEQUENCE cost_centers_id_seq TO cost_center_rls_probe");
      await client.query("SET LOCAL ROLE cost_center_rls_probe");
      await client.query("SELECT set_config('app.company_scope_maintenance', 'off', true)");
      await client.query("SELECT set_config('app.authorized_company_ids', '', true)");
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(ctx.companyId)]);
      const own = await client.query("SELECT count(*)::int AS n FROM cost_centers");
      expect(own.rows[0].n).toBe(3);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(ctx.companyId + 100000)]);
      const other = await client.query("SELECT count(*)::int AS n FROM cost_centers");
      expect(other.rows[0].n).toBe(0);
      await expect(
        client.query("INSERT INTO cost_centers (company_id, code, name) VALUES ($1, 'X', 'Cross')", [ctx.companyId])
      ).rejects.toThrow(/row-level security/);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});
