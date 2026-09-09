/**
 * Behavioural coverage for the insurance write routes.
 *
 * All five were guard-only. Four maintain `insurance_members` and the ledger
 * account each member owns; the fifth, `POST /api/insurance/generate`, posts a
 * monthly journal into `vouchers` and `voucher_entries` with one leg per member.
 *
 * Two things are worth holding here and neither had a test:
 *
 *   - **Proration.** A member whose start date falls inside the period is
 *     charged for the remaining days only, `amount / daysInMonth * daysRemaining`.
 *     Getting that wrong overcharges or undercharges every month it runs, and
 *     the totals still balance, so nothing downstream notices.
 *   - **The member's ledger account tracks the member.** Creating a member
 *     opens one, renaming the member renames it, and deleting the member
 *     tombstones it. A rename that left the account behind puts the next
 *     month's journal under the old name.
 *
 * DIRECTION: `generate` credits Insurance Expense and debits each member's
 * liability account. This product rule is asserted below rather than merely
 * checking that the journal balances, so future changes cannot silently flip
 * the Insurance account back to a debit.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import ExcelJS from "exceljs";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "inswr";

let ctx: TestContext;
let agent: request.SuperAgentTest;

interface MemberRow {
  id: number;
  name: string;
  active: boolean;
  amount: string;
  ledger_account_id: number | null;
}

async function memberRow(id: number): Promise<MemberRow | null> {
  const result = await pool.query<MemberRow>(
    `SELECT id, name, active, amount, ledger_account_id FROM insurance_members WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

async function createMember(fields: { name: string; amount: string; startDate: string; active?: boolean }) {
  const response = await agent.post("/api/insurance/members").send({
    name: fields.name,
    amount: fields.amount,
    startDate: fields.startDate,
    active: fields.active ?? true,
  });
  if (response.status !== 201) throw new Error(`Seed member failed: ${response.status} ${response.text}`);
  return response.body as MemberRow;
}

/** Deactivate everything so each generate test controls its own population. */
async function deactivateAllMembers() {
  await pool.query(`UPDATE insurance_members SET active = false WHERE company_id = $1`, [ctx.companyId]);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM insurance_members WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/insurance/members", () => {
  it("creates the member with a liability ledger account named after them", async () => {
    const member = await createMember({ name: `${TEST_PREFIX} Alpha`, amount: "100.00", startDate: "2026-01-01" });

    expect(member.ledger_account_id).toBeTruthy();
    const account = await pool.query<{ name: string; account_type: string; company_id: number }>(
      `SELECT name, account_type, company_id FROM ledger_accounts WHERE id = $1`,
      [member.ledger_account_id]
    );
    expect(account.rows[0].name).toBe(`Insurance - ${TEST_PREFIX} Alpha`);
    expect(account.rows[0].account_type).toBe("Liability");
    expect(account.rows[0].company_id).toBe(ctx.companyId);
  });

  it("rejects a member with no name or no amount", async () => {
    expect((await agent.post("/api/insurance/members").send({ amount: "10", startDate: "2026-01-01" })).status).toBe(
      400
    );
    expect((await agent.post("/api/insurance/members").send({ name: "x", startDate: "2026-01-01" })).status).toBe(400);
  });
});

describe("PATCH /api/insurance/members/:id", () => {
  it("renames the member's ledger account when the member is renamed", async () => {
    const member = await createMember({ name: `${TEST_PREFIX} Before`, amount: "50.00", startDate: "2026-01-01" });

    const response = await agent.patch(`/api/insurance/members/${member.id}`).send({ name: `${TEST_PREFIX} After` });
    expect(response.status).toBe(200);

    const account = await pool.query<{ name: string }>(`SELECT name FROM ledger_accounts WHERE id = $1`, [
      member.ledger_account_id,
    ]);
    expect(account.rows[0].name).toBe(`Insurance - ${TEST_PREFIX} After`);
  });

  it("returns 404 for an unknown member and 400 for a bad id", async () => {
    expect((await agent.patch("/api/insurance/members/999999").send({ name: "x" })).status).toBe(404);
    expect((await agent.patch("/api/insurance/members/0").send({ name: "x" })).status).toBe(400);
  });
});

describe("PATCH /api/insurance/members/:id/toggle", () => {
  it("flips active and flips it back", async () => {
    const member = await createMember({ name: `${TEST_PREFIX} Toggle`, amount: "10.00", startDate: "2026-01-01" });
    expect((await memberRow(member.id))?.active).toBe(true);

    await agent.patch(`/api/insurance/members/${member.id}/toggle`);
    expect((await memberRow(member.id))?.active).toBe(false);

    await agent.patch(`/api/insurance/members/${member.id}/toggle`);
    expect((await memberRow(member.id))?.active).toBe(true);
  });
});

describe("DELETE /api/insurance/members/:id", () => {
  it("removes the member and tombstones their ledger account", async () => {
    const member = await createMember({ name: `${TEST_PREFIX} Gone`, amount: "10.00", startDate: "2026-01-01" });

    const response = await agent.delete(`/api/insurance/members/${member.id}`);
    expect(response.status).toBe(200);

    expect(await memberRow(member.id)).toBeNull();
    const account = await pool.query<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM ledger_accounts WHERE id = $1`,
      [member.ledger_account_id]
    );
    expect(account.rows[0].deleted_at).not.toBeNull();
  });
});

describe("POST /api/insurance/generate", () => {
  it("refuses a period with no eligible members rather than posting an empty voucher", async () => {
    await deactivateAllMembers();

    const response = await agent.post("/api/insurance/generate").send({ month: 6, year: 2026 });

    expect(response.status).toBe(400);
  });

  it("rejects a month or year outside the allowed range", async () => {
    expect((await agent.post("/api/insurance/generate").send({ month: 13, year: 2026 })).status).toBe(400);
    expect((await agent.post("/api/insurance/generate").send({ month: 1, year: 1999 })).status).toBe(400);
  });

  it("posts one balanced journal with a leg per member", async () => {
    await deactivateAllMembers();
    await createMember({ name: `${TEST_PREFIX} Full A`, amount: "120.00", startDate: "2025-01-01" });
    await createMember({ name: `${TEST_PREFIX} Full B`, amount: "80.00", startDate: "2025-01-01" });

    const response = await agent.post("/api/insurance/generate").send({ month: 6, year: 2026 });
    expect(response.status).toBe(200);

    const legs = await pool.query<{ debit_amount: string; credit_amount: string }>(
      `SELECT debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1`,
      [response.body.voucherId]
    );
    expect(legs.rowCount).toBe(3);

    const debits = legs.rows.reduce((sum, leg) => sum + Number(leg.debit_amount), 0);
    const credits = legs.rows.reduce((sum, leg) => sum + Number(leg.credit_amount), 0);
    expect(debits).toBeCloseTo(200, 2);
    expect(credits).toBeCloseTo(200, 2);

    const voucher = await pool.query<{ total_amount: string }>(`SELECT total_amount FROM vouchers WHERE id = $1`, [
      response.body.voucherId,
    ]);
    expect(Number(voucher.rows[0].total_amount)).toBeCloseTo(200, 2);
  });

  it("prorates a member who starts inside the period", async () => {
    await deactivateAllMembers();
    // June has 30 days; starting on the 16th leaves 15 days, so half of 300.
    await createMember({ name: `${TEST_PREFIX} Prorated`, amount: "300.00", startDate: "2025-06-16" });

    const response = await agent.post("/api/insurance/generate").send({ month: 6, year: 2025 });
    expect(response.status).toBe(200);

    const legs = await pool.query<{ debit_amount: string; credit_amount: string }>(
      `SELECT debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1`,
      [response.body.voucherId]
    );
    const debits = legs.rows.reduce((sum, leg) => sum + Number(leg.debit_amount), 0);
    const credits = legs.rows.reduce((sum, leg) => sum + Number(leg.credit_amount), 0);

    expect(debits).toBeCloseTo(150, 2);
    expect(credits).toBeCloseTo(150, 2);
  });

  it("excludes a member whose start date is after the period ends", async () => {
    await deactivateAllMembers();
    await createMember({ name: `${TEST_PREFIX} Present`, amount: "60.00", startDate: "2025-01-01" });
    await createMember({ name: `${TEST_PREFIX} Future`, amount: "999.00", startDate: "2027-01-01" });

    const response = await agent.post("/api/insurance/generate").send({ month: 7, year: 2026 });
    expect(response.status).toBe(200);

    const legs = await pool.query<{ debit_amount: string }>(
      `SELECT debit_amount FROM voucher_entries WHERE voucher_id = $1`,
      [response.body.voucherId]
    );
    expect(legs.rowCount).toBe(2);
    const debits = legs.rows.reduce((sum, leg) => sum + Number(leg.debit_amount), 0);
    expect(debits).toBeCloseTo(60, 2);
  });

  it("credits the insurance expense account and debits the member's liability", async () => {
    await deactivateAllMembers();
    const member = await createMember({
      name: `${TEST_PREFIX} Sides`,
      amount: "45.00",
      startDate: "2025-01-01",
    });

    const response = await agent.post("/api/insurance/generate").send({ month: 8, year: 2026 });
    expect(response.status).toBe(200);

    const legs = await pool.query<{ ledger_account_id: number; debit_amount: string; credit_amount: string }>(
      `SELECT ledger_account_id, debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1`,
      [response.body.voucherId]
    );
    const memberLeg = legs.rows.find((leg) => leg.ledger_account_id === member.ledger_account_id);
    const expenseLeg = legs.rows.find((leg) => leg.ledger_account_id !== member.ledger_account_id);

    expect(Number(expenseLeg?.debit_amount)).toBeCloseTo(0, 2);
    expect(Number(expenseLeg?.credit_amount)).toBeCloseTo(45, 2);
    expect(Number(memberLeg?.credit_amount)).toBeCloseTo(0, 2);
    expect(Number(memberLeg?.debit_amount)).toBeCloseTo(45, 2);
  });
});

describe("Insurance multi-sheet Excel import", () => {
  it("downloads a blank workbook with reusable month sheets and supported headers", async () => {
    const response = await agent
      .get("/api/insurance/import/template")
      .buffer(true)
      .parse((_res, callback) => {
        const chunks: Buffer[] = [];
        (_res as any).on("data", (chunk: Buffer) => chunks.push(chunk));
        (_res as any).on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("spreadsheetml.sheet");
    expect(response.headers["content-disposition"]).toContain("Insurance_Import_Template.xlsx");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as Buffer);
    expect(workbook.worksheets.map((worksheet) => worksheet.name)).toEqual([
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ]);

    for (const worksheet of workbook.worksheets) {
      expect(worksheet.getRow(1).values.slice(1)).toEqual([
        "Name",
        "Monthly Amount",
        "Start Date",
        "Insurance Number",
        "Nationality",
        "Position",
        "Date of Birth",
        "Notes",
      ]);
      expect(worksheet.rowCount).toBe(1);
    }
  });

  it("previews month-named sheets and applies monthly amounts", async () => {
    await deactivateAllMembers();
    const workbook = new ExcelJS.Workbook();
    const january = workbook.addWorksheet("January");
    january.addRow(["Name", "Monthly Amount", "Nationality"]);
    january.addRow([`${TEST_PREFIX} Import A`, 25, "Congolese"]);
    january.addRow([`${TEST_PREFIX} Import B`, 75, "Congolese"]);
    const february = workbook.addWorksheet("2026-02");
    february.addRow(["Name", "Amount"]);
    february.addRow([`${TEST_PREFIX} Import A`, 35]);
    february.addRow([`${TEST_PREFIX} Import B`, 85]);
    const instructions = workbook.addWorksheet("Instructions");
    instructions.addRow(["Read me"]);
    instructions.addRow(["This sheet is ignored"]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const preview = await agent.post("/api/insurance/import/preview").field("year", "2026").attach("file", buffer, {
      filename: "insurance-import.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(preview.status).toBe(200);
    expect(preview.body.rows).toHaveLength(4);
    expect(preview.body.recognizedSheets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sheetName: "January", monthStart: "2026-01-01", rowCount: 2 }),
        expect.objectContaining({ sheetName: "2026-02", monthStart: "2026-02-01", rowCount: 2 }),
      ])
    );
    expect(preview.body.ignoredSheets).toContain("Instructions");
    expect(preview.body.errors).toHaveLength(0);

    const applied = await agent.post("/api/insurance/import/apply").send({ rows: preview.body.rows });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      createdMembers: 2,
      updatedMembers: 0,
      monthlyAmountsUpserted: 4,
    });

    const imported = await pool.query<{ id: number; name: string; amount: string; nationality: string }>(
      `SELECT id, name, amount, nationality
       FROM insurance_members
       WHERE company_id = $1 AND name LIKE $2
       ORDER BY name`,
      [ctx.companyId, `${TEST_PREFIX} Import%`]
    );
    expect(imported.rowCount).toBe(2);
    expect(imported.rows.map((row) => Number(row.amount))).toEqual([35, 85]);
    expect(imported.rows.every((row) => row.nationality === "Congolese")).toBe(true);

    const overrides = await pool.query<{ month_start: string; amount: string }>(
      `SELECT month_start::text, amount
       FROM insurance_member_monthly_amounts
       WHERE company_id = $1
       ORDER BY month_start, amount`,
      [ctx.companyId]
    );
    expect(overrides.rows.map((row) => [row.month_start, Number(row.amount)])).toEqual([
      ["2026-01-01", 25],
      ["2026-01-01", 75],
      ["2026-02-01", 35],
      ["2026-02-01", 85],
    ]);

    const januaryPosting = await agent.post("/api/insurance/generate").send({ month: 1, year: 2026 });
    expect(januaryPosting.status).toBe(200);
    expect(Number(januaryPosting.body.totalAmount)).toBeCloseTo(100, 2);
    const februaryPosting = await agent.post("/api/insurance/generate").send({ month: 2, year: 2026 });
    expect(februaryPosting.status).toBe(200);
    expect(Number(februaryPosting.body.totalAmount)).toBeCloseTo(120, 2);
  });

  it("reports duplicate members and rejects non-xlsx files", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("March 2026");
    sheet.addRow(["Name", "Monthly Amount"]);
    sheet.addRow([`${TEST_PREFIX} Duplicate`, 10]);
    sheet.addRow([`${TEST_PREFIX} Duplicate`, 20]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const duplicatePreview = await agent
      .post("/api/insurance/import/preview")
      .field("year", "2026")
      .attach("file", buffer, {
        filename: "duplicates.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
    expect(duplicatePreview.status).toBe(200);
    expect(duplicatePreview.body.errors).toEqual([
      expect.objectContaining({ sheetName: "March 2026", row: 3, message: expect.stringContaining("Duplicate") }),
    ]);

    const wrongFile = await agent
      .post("/api/insurance/import/preview")
      .field("year", "2026")
      .attach("file", Buffer.from("not an excel workbook"), { filename: "insurance.csv", contentType: "text/csv" });
    expect(wrongFile.status).toBe(400);
    expect(wrongFile.body.message).toContain(".xlsx");
  });
});

describe("POST /api/insurance/admin/repair-reversed-journals", () => {
  it("defaults to a dry run", async () => {
    const response = await agent.post("/api/insurance/admin/repair-reversed-journals").send({});
    expect(response.status).toBe(200);
    expect(response.body.dryRun).toBe(true);
    expect(response.body.confirmationRequired).toBe("REPAIR_REVERSED_INSURANCE_JOURNALS");
  });
});

describe("POST /api/insurance/admin/clear-all", () => {
  it("requires confirmation and removes only Insurance-owned records and vouchers", async () => {
    const before = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM insurance_members WHERE company_id = $1`,
      [ctx.companyId]
    );
    expect(Number(before.rows[0].count)).toBeGreaterThan(0);

    const rejected = await agent.post("/api/insurance/admin/clear-all").send({ confirmation: "CLEAR" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.confirmationRequired).toBe("CLEAR ALL INSURANCE");

    const unrelatedNumber = `${TEST_PREFIX}-UNRELATED-${ctx.companyId}`;
    const unrelated = await pool.query<{ id: number }>(
      `INSERT INTO vouchers
         (company_id, voucher_number, voucher_type, voucher_date, total_amount, source_module, optional)
       VALUES ($1, $2, 'Journal', '2026-01-01', 0, 'ERP', false)
       RETURNING id`,
      [ctx.companyId, unrelatedNumber]
    );

    const cleared = await agent.post("/api/insurance/admin/clear-all").send({ confirmation: "CLEAR ALL INSURANCE" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.membersDeleted).toBeGreaterThan(0);
    expect(cleared.body.vouchersDeleted).toBeGreaterThan(0);
    expect(cleared.body.ledgerAccountsArchived).toBeGreaterThan(0);

    const remainingMembers = await pool.query(`SELECT id FROM insurance_members WHERE company_id = $1`, [
      ctx.companyId,
    ]);
    const remainingOverrides = await pool.query(
      `SELECT id FROM insurance_member_monthly_amounts WHERE company_id = $1`,
      [ctx.companyId]
    );
    const remainingInsuranceVouchers = await pool.query(
      `SELECT id FROM vouchers WHERE company_id = $1 AND voucher_number ILIKE 'INS-%'`,
      [ctx.companyId]
    );
    const unrelatedStillExists = await pool.query(`SELECT id FROM vouchers WHERE id = $1 AND company_id = $2`, [
      unrelated.rows[0].id,
      ctx.companyId,
    ]);
    expect(remainingMembers.rowCount).toBe(0);
    expect(remainingOverrides.rowCount).toBe(0);
    expect(remainingInsuranceVouchers.rowCount).toBe(0);
    expect(unrelatedStillExists.rowCount).toBe(1);

    await pool.query(`DELETE FROM vouchers WHERE id = $1`, [unrelated.rows[0].id]);
  });
});
