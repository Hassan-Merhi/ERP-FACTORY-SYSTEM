/**
 * Factory employee attendance: daily read, bulk save with historical-edit
 * approval and audit, and per-employee range read. Refusals (validation,
 * duplicates, other company's employee, missing approval) write nothing.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { factoryAttendanceToday } from "../server/routes/factory/attendanceEditPolicy";

const PAST = "2026-01-05";

async function employee(w: FactoryWorld, first: string, companyId = w.companyId, type = "Employee") {
  return w.one(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date, employee_type, active)
     VALUES ($1, $2, $3, 'Test', '2025-01-01', $4, true) RETURNING id`,
    [companyId, `${w.tag}${first}`, first, type]
  );
}

const attendanceRows = (w: FactoryWorld) =>
  w.q<{ employee_id: number; status: string; notes: string | null }>(
    `SELECT employee_id, status, notes FROM employee_attendance WHERE company_id = $1 ORDER BY employee_id, attendance_date`,
    [w.companyId]
  );
const attendanceAudits = (w: FactoryWorld) =>
  w.q<{ changes: Record<string, { new?: unknown; old?: unknown }> }>(
    `SELECT changes FROM audit_log WHERE table_name = 'employee_attendance' AND company_id = $1 ORDER BY id`,
    [w.companyId]
  );

describe("employee attendance reads", () => {
  it("requires a date, returns empty lists without employees, and maps saved rows", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.get("/api/factory/employee-attendance")).status).toBe(400);
      expect((await w.agent.get("/api/factory/employee-attendance").query({ date: PAST })).body).toEqual({
        employees: [],
        attendance: [],
      });
      const a = await employee(w, "Amina");
      await employee(w, "Worker", w.companyId, "Worker");
      await w.q(
        `INSERT INTO employee_attendance (company_id, employee_id, attendance_date, status, notes) VALUES ($1, $2, $3, 'Late', 'traffic')`,
        [w.companyId, a, PAST]
      );
      const res = await w.agent.get("/api/factory/employee-attendance").query({ date: PAST });
      expect(res.body.employees.map((e: { id: number }) => e.id)).toEqual([a]);
      expect(res.body.attendance).toEqual([
        expect.objectContaining({ employeeId: a, status: "Late", notes: "traffic" }),
      ]);
    });
  });

  it("validates and reads one employee's range", async () => {
    await withFactoryWorld(async (w) => {
      const a = await employee(w, "Amina");
      await w.q(
        `INSERT INTO employee_attendance (company_id, employee_id, attendance_date, status) VALUES ($1, $2, $3, 'Present')`,
        [w.companyId, a, PAST]
      );
      const base = `/api/factory/employee-attendance/employee`;
      expect((await w.agent.get(`${base}/abc`).query({ startDate: PAST, endDate: PAST })).status).toBe(400);
      expect((await w.agent.get(`${base}/${a}`).query({ startDate: PAST })).status).toBe(400);
      const res = await w.agent.get(`${base}/${a}`).query({ startDate: "2026-01-01", endDate: "2026-01-31" });
      expect(res.body).toEqual([expect.objectContaining({ employeeId: a, status: "Present" })]);
    });
  });
});

describe("bulk attendance save", () => {
  it("refuses malformed batches without writing", async () => {
    await withFactoryWorld(async (w) => {
      const a = await employee(w, "Amina");
      const post = (body: unknown) => w.agent.post("/api/factory/employee-attendance/bulk").send(body as object);
      const record = { employeeId: a, attendanceDate: PAST, status: "Present" };
      expect((await post({})).status).toBe(400);
      expect((await post({ records: [] })).status).toBe(400);
      expect((await post({ records: Array.from({ length: 501 }, () => record) })).status).toBe(400);
      for (const bad of [
        { ...record, employeeId: 0 },
        { ...record, status: "Sleeping" },
        { ...record, notes: 5 },
        { ...record, notes: "x".repeat(4001) },
        null,
      ]) {
        expect((await post({ records: [bad] })).body.message).toBe("Invalid attendance record");
      }
      expect((await post({ records: [record, record] })).body.message).toContain("Duplicate");
      expect((await post({ records: [{ ...record, attendanceDate: "2026-02-30" }] })).status).toBe(400);
      expect((await post({ records: [{ ...record, attendanceDate: "2099-01-01" }] })).status).toBe(400);

      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const foreign = await employee(w, "Foreign", other);
      const cross = await post({ records: [{ ...record, employeeId: foreign }] });
      expect(cross.status).toBe(400);
      expect(cross.body.message).toContain("outside this factory company");
      expect(await attendanceRows(w)).toEqual([]);
      expect(await w.q(`SELECT 1 FROM employee_attendance WHERE employee_id = $1`, [foreign])).toEqual([]);
    });
  });

  it("saves today's attendance without approval or audit", async () => {
    await withFactoryWorld(async (w) => {
      const a = await employee(w, "Amina");
      const manager = await w.agentFor("Manager");
      const res = await manager
        .post("/api/factory/employee-attendance/bulk")
        .send({ records: [{ employeeId: a, attendanceDate: factoryAttendanceToday(), status: "Present" }] });
      expect(res.body).toEqual({ saved: 1 });
      expect(await attendanceRows(w)).toEqual([{ employee_id: a, status: "Present", notes: null }]);
      expect(await attendanceAudits(w)).toEqual([]);
    });
  });

  it("requires Admin approval for earlier dates and audits only real changes", async () => {
    await withFactoryWorld(async (w) => {
      const a = await employee(w, "Amina");
      const manager = await w.agentFor("Manager");
      const records = [{ employeeId: a, attendanceDate: PAST, status: "Absent", notes: "sick" }];
      const refused = await manager.post("/api/factory/employee-attendance/bulk").send({ records });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe("ATTENDANCE_ADMIN_APPROVAL_REQUIRED");
      const wrong = await manager
        .post("/api/factory/employee-attendance/bulk")
        .send({ records, adminUsername: w.username, adminPassword: "wrong-password" });
      expect(wrong.status).toBe(401);
      expect(await attendanceRows(w)).toEqual([]);

      const approved = await manager
        .post("/api/factory/employee-attendance/bulk")
        .send({ records, adminUsername: w.username, adminPassword: "rolledback-pass-123" });
      expect(approved.body).toEqual({ saved: 1 });
      // The Admin edits directly; an unchanged resubmission is not audited.
      expect((await w.agent.post("/api/factory/employee-attendance/bulk").send({ records })).status).toBe(200);
      const changed = await w.agent
        .post("/api/factory/employee-attendance/bulk")
        .send({ records: [{ employeeId: a, attendanceDate: PAST, status: "Leave" }] });
      expect(changed.status).toBe(200);

      expect(await attendanceRows(w)).toEqual([{ employee_id: a, status: "Leave", notes: null }]);
      const audits = await attendanceAudits(w);
      expect(audits).toHaveLength(2);
      expect(audits[0].changes).toMatchObject({
        status: { old: null, new: "Absent" },
        authorizationMethod: { new: "admin_password" },
      });
      expect(audits[1].changes).toMatchObject({
        status: { old: "Absent", new: "Leave" },
        notes: { old: "sick", new: null },
        authorizationMethod: { new: "authenticated_role" },
      });
    });
  });
});
