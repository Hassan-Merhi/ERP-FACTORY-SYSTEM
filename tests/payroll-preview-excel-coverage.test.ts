/**
 * Payroll preview and its Excel export (POST /api/factory/payrolls/preview and
 * /preview-excel) through the real app in one rolled-back transaction: the
 * attendance breakdown, transport overrides, advances / loans / pending
 * deductions, input refusals, the styled workbook and its totals, and another
 * company's id in the body.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const PREVIEW = "/api/factory/payrolls/preview";
const EXCEL = "/api/factory/payrolls/preview-excel";

async function worker(w: FactoryWorld, name: string, companyId = w.companyId) {
  return w.one(
    `INSERT INTO factory_workers (company_id, full_name, active, employee_code, position, base_salary, transport_allowance)
     VALUES ($1, $2, TRUE, $3, 'Presser', 300, 60) RETURNING id`,
    [companyId, name, `${name.slice(0, 3).toUpperCase()}1`]
  );
}

const binary = (
  res: { on: (event: string, cb: (chunk?: Buffer) => void) => void },
  cb: (e: Error | null, b?: Buffer) => void
) => {
  const chunks: Buffer[] = [];
  res.on("data", (chunk) => chunks.push(chunk as Buffer));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

const row = (name: string, net: number) => ({
  employeeCode: null,
  name,
  position: null,
  presentDays: 10,
  totalWorkingDays: 30,
  absentDays: 1,
  base: 100,
  bonus: 5,
  transportMonthly: 60,
  transportPaid: 20,
  salaryDeduction: 3,
  advanceDeduction: 2,
  net,
});

describe("payroll preview", () => {
  it("refuses missing dates and bad bonuses", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.post(PREVIEW).send({ periodStart: "2026-06-01" })).body.message).toBe(
        "Period dates required"
      );
      const bad = await w.agent
        .post(PREVIEW)
        .send({ periodStart: "2026-06-01", periodEnd: "2026-06-30", bonusPerWorker: "abc" });
      expect([bad.status, bad.body.message]).toEqual([400, "Invalid amount"]);
    }));

  it("breaks down attendance, advances, loans and deductions per worker", () =>
    withFactoryWorld(async (w) => {
      const amina = await worker(w, "Amina");
      const bilal = await worker(w, "Bilal");
      const att = (workerId: number, date: string, status: string) =>
        w.q(`INSERT INTO factory_attendance (company_id, worker_id, attendance_date, status) VALUES ($1, $2, $3, $4)`, [
          w.companyId,
          workerId,
          date,
          status,
        ]);
      await att(amina, "2026-06-02", "Present");
      await att(amina, "2026-06-01", "Late");
      await att(amina, "2026-06-03", "Half Day");
      await att(amina, "2026-06-05", "Absent");
      await att(amina, "2026-06-04", "Absent");
      await att(amina, "2026-06-06", "Holiday");
      const advance = (workerId: number, remaining: string, type: string) =>
        w.q(
          `INSERT INTO factory_worker_advances (company_id, worker_id, amount, remaining_balance, advance_date, repayment_type)
           VALUES ($1, $2, $3, $3, '2026-05-01', $4)`,
          [w.companyId, workerId, remaining, type]
        );
      await advance(amina, "20", "salary_deduction");
      await advance(amina, "15", "salary_deduction");
      await advance(amina, "200", "manual_repayment");
      await w.q(
        `INSERT INTO factory_worker_deductions (company_id, worker_id, amount, reason, deduction_date, applied)
         VALUES ($1, $2, 7, 'Broken tool', '2026-06-03', FALSE)`,
        [w.companyId, amina]
      );
      const res = await w.agent.post(PREVIEW).send({
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        daysCount: "30",
        bonusPerWorker: "10",
        transportOverrides: { [String(bilal)]: "0", [String(amina)]: "bad" },
      });
      expect(res.status).toBe(200);
      const byName = Object.fromEntries(res.body.map((r: { name: string }) => [r.name, r]));
      expect(byName.Amina).toMatchObject({
        presentDays: 2.5,
        absentDays: 2.5,
        presentDates: [
          { date: "2026-06-01", status: "Late" },
          { date: "2026-06-02", status: "Present" },
        ],
        absentDates: [
          { date: "2026-06-04", status: "Absent" },
          { date: "2026-06-05", status: "Absent" },
        ],
        halfDayDates: [{ date: "2026-06-03", status: "Half Day" }],
        totalAdvanceBalance: 35,
        totalLoanBalance: 200,
        pendingDeductions: 7,
        bonus: 10,
        totalWorkingDays: 30,
      });
      expect(byName.Amina.pendingAdvances).toHaveLength(2);
      expect(byName.Amina.outstandingLoans).toHaveLength(1);
      expect(byName.Bilal).toMatchObject({ transport: 0, totalAdvanceBalance: 0, pendingAdvances: [] });

      const only = await w.agent
        .post(PREVIEW)
        .send({ periodStart: "2026-06-01", periodEnd: "2026-06-15", workerIds: [bilal] });
      expect(only.body.map((r: { id: number }) => r.id)).toEqual([bilal]);
    }));

  it("does not preview another company's workers from a body companyId", () =>
    withFactoryWorld(async (w) => {
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}O`]
      );
      await worker(w, "Stranger", other);
      const res = await w.agent
        .post(PREVIEW)
        .send({ companyId: other, periodStart: "2026-06-01", periodEnd: "2026-06-30" });
      expect(res.status).toBe(403);
      const excel = await w.agent
        .post(EXCEL)
        .send({ companyId: other, periodStart: "2026-06-01", periodEnd: "2026-06-30", rows: [] });
      expect(excel.status).toBe(403);
    }));
});

describe("payroll preview Excel export", () => {
  it("refuses a request without rows", () =>
    withFactoryWorld(async (w) => {
      const res = await w.agent.post(EXCEL).send({ periodStart: "2026-06-01", periodEnd: "2026-06-30" });
      expect([res.status, res.body.message]).toEqual([400, "companyId, periodStart, periodEnd and rows required"]);
    }));

  it("writes the styled workbook with banded rows, totals and the worker count", () =>
    withFactoryWorld(async (w) => {
      const res = await w.agent
        .post(EXCEL)
        .send({
          periodStart: "2026-06-01",
          periodEnd: "2026-06-30",
          rows: [{ ...row("Amina", 120), employeeCode: "AM1", position: "Presser" }, row("Bilal", 80)],
        })
        .buffer(true)
        .parse(binary);
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toBe('attachment; filename="Payroll_2026-06-01_2026-06-30.xlsx"');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as unknown as ExcelJS.Buffer);
      const ws = wb.getWorksheet("Payroll")!;
      const values = (n: number) => (ws.getRow(n).values as unknown[]).slice(1);
      expect(values(2)[0]).toBe(w.tag);
      expect(values(4)[0]).toBe("Period: 2026-06-01  →  2026-06-30");
      expect(values(7).slice(0, 3)).toEqual(["AM1", "Amina", "Presser"]);
      expect(values(8).slice(0, 3)).toEqual(["—", "Bilal", "—"]);
      const totals = values(10);
      expect(totals[1]).toBe("TOTAL");
      expect(totals.slice(6)).toEqual([200, 10, 120, 40, 6, 4, 200]);
      expect(values(11)[0]).toBe("2 workers");

      const single = await w.agent
        .post(EXCEL)
        .send({ periodStart: "2026-06-01", periodEnd: "2026-06-30", rows: [row("Solo", 1)] })
        .buffer(true)
        .parse(binary);
      const one = new ExcelJS.Workbook();
      await one.xlsx.load(single.body as unknown as ExcelJS.Buffer);
      expect((one.getWorksheet("Payroll")!.getRow(10).values as unknown[])[1]).toBe("1 worker");
    }));
});
