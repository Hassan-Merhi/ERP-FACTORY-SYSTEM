/**
 * POST /api/factory/staff-tracking/bulk (registerFactoryStaffTrackingRoutesPart3)
 * through the real app in one rolled-back transaction: period, tab, finalize
 * and record-count refusals, every per-row refusal (bad id, another company's
 * worker or employee, unknown person type, employees on Production Targets,
 * workers off the planner, duplicates, bad bale numbers), a locked production
 * day, saving production rows (removing dropped workers), ending a production
 * day with linked output, and an approved past attendance edit. Refusals
 * write nothing.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/staff-tracking/bulk";
const DAY = "2026-06-12";
const prod = { page: "production", periodType: "daily", periodStart: DAY, periodEnd: DAY };

async function roster(w: FactoryWorld) {
  const worker = (name: string, joined = "2026-01-01") =>
    w.one(
      `INSERT INTO factory_workers (company_id, full_name, active, date_joined) VALUES ($1, $2, TRUE, $3) RETURNING id`,
      [w.companyId, name, joined]
    );
  const amina = await worker("Amina");
  const bilal = await worker("Bilal");
  const chidi = await worker("Chidi", DAY);
  const loose = await worker("Loose");
  await w.q(`INSERT INTO factory_worker_categories (company_id, name, worker_ids) VALUES ($1, 'Pressing', $2::jsonb)`, [
    w.companyId,
    JSON.stringify([amina, bilal, chidi]),
  ]);
  const employee = await w.one(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date) VALUES ($1, $2, 'Eve', 'Ng', '2026-01-01') RETURNING id`,
    [w.companyId, `${w.tag}E`]
  );
  return { amina, bilal, chidi, loose, employee };
}

const entries = async (w: FactoryWorld, page = "production") =>
  w.q<{ person_id: number; produced_bales: string | null; status: string; target_bales: string | null }>(
    `SELECT person_id, produced_bales::text, status, target_bales::text FROM factory_staff_tracking_entries
      WHERE company_id = $1 AND page_type = $2 ORDER BY person_id`,
    [w.companyId, page]
  );
const post = (w: FactoryWorld, body: Record<string, unknown>) => w.agent.post(URL).send(body);
const row = (personId: number, extra: Record<string, unknown> = {}) => ({ personType: "worker", personId, ...extra });

describe("staff tracking bulk save: refusals", () => {
  it("refuses bad periods, a hidden tab, partial finalize and record counts", () =>
    withFactoryWorld(async (w) => {
      const r = await roster(w);
      expect((await post(w, { ...prod, periodEnd: "2026-06-01" })).status).toBe(400);
      const fin = await post(w, { ...prod, periodType: "weekly", finalize: true, records: [row(r.amina)] });
      expect(fin.body.message).toMatch(/End Production is only available/);
      expect((await post(w, { ...prod, records: [] })).status).toBe(400);
      expect((await post(w, { ...prod, records: Array.from({ length: 501 }, () => row(r.amina)) })).status).toBe(400);
      const manager = await w.agentFor("Manager");
      const [user] = await w.q<{ id: string }>(
        `SELECT user_id AS id FROM user_company_roles WHERE company_id = $1 AND role = 'Manager'`,
        [w.companyId]
      );
      await w.q(
        `INSERT INTO factory_user_profiles (company_id, user_id, display_name, hidden_cost_fields)
         VALUES ($1, $2, 'M', ARRAY['hide_tab_workers_attendance'])`,
        [w.companyId, user.id]
      );
      const hidden = await manager.post(URL).send({ ...prod, page: "attendance", records: [row(r.amina)] });
      expect(hidden.status).toBe(403);
      expect(await entries(w)).toEqual([]);
    }));

  it("refuses each kind of bad row and writes nothing", () =>
    withFactoryWorld(async (w) => {
      const r = await roster(w);
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}O`]
      );
      const stranger = await w.one(
        `INSERT INTO factory_workers (company_id, full_name, active) VALUES ($1, 'Stranger', TRUE) RETURNING id`,
        [other]
      );
      const refused = async (records: unknown[], body = prod) => {
        const res = await post(w, { ...body, records });
        expect(res.status).toBe(400);
        return res.body.message as string;
      };
      expect(await refused([row(0)])).toBeTruthy();
      expect(await refused([row(stranger)])).toBeTruthy();
      expect(await refused([{ personType: "employee", personId: 2147483000 }])).toBeTruthy();
      expect(await refused([{ personType: "robot", personId: r.amina }])).toBeTruthy();
      expect(await refused([{ personType: "employee", personId: r.employee }])).toBe(
        "Production Targets only supports factory workers"
      );
      expect(await refused([row(r.loose)])).toBe("Worker is not assigned to a saved Production Planner group");
      expect(await refused([row(r.amina), row(r.amina)])).toBeTruthy();
      expect(await refused([row(r.amina, { targetBales: "-1" })])).toBeTruthy();
      const attendance = { ...prod, page: "attendance", periodStart: "2026-06-01", periodEnd: "2026-06-01" };
      expect(await refused([row(r.amina, { producedBales: "x" })], attendance)).toBeTruthy();
      expect(await refused([row(r.amina, { status: "Late" })], attendance)).toBeTruthy();
      expect(await entries(w)).toEqual([]);
      expect(await entries(w, "attendance")).toEqual([]);
    }));
});

describe("staff tracking bulk save: writes", () => {
  it("saves production rows, drops removed workers and locks an ended day", () =>
    withFactoryWorld(async (w) => {
      const r = await roster(w);
      await w.q(
        `INSERT INTO factory_attendance (company_id, worker_id, attendance_date, status) VALUES ($1, $2, $3, 'Absent')`,
        [w.companyId, r.bilal, DAY]
      );
      const first = await post(w, {
        ...prod,
        records: [
          row(r.amina, { targetBales: "8", targetBalesOverridden: true, category: " Cream ", notes: " n " }),
          row(r.bilal, { producedBales: 99 }),
          row(r.chidi),
        ],
      });
      expect(first.body).toEqual({ success: true, saved: 3, finalized: false });
      const saved = await entries(w);
      expect(saved.map((e) => [e.person_id, e.status, e.target_bales, e.produced_bales])).toEqual([
        [r.amina, "Present", "8.00", null],
        [r.bilal, "Absent", null, null],
        [r.chidi, "New", null, null],
      ]);
      await post(w, { ...prod, records: [row(r.amina)] });
      expect((await entries(w)).map((e) => e.person_id)).toEqual([r.amina]);

      const link = await w.one(
        `INSERT INTO factory_worker_production_links (company_id, effective_from) VALUES ($1, '2026-06-01') RETURNING id`,
        [w.companyId]
      );
      await w.q(
        `INSERT INTO factory_worker_production_link_members (link_id, company_id, worker_id) VALUES ($1, $2, $3), ($1, $2, $4)`,
        [link, w.companyId, r.amina, r.bilal]
      );
      const ended = await post(w, { ...prod, finalize: true, records: [row(r.amina), row(r.bilal)] });
      expect(ended.body).toEqual({ success: true, saved: 2, finalized: true });
      expect((await entries(w)).map((e) => e.produced_bales)).toEqual(["0.00", "0.00"]);
      const locked = await post(w, { ...prod, records: [row(r.amina)] });
      expect([locked.status, locked.body.finalized]).toEqual([409, true]);
    }));

  it("saves an approved past attendance edit with its audit and refuses a future date", () =>
    withFactoryWorld(async (w) => {
      const r = await roster(w);
      const attendance = {
        page: "attendance",
        periodType: "daily",
        periodStart: "2026-06-01",
        periodEnd: "2026-06-01",
      };
      const res = await post(w, {
        ...attendance,
        records: [
          row(r.amina, { status: "Absent", producedBales: "2" }),
          { personType: "employee", personId: r.employee },
        ],
      });
      expect(res.body).toEqual({ success: true, saved: 2, finalized: false });
      const saved = await entries(w, "attendance");
      expect(saved.find((e) => e.person_id === r.amina)).toMatchObject({ status: "Absent", produced_bales: "2.00" });
      const audit = await w.q(
        `SELECT 1 FROM audit_log WHERE company_id = $1 AND table_name = 'factory_staff_tracking_entries'`,
        [w.companyId]
      );
      expect(audit).toHaveLength(1);
      const future = await post(w, {
        ...attendance,
        periodStart: "2099-01-01",
        periodEnd: "2099-01-01",
        records: [row(r.amina)],
      });
      expect([future.status, future.body.message]).toEqual([400, "Future attendance dates cannot be edited"]);
    }));
});
