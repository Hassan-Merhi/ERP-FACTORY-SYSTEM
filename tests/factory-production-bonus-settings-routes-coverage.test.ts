/**
 * Production Targets bonus settings routes over HTTP, one rolled-back factory
 * company per test:
 * - server/routes/factory/productionTargetBonusCategoryRateRoutes.ts
 * - server/routes/factory/productionTargetBonusWeeklyMethodRoutes.ts
 * Covers role and input refusals, the category catalog resolution (override,
 * default, entry, position, department), unknown-category refusal, request-key
 * replay and conflict, the reviewed-week lock and the default weekly method.
 * Refusals write no rows.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { createBonusWorld } from "./helpers/productionBonusFixture";

const BASE = "/api/factory/production-target-bonuses";
const DAY = "2026-01-07";

const count = async (w: FactoryWorld, table: "category" | "weekly") =>
  Number(
    (
      await w.q<{ n: number }>(
        table === "category"
          ? `SELECT count(*)::int AS n FROM factory_production_target_bonus_category_rates WHERE company_id = $1`
          : `SELECT count(*)::int AS n FROM factory_production_target_bonus_weekly_methods WHERE company_id = $1`,
        [w.companyId]
      )
    )[0].n
  );

async function worker(w: FactoryWorld, name: string, position: string | null, department: string | null) {
  return w.one(
    `INSERT INTO factory_workers (company_id, full_name, active, position, department)
     VALUES ($1, $2, TRUE, $3, $4) RETURNING id`,
    [w.companyId, name, position, department]
  );
}

async function entry(w: FactoryWorld, workerId: number, category: string | null, overridden: boolean) {
  await w.q(
    `INSERT INTO factory_staff_tracking_entries (company_id, page_type, period_type, period_start, period_end,
       person_type, person_id, category, category_overridden)
     VALUES ($1, 'production', 'daily', $2, $2, 'worker', $3, $4, $5)`,
    [w.companyId, DAY, workerId, category, overridden]
  );
}

describe("category bonus rate settings", () => {
  it("refuses non-Admin roles and invalid asOf dates", () =>
    withFactoryWorld(async (w) => {
      const manager = await w.agentFor("Manager");
      expect((await manager.get(`${BASE}/category-rates`).query({ asOf: DAY })).status).toBe(403);
      expect((await manager.post(`${BASE}/category-rates`).send({})).status).toBe(403);
      for (const asOf of [undefined, "2026-02-30", "x"]) {
        const res = await w.agent.get(`${BASE}/category-rates`).query(asOf ? { asOf } : {});
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/asOf/);
      }
    }));

  it("lists the categories resolved for the date with their latest rate", () =>
    withFactoryWorld(async (w) => {
      const overridden = await worker(w, "Override", "Sorter", null);
      await entry(w, overridden, "Shoes", true);
      const defaulted = await worker(w, "Defaulted", "Sorter", null);
      await w.q(
        `INSERT INTO factory_worker_production_target_defaults (company_id, worker_id, effective_from, category)
         VALUES ($1, $2, '2025-12-01', 'Bags')`,
        [w.companyId, defaulted]
      );
      const plain = await worker(w, "Plain", null, null);
      await entry(w, plain, " bags ", false);
      await worker(w, "ByPosition", "Pressing", "Dept");
      await worker(w, "ByDepartment", "  ", "Toys");
      await worker(w, "Nothing", null, null);
      await w.q(
        `INSERT INTO factory_production_target_bonus_category_rates (company_id, category_key, category_label,
           effective_from, enabled, rate_per_extra_bale, request_key, created_by)
         VALUES ($1, 'bags', 'Bags', '2025-12-01', TRUE, '0.2500', 'seed-rate-1', 'x'),
                ($1, 'bags', 'Bags', '2025-12-01', TRUE, '0.5000', 'seed-rate-2', 'x')`,
        [w.companyId]
      );
      const res = await w.agent.get(`${BASE}/category-rates`).query({ asOf: DAY });
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      const byKey = Object.fromEntries(
        res.body.categories.map((c: { categoryKey: string }) => [c.categoryKey, c])
      ) as Record<string, { categoryLabel: string; effective: { ratePerExtraBale: string } | null }>;
      expect(Object.keys(byKey).sort()).toEqual(["bags", "pressing", "shoes", "toys"]);
      expect(byKey.bags.effective?.ratePerExtraBale).toBe("0.5000");
      expect(byKey.shoes.effective).toBeNull();
      expect(res.body.history).toHaveLength(2);
      expect(res.body.historyTruncated).toBe(false);
    }));

  it("refuses malformed bodies and unknown categories without writing", () =>
    withFactoryWorld(async (w) => {
      const valid = {
        category: "Bags",
        effectiveFrom: DAY,
        enabled: true,
        ratePerExtraBale: "0.5000",
        requestKey: "cat-rate-0001",
      };
      const bad: Array<Record<string, unknown>> = [
        { category: "  " },
        { effectiveFrom: "2026-13-01" },
        { enabled: "yes" },
        { ratePerExtraBale: "-1" },
        { ratePerExtraBale: "0" },
        { requestKey: 12345678 },
        { requestKey: "short" },
        { note: "n".repeat(501) },
      ];
      for (const patch of bad) {
        const res = await w.agent.post(`${BASE}/category-rates`).send({ ...valid, ...patch });
        expect(res.status, JSON.stringify(patch)).toBe(400);
      }
      const unknown = await w.agent.post(`${BASE}/category-rates`).send(valid);
      expect(unknown.status).toBe(409);
      expect(unknown.body.message).toMatch(/existing category/);
      expect(await count(w, "category")).toBe(0);
    }));

  it("saves, replays and refuses a reused request key for another change", () =>
    withFactoryWorld(async (w) => {
      const id = await worker(w, "Saver", null, null);
      await entry(w, id, "Bags", false);
      const body = {
        category: " BAGS ",
        effectiveFrom: DAY,
        enabled: false,
        ratePerExtraBale: "0",
        requestKey: "cat-rate-0002",
        note: "  paused  ",
      };
      const first = await w.agent.post(`${BASE}/category-rates`).send(body);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ replayed: false, category: "BAGS", paidClaimsRemainLocked: true });
      const replay = await w.agent.post(`${BASE}/category-rates`).send(body);
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ replayed: true, versionId: first.body.versionId });
      for (const patch of [
        { effectiveFrom: "2026-01-08" },
        { enabled: true, ratePerExtraBale: "1" },
        { ratePerExtraBale: "0.0000", note: "other" },
      ]) {
        const res = await w.agent.post(`${BASE}/category-rates`).send({ ...body, ...patch });
        expect(res.status, JSON.stringify(patch)).toBe(409);
        expect(res.body.message).toMatch(/different rate change/);
      }
      // No note on the stored row compares as "".
      const noNote = { ...body, requestKey: "cat-rate-0003", note: undefined, enabled: true, ratePerExtraBale: "2" };
      expect((await w.agent.post(`${BASE}/category-rates`).send(noNote)).status).toBe(201);
      expect((await w.agent.post(`${BASE}/category-rates`).send(noNote)).status).toBe(200);
      expect(await count(w, "category")).toBe(2);
    }));
});

describe("weekly bonus method settings", () => {
  const MONDAY = "2026-01-12";

  it("refuses non-Admin roles and invalid dates, and defaults to per extra bale", () =>
    withFactoryWorld(async (w) => {
      const manager = await w.agentFor("Manager");
      expect((await manager.get(`${BASE}/weekly-method`).query({ asOf: DAY })).status).toBe(403);
      expect((await manager.post(`${BASE}/weekly-method`).send({})).status).toBe(403);
      expect((await w.agent.get(`${BASE}/weekly-method`).query({ asOf: "2026-02-31" })).status).toBe(400);
      const res = await w.agent.get(`${BASE}/weekly-method`).query({ asOf: DAY });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        weekStart: "2026-01-05",
        effective: { id: null, method: "per_extra_bale", default: true },
        history: [],
        historyTruncated: false,
      });
    }));

  it("refuses invalid methods, weeks, amounts, notes and keys without writing", () =>
    withFactoryWorld(async (w) => {
      const valid = { method: "weekly_flat", effectiveWeek: MONDAY, flatBonusUsd: "25", requestKey: "weekly-0001" };
      const bad: Array<Record<string, unknown>> = [
        { method: "monthly" },
        { effectiveWeek: "2026-01-13" },
        { effectiveWeek: "nope" },
        { flatBonusUsd: "-1" },
        { flatBonusUsd: "0" },
        { method: "per_extra_bale", flatBonusUsd: "5" },
        { note: 5 },
        { note: "n".repeat(501) },
        { requestKey: "bad key!" },
      ];
      for (const patch of bad) {
        const res = await w.agent.post(`${BASE}/weekly-method`).send({ ...valid, ...patch });
        expect(res.status, JSON.stringify(patch)).toBe(400);
      }
      expect(await count(w, "weekly")).toBe(0);
    }));

  it("saves, replays, refuses a reused key and a backdated reviewed week", () =>
    withFactoryWorld(async (w) => {
      const body = { method: "weekly_flat", effectiveWeek: MONDAY, flatBonusUsd: "25", requestKey: "weekly-0002" };
      const first = await w.agent.post(`${BASE}/weekly-method`).send(body);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ replayed: false, flatBonusUsd: "25.00", historicalReviewsUnaffected: true });
      const replay = await w.agent.post(`${BASE}/weekly-method`).send(body);
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ replayed: true, versionId: first.body.versionId });
      for (const patch of [
        { method: "per_extra_bale", flatBonusUsd: "0" },
        { effectiveWeek: "2026-01-19" },
        { flatBonusUsd: "30" },
        { note: "changed" },
      ]) {
        const res = await w.agent.post(`${BASE}/weekly-method`).send({ ...body, ...patch });
        expect(res.status, JSON.stringify(patch)).toBe(409);
        expect(res.body.message).toMatch(/already used/);
      }

      const effective = await w.agent.get(`${BASE}/weekly-method`).query({ asOf: "2026-01-14" });
      expect(effective.body.effective).toMatchObject({ id: first.body.versionId, method: "weekly_flat" });

      const b = await createBonusWorld(w.client, w.companyId);
      const reviewed = await b.worker("Reviewed");
      await w.q(
        `INSERT INTO factory_target_bonus_weekly_reviews (company_id, worker_id, week_start, week_end, status, bonus_amount,
           calculation_version, credited_bales, extra_bales, target_bales, method_version_id, reviewed_by, snapshot_hash,
           snapshot_json, worker_name_snapshot)
         VALUES ($1, $2, '2026-01-12', '2026-01-18', 'approved', 25, 'v1', 8, 3, 5, $3, 'fixture', $4, '{}', 'W')`,
        [w.companyId, reviewed, first.body.versionId, "e".repeat(64)]
      );
      const locked = await w.agent
        .post(`${BASE}/weekly-method`)
        .send({ method: "per_extra_bale", effectiveWeek: "2026-01-05", flatBonusUsd: "0", requestKey: "weekly-0003" });
      expect(locked.status).toBe(409);
      expect(locked.body.message).toMatch(/reviewed weekly bonus/);
      const later = await w.agent
        .post(`${BASE}/weekly-method`)
        .send({ method: "per_extra_bale", effectiveWeek: "2026-01-19", flatBonusUsd: 0, requestKey: "weekly-0004" });
      expect(later.status).toBe(201);
      expect(await count(w, "weekly")).toBe(2);
    }));
});
