import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { factoryAttendanceToday } from "../server/routes/factory/attendanceEditPolicy";

const BASE = "/api/factory/attendance";

function shiftDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

async function worker(world: FactoryWorld, name: string, extra: { active?: boolean; contractEndDate?: string } = {}) {
  return world.one(
    `INSERT INTO factory_workers (company_id, full_name, employee_code, department, active, contract_end_date)
     VALUES ($1, $2, $3, 'Sorting', $4, $5) RETURNING id`,
    [world.companyId, name, `E-${name}`, extra.active ?? true, extra.contractEndDate ?? null]
  );
}

async function attendanceRows(world: FactoryWorld) {
  return world.q(
    `SELECT worker_id, attendance_date::text AS date, status, shift, notes
       FROM factory_attendance WHERE company_id = $1 ORDER BY worker_id, attendance_date`,
    [world.companyId]
  );
}

describe("factory attendance reads", () => {
  it("returns empty sheets for a company without workers and requires dates", async () => {
    await withFactoryWorld(async (world) => {
      expect((await world.agent.get(BASE)).status).toBe(400);
      expect((await world.agent.get(BASE).query({ date: "2026-01-05" })).body).toEqual({ workers: [], attendance: [] });
      expect((await world.agent.get(`${BASE}/range`).query({ startDate: "2026-01-01" })).status).toBe(400);
      expect(
        (await world.agent.get(`${BASE}/range`).query({ startDate: "2026-01-01", endDate: "2026-01-31" })).body
      ).toEqual({ workers: [], attendance: [] });
      expect((await world.agent.get(`${BASE}/pdf`)).status).toBe(400);
    });
  });

  it("merges attendance for a day, a range and one worker, scoped to the company", async () => {
    await withFactoryWorld(async (world) => {
      const amina = await worker(world, "Amina");
      const bilal = await worker(world, "Bilal", { active: false });
      await world.q(
        `INSERT INTO factory_attendance (company_id, worker_id, attendance_date, status)
         VALUES ($1, $2, '2026-01-05', 'Present'), ($1, $2, '2026-01-06', 'Late'), ($1, $3, '2026-01-05', 'Absent')`,
        [world.companyId, amina, bilal]
      );

      const day = await world.agent.get(BASE).query({ date: "2026-01-05" });
      expect(day.status).toBe(200);
      expect(day.body.workers.map((row: { fullName: string; active: boolean }) => [row.fullName, row.active])).toEqual([
        ["Amina", true],
        ["Bilal", false],
      ]);
      expect(day.body.attendance).toHaveLength(2);

      const range = await world.agent.get(`${BASE}/range`).query({ startDate: "2026-01-06", endDate: "2026-01-31" });
      expect(range.body.attendance.map((row: { status: string }) => row.status)).toEqual(["Late"]);

      const one = await world.agent
        .get(`${BASE}/worker/${amina}`)
        .query({ startDate: "2026-01-01", endDate: "2026-01-31" });
      expect(one.body.map((row: { status: string }) => row.status)).toEqual(["Present", "Late"]);
      expect((await world.agent.get(`${BASE}/worker/${amina}`)).status).toBe(400);
      expect(
        (await world.agent.get(`${BASE}/worker/abc`).query({ startDate: "2026-01-01", endDate: "2026-01-31" })).status
      ).toBe(400);
    });
  });

  it("renders the daily attendance PDF with marked and unmarked workers", async () => {
    await withFactoryWorld(async (world) => {
      const names = ["Amina", "Bilal", "Chadi", "Dina"];
      const ids = [];
      for (const name of names) ids.push(await worker(world, name));
      const statuses = ["Present", "Absent", "Late"];
      for (let index = 0; index < statuses.length; index += 1) {
        await world.q(
          `INSERT INTO factory_attendance (company_id, worker_id, attendance_date, status) VALUES ($1, $2, '2026-01-05', $3)`,
          [world.companyId, ids[index], statuses[index]]
        );
      }
      const pdf = await world.agent
        .get(`${BASE}/pdf`)
        .query({ date: "2026-01-05", shift: "Night" })
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => done(null, Buffer.concat(chunks)));
        });
      expect(pdf.status).toBe(200);
      expect(pdf.headers["content-type"]).toBe("application/pdf");
      expect(pdf.headers["content-disposition"]).toContain("attendance-2026-01-05.pdf");
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    });
  });

  it("renders a PDF for a company with no active workers", async () => {
    await withFactoryWorld(async (world) => {
      await worker(world, "Gone", { active: false });
      const pdf = await world.agent.get(`${BASE}/pdf`).query({ date: "2026-01-05" });
      expect(pdf.status).toBe(200);
      expect(pdf.headers["content-type"]).toBe("application/pdf");
    });
  });
});

describe("factory attendance bulk save", () => {
  it("rejects malformed, duplicate, future and foreign-worker batches without writing", async () => {
    await withFactoryWorld(async (world) => {
      const amina = await worker(world, "Amina");
      const today = factoryAttendanceToday();
      const post = (records: unknown) => world.agent.post(`${BASE}/bulk`).send({ records });
      expect((await post([])).body.message).toMatch(/1–500/);
      expect((await post([{ workerId: amina, attendanceDate: today, status: "Asleep" }])).body.message).toBe(
        "Invalid attendance record"
      );
      expect(
        (await post([{ workerId: amina, attendanceDate: today, status: "Present", shift: "x".repeat(51) }])).status
      ).toBe(400);
      expect(
        (
          await post([
            { workerId: amina, attendanceDate: today, status: "Present" },
            { workerId: amina, attendanceDate: today, status: "Late" },
          ])
        ).body.message
      ).toMatch(/Duplicate/);
      expect((await post([{ workerId: amina, attendanceDate: "2026-02-30", status: "Present" }])).body.message).toBe(
        "Invalid attendance date"
      );
      expect((await post([{ workerId: amina, attendanceDate: shiftDays(today, 1), status: "Present" }])).status).toBe(
        400
      );
      const foreign = await post([{ workerId: amina + 100000, attendanceDate: today, status: "Present" }]);
      expect(foreign.status).toBe(400);
      expect(foreign.body.message).toMatch(/outside this factory company/);
      expect(await attendanceRows(world)).toEqual([]);
    });
  });

  it("keeps inactive workers absent after their contract ended", async () => {
    await withFactoryWorld(async (world) => {
      const today = factoryAttendanceToday();
      const leaver = await worker(world, "Leaver", { active: false, contractEndDate: shiftDays(today, -3) });
      const res = await world.agent
        .post(`${BASE}/bulk`)
        .send({ records: [{ workerId: leaver, attendanceDate: today, status: "Present" }] });
      expect(res.status).toBe(409);
      const absent = await world.agent
        .post(`${BASE}/bulk`)
        .send({ records: [{ workerId: leaver, attendanceDate: today, status: "Absent" }] });
      expect(absent.status).toBe(200);
      expect(await attendanceRows(world)).toEqual([
        { worker_id: leaver, date: today, status: "Absent", shift: null, notes: null },
      ]);
    });
  });

  it("upserts today's attendance without an audit row", async () => {
    await withFactoryWorld(async (world) => {
      const amina = await worker(world, "Amina");
      const today = factoryAttendanceToday();
      const save = (status: string, notes?: string) =>
        world.agent
          .post(`${BASE}/bulk`)
          .send({ records: [{ workerId: amina, attendanceDate: today, status, shift: "Day", notes }] });
      expect((await save("Present")).body).toEqual({ success: true, count: 1 });
      expect((await save("Late", "bus delay")).status).toBe(200);
      expect(await attendanceRows(world)).toEqual([
        { worker_id: amina, date: today, status: "Late", shift: "Day", notes: "bus delay" },
      ]);
      const audits = await world.q(
        `SELECT 1 FROM audit_log WHERE company_id = $1 AND table_name = 'factory_attendance'`,
        [world.companyId]
      );
      expect(audits).toHaveLength(0);
    });
  });

  it("lets an Admin correct earlier attendance and audits only real changes", async () => {
    await withFactoryWorld(async (world) => {
      const amina = await worker(world, "Amina");
      const earlier = shiftDays(factoryAttendanceToday(), -2);
      const save = (status: string) =>
        world.agent.post(`${BASE}/bulk`).send({ records: [{ workerId: amina, attendanceDate: earlier, status }] });
      expect((await save("Absent")).status).toBe(200);
      expect((await save("Absent")).status).toBe(200);
      expect((await save("Leave")).status).toBe(200);
      const audits = await world.q(
        `SELECT record_identifier, changes FROM audit_log
          WHERE company_id = $1 AND table_name = 'factory_attendance' ORDER BY id`,
        [world.companyId]
      );
      expect(audits).toHaveLength(2);
      expect(audits[0].record_identifier).toBe(`${amina}:${earlier}`);
      expect(audits[1].changes.status).toEqual({ old: "Absent", new: "Leave" });
    });
  });

  it("requires Admin approval when a Manager edits earlier attendance", async () => {
    await withFactoryWorld(async (world) => {
      const amina = await worker(world, "Amina");
      const manager = await world.agentFor("Manager");
      const earlier = shiftDays(factoryAttendanceToday(), -2);
      const res = await manager
        .post(`${BASE}/bulk`)
        .send({ records: [{ workerId: amina, attendanceDate: earlier, status: "Present" }] });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("ATTENDANCE_ADMIN_APPROVAL_REQUIRED");
      expect(await attendanceRows(world)).toEqual([]);
    });
  });
});
