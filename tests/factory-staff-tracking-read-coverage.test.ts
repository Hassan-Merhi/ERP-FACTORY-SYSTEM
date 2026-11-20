/**
 * GET /api/factory/staff-tracking and /production-target-defaults
 * (registerFactoryStaffTrackingRoutesPart1) through the real app in one
 * rolled-back transaction: period and tab refusals, attendance daily and
 * weekly pages, Production Targets daily rows (defaults, day overrides,
 * linked workers sharing output, new joiners, absences), finalized days that
 * read the saved snapshot, and the weekly rollup.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/staff-tracking";
const get = (w: FactoryWorld, query: Record<string, string>, agent = w.agent) =>
  agent.get(`${URL}?${new URLSearchParams(query)}`);
const day = (page: string, date: string) => ({ page, periodType: "daily", periodStart: date, periodEnd: date });

async function roster(w: FactoryWorld) {
  const worker = (name: string, joined: string | null, position: string | null = null) =>
    w.one(
      `INSERT INTO factory_workers (company_id, full_name, active, date_joined, position) VALUES ($1, $2, TRUE, $3, $4) RETURNING id`,
      [w.companyId, name, joined, position]
    );
  const amina = await worker("Amina", "2026-01-01", "Presser");
  const bilal = await worker("Bilal", "2026-01-01");
  const chidi = await worker("Chidi", "2026-06-12");
  const dina = await worker("Dina", "2026-01-01");
  await w.q(`INSERT INTO factory_worker_categories (company_id, name, worker_ids) VALUES ($1, 'Pressing', $2::jsonb)`, [
    w.companyId,
    JSON.stringify([amina, bilal, chidi]),
  ]);
  return { amina, bilal, chidi, dina };
}

const entry = (
  w: FactoryWorld,
  page: string,
  type: string,
  start: string,
  end: string,
  personId: number,
  fields: string
) =>
  w.q(
    `INSERT INTO factory_staff_tracking_entries (company_id, page_type, period_type, period_start, period_end, person_type,
       person_id, group_name, category, category_overridden, target_bales, target_overridden, produced_bales, status, notes)
     SELECT $1, $2, $3, $4, $5, 'worker', $6, f.g, f.c, COALESCE(f.co, FALSE), f.t, COALESCE(f.tor, FALSE), f.p,
            COALESCE(f.s, 'Present'), f.n
       FROM jsonb_to_record($7::jsonb) AS f(g text, c text, co boolean, t numeric, tor boolean, p numeric, s text, n text)`,
    [w.companyId, page, type, start, end, personId, fields]
  );

describe("staff tracking reads", () => {
  it("refuses bad periods and a tab hidden from the user", () =>
    withFactoryWorld(async (w) => {
      expect(
        (await get(w, { page: "x", periodType: "daily", periodStart: "2026-06-01", periodEnd: "2026-06-01" })).status
      ).toBe(400);
      expect(
        (await get(w, { page: "production", periodType: "weekly", periodStart: "2026-06-01", periodEnd: "2026-08-01" }))
          .status
      ).toBe(400);
      expect((await w.agent.get(`${URL}/production-target-defaults?asOf=bad`)).status).toBe(400);
      const manager = await w.agentFor("Manager");
      const [user] = await w.q<{ id: string }>(
        `SELECT user_id AS id FROM user_company_roles WHERE company_id = $1 AND role = 'Manager'`,
        [w.companyId]
      );
      await w.q(
        `INSERT INTO factory_user_profiles (company_id, user_id, display_name, hidden_cost_fields)
         VALUES ($1, $2, 'M', ARRAY['hide_tab_stockentry_production_targets'])`,
        [w.companyId, user.id]
      );
      expect((await get(w, day("production", "2026-06-12"), manager)).status).toBe(403);
      expect((await manager.get(`${URL}/production-target-defaults?asOf=2026-06-12`)).status).toBe(403);
      expect((await get(w, day("attendance", "2026-06-12"), manager)).status).toBe(200);
    }));

  it("lists every active worker on the attendance pages with saved values", () =>
    withFactoryWorld(async (w) => {
      const r = await roster(w);
      await w.q(
        `INSERT INTO factory_attendance (company_id, worker_id, attendance_date, status) VALUES ($1, $2, '2026-06-12', 'Absent')`,
        [w.companyId, r.bilal]
      );
      await entry(
        w,
        "attendance",
        "daily",
        "2026-06-12",
        "2026-06-12",
        r.amina,
        JSON.stringify({ p: 3, s: "Absent", n: "note" })
      );
      const res = await get(w, day("attendance", "2026-06-12"));
      const rows = Object.fromEntries(res.body.rows.map((row: { name: string }) => [row.name, row]));
      expect(Object.keys(rows).sort()).toEqual(["Amina", "Bilal", "Chidi", "Dina"]);
      expect(rows.Amina).toMatchObject({ status: "Absent", producedBales: 3, notes: "note", groupName: "All Workers" });
      expect(rows.Bilal).toMatchObject({ status: "Absent", producedBales: null });
      expect(rows.Chidi.status).toBe("New");
      const weekly = await get(w, {
        page: "attendance",
        periodType: "weekly",
        periodStart: "2026-06-08",
        periodEnd: "2026-06-14",
      });
      expect(weekly.body.rows).toHaveLength(4);
    }));

  it("builds open Production Targets rows from defaults, overrides and linked output", () =>
    withFactoryWorld(async (w) => {
      const r = await roster(w);
      await w.q(
        `INSERT INTO factory_worker_production_target_defaults (company_id, worker_id, effective_from, category, target_bales)
         VALUES ($1, $2, '2026-06-01', 'Cream', 8), ($1, $3, '2026-06-01', 'Mixed', 6)`,
        [w.companyId, r.amina, r.bilal]
      );
      await entry(
        w,
        "production",
        "daily",
        "2026-06-12",
        "2026-06-12",
        r.bilal,
        JSON.stringify({ c: "Day", co: true, t: 9, tor: true })
      );
      const link = await w.one(
        `INSERT INTO factory_worker_production_links (company_id, effective_from) VALUES ($1, '2026-06-01') RETURNING id`,
        [w.companyId]
      );
      await w.q(
        `INSERT INTO factory_worker_production_link_members (link_id, company_id, worker_id) VALUES ($1, $2, $3), ($1, $2, $4)`,
        [link, w.companyId, r.amina, r.bilal]
      );
      const res = await get(w, day("production", "2026-06-12"));
      expect(res.body.finalized).toBe(false);
      const rows = Object.fromEntries(res.body.rows.map((row: { name: string }) => [row.name, row]));
      expect(Object.keys(rows).sort()).toEqual(["Amina", "Bilal", "Chidi"]);
      expect(rows.Amina).toMatchObject({
        category: "Cream",
        targetBales: 8,
        categoryOverridden: false,
        linkGroupId: link,
      });
      expect(rows.Bilal).toMatchObject({
        category: "Day",
        targetBales: 9,
        targetBalesOverridden: true,
        defaultTargetBales: 6,
      });
      expect(rows.Bilal.linkedWorkerIds).toEqual([r.amina, r.bilal].sort((a, b) => a - b));
      expect(rows.Chidi.status).toBe("New");

      const defaults = await w.agent.get(`${URL}/production-target-defaults?asOf=2026-06-12`);
      expect(defaults.body.targets).toEqual(
        expect.arrayContaining([{ workerId: r.amina, category: "Cream", targetBales: 8 }])
      );
    }));

  it("reads a finalized day from its saved snapshot and rolls up a week", () =>
    withFactoryWorld(async (w) => {
      const r = await roster(w);
      await entry(
        w,
        "production",
        "daily",
        "2026-06-12",
        "2026-06-12",
        r.dina,
        JSON.stringify({ g: "Old", c: "Saved", t: 5, p: 4, s: "Absent" })
      );
      await w.q(
        `INSERT INTO factory_staff_tracking_period_closures (company_id, page_type, period_type, period_start, period_end, ended_at)
         VALUES ($1, 'production', 'daily', '2026-06-12', '2026-06-12', now())`,
        [w.companyId]
      );
      const res = await get(w, day("production", "2026-06-12"));
      expect(res.body.finalized).toBe(true);
      const dina = res.body.rows.find((row: { name: string }) => row.name === "Dina");
      expect(dina).toMatchObject({
        groupName: "Old",
        category: "Saved",
        targetBales: 5,
        producedBales: 4,
        status: "Absent",
      });

      const week = await get(w, {
        page: "production",
        periodType: "weekly",
        periodStart: "2026-06-08",
        periodEnd: "2026-06-14",
      });
      expect(week.status).toBe(200);
      expect(week.body).toMatchObject({ periodType: "weekly", finalized: false });
      expect(Array.isArray(week.body.rows)).toBe(true);
    }));
});
