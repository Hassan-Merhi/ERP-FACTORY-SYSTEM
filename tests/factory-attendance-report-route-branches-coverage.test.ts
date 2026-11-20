/**
 * Monthly attendance report
 * (server/routes/factory/employee-pos/registerEmployeeAttendanceRoutesPart2.ts)
 * over HTTP in one rolled-back factory company per test: every date and
 * year/month refusal, the default month, the empty company, multi-month
 * labels, Present/Absent/other statuses, inactive workers (with and without a
 * contract end, with payroll) and payrolls whose worker is outside the report.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/workers/attendance-report";

const report = (w: FactoryWorld, query: string) => w.agent.get(`${URL}${query}`);

const worker = (w: FactoryWorld, name: string, active: boolean, contractEnd: string | null, salary: string | null) =>
  w.one(
    `INSERT INTO factory_workers (company_id, full_name, active, contract_end_date, base_salary, salary_type, transport_allowance)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'Monthly'), $7) RETURNING id`,
    [w.companyId, name, active, contractEnd, salary, salary ? "Monthly" : null, salary ? "5" : null]
  );

describe("attendance report", () => {
  it("refuses malformed dates, years, months and ranges", () =>
    withFactoryWorld(async (w) => {
      for (const query of [
        "?startDate=2026-01-01",
        "?endDate=2026-01-31",
        "?startDate=2026-1-1&endDate=2026-01-31",
        "?startDate=2026-01-01&endDate=31-01-2026",
        "?startDate=2026-01-01&startDate=2026-01-02&endDate=2026-01-31",
      ]) {
        expect((await report(w, query)).body.message, query).toMatch(/Invalid date format/);
      }
      for (const query of [
        "?year=26",
        "?year=2026&year=2027",
        "?month=abc",
        "?month=1&month=2",
        "?year=2026&month=13",
        "?month=0",
      ]) {
        const res = await report(w, query);
        expect(res.status, query).toBe(400);
        expect(res.body.message).toMatch(/Invalid year or month/);
      }
      for (const query of [
        "?startDate=2026-02-10&endDate=2026-02-01",
        "?startDate=2026-02-31&endDate=2026-03-01",
        "?startDate=2000-01-01&endDate=2026-01-01",
      ]) {
        const res = await report(w, query);
        expect(res.status, query).toBe(400);
        expect(res.body.code).toBe("ATTENDANCE_REPORT_INVALID_RANGE");
      }
    }));

  it("returns an empty report for the current month and for a company without workers", () =>
    withFactoryWorld(async (w) => {
      const current = await report(w, "");
      expect(current.status).toBe(200);
      const now = new Date();
      expect(current.body.startDate).toBe(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`);
      expect(current.body).toMatchObject({ workers: [], dailySummary: {}, totals: { workers: 0 } });
      const year = await report(w, "?year=2024&month=2");
      expect(year.body).toMatchObject({ startDate: "2024-02-01", endDate: "2024-02-29" });
      expect(year.body.dates).toHaveLength(29);
      expect(year.body.dates[0]).toEqual({ date: "2024-02-01", label: "1", abbr: "Th", isWeekend: false });
      const onlyYear = await report(w, "?year=2025");
      expect(onlyYear.body.startDate.startsWith("2025-")).toBe(true);
    }));

  it("reports statuses, inactive workers, multi-month labels and payroll reconciliation", () =>
    withFactoryWorld(async (w) => {
      const present = await worker(w, "A Present", true, null, "300");
      await worker(w, "B Plain", true, null, null);
      const leaver = await worker(w, "C Leaver", false, "2026-02-02", "200");
      const noEnd = await worker(w, "D Former", false, null, null);
      const gone = await worker(w, "E Gone", false, "2026-01-15", null);
      const attend = (id: number, date: string, status: string) =>
        w.q(`INSERT INTO factory_attendance (company_id, worker_id, attendance_date, status) VALUES ($1, $2, $3, $4)`, [
          w.companyId,
          id,
          date,
          status,
        ]);
      await attend(present, "2026-01-31", "Present");
      await attend(present, "2026-02-01", "Absent");
      await attend(present, "2026-02-02", "Leave");
      await attend(leaver, "2026-01-31", "Present");
      const payroll = (id: number, net: string | null) =>
        w.q(
          `INSERT INTO factory_payrolls (company_id, worker_id, period_start, period_end, status, net_salary, advances)
           VALUES ($1, $2, '2026-02-01', '2026-02-02', 'PAID', $3, NULL)`,
          [w.companyId, id, net]
        );
      await payroll(leaver, "150");
      await payroll(noEnd, null);
      // A payroll for another company's worker is reconciled but never joined to a row.
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}O`]
      );
      const foreignWorker = await w.one(
        `INSERT INTO factory_workers (company_id, full_name, active) VALUES ($1, 'Foreign', TRUE) RETURNING id`,
        [other]
      );
      await payroll(foreignWorker, "99");

      const res = await report(w, "?startDate=2026-01-31&endDate=2026-02-02");
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.dates.map((d: { label: string }) => d.label)).toEqual(["Jan 31", "Feb 1", "Feb 2"]);
      const byName = Object.fromEntries(res.body.workers.map((r: { fullName: string }) => [r.fullName, r]));
      expect(Object.keys(byName).sort()).toEqual(["A Present", "B Plain", "C Leaver", "D Former"]);
      expect(byName["A Present"]).toMatchObject({
        presentCount: 1,
        absentCount: 1,
        recordedCount: 2,
        attendancePct: 50,
      });
      expect(byName["A Present"].attendance["2026-02-02"]).toBe("Leave");
      expect(byName["B Plain"]).toMatchObject({
        attendancePct: null,
        baseSalary: "0",
        salaryType: "Monthly",
        transportAllowance: "0",
      });
      // The leaver is absent from the contract end through today.
      expect(byName["C Leaver"]).toMatchObject({ presentCount: 1, absentCount: 1, active: false });
      expect(byName["D Former"].recordedCount).toBe(0);
      expect(res.body.dailySummary).toEqual({
        "2026-01-31": { present: 2, absent: 0 },
        "2026-02-01": { present: 0, absent: 1 },
        "2026-02-02": { present: 0, absent: 1 },
      });
      expect(res.body.totals).toMatchObject({
        workers: 4,
        activeWorkers: 2,
        inactiveWorkers: 2,
        presentDays: 2,
        absentDays: 2,
        totalPossibleDays: 12,
      });
      expect(res.body.payrollReconciliation).toBeTruthy();
      expect(gone).toBeGreaterThan(0);
    }));
});
