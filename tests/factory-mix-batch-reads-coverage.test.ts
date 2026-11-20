/**
 * Read endpoints in server/routes/factory/mix-batches/reads.ts through the real
 * app, one rolled-back factory company per test: the privileged audit profiles
 * (refused for non-admin roles, JSON and CSV exports), the summary and full
 * list views, the cost-source export and the single-batch read with its
 * invalid-id, not-found and cross-company refusals.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

let seq = 0;
async function seedBatch(w: FactoryWorld, companyId = w.companyId, opts: { total?: string; deleted?: boolean } = {}) {
  seq += 1;
  return w.one(
    `INSERT INTO factory_mix_batches (company_id, batch_code, batch_number, name, status, total_weight_kg, used_kg,
       total_cost, cost_per_kg, batch_date, deleted_at)
     VALUES ($1, $2, $3, 'Blend', 'OPEN', $4, 10, 40, 0.4, '2026-03-01', CASE WHEN $5 THEN now() END) RETURNING id`,
    [companyId, `RD${seq}-${w.tag}`, seq, opts.total ?? "100", opts.deleted ?? false]
  );
}

const PROFILES = [
  ["integrity-monitor", "factory-mix-monitor-status"],
  ["lifecycle-audit", "factory-mix-lifecycle-audit-read-only"],
  ["downstream-audit", "factory-mix-downstream-audit-read-only"],
  ["raw-provenance-audit", "factory-mix-raw-provenance-read-only"],
  ["historical-audit", "historical-mix-batch-audit-read-only"],
] as const;

describe("privileged audit profiles", () => {
  it("refuses every audit profile for a non-privileged role", () =>
    withFactoryWorld(async (w) => {
      const staff = await w.agentFor("Staff");
      for (const [profile] of PROFILES) {
        const res = await staff.get(`/api/factory/mix-batches?profile=${profile}`);
        expect(res.status, profile).toBe(403);
        expect(res.body.message).toMatch(/requires Admin, Owner or Developer/);
      }
    }));

  it("serves every audit profile as JSON to an Admin", () =>
    withFactoryWorld(async (w) => {
      await seedBatch(w);
      for (const [profile, header] of PROFILES) {
        const res = await w.agent.get(`/api/factory/mix-batches?profile=${profile}`);
        expect(res.status, `${profile} ${res.text.slice(0, 200)}`).toBe(200);
        expect(res.headers["x-erp-payload-profile"]).toBe(header);
        expect(res.headers["cache-control"]).toBe("private, no-store");
      }
    }));

  it("exports CSV for the lifecycle, downstream, provenance and historical audits", () =>
    withFactoryWorld(async (w) => {
      await seedBatch(w);
      const cases: Array<[string, string]> = [
        ["profile=lifecycle-audit&format=csv", "factory-mix-lifecycle-audit.csv"],
        ["profile=downstream-audit&format=csv", "factory-mix-downstream-audit.csv"],
        ["profile=raw-provenance-audit&format=csv", "factory-mix-stock-audit.csv"],
        ["profile=raw-provenance-audit&format=csv&section=ownership", "factory-mix-ownership-audit.csv"],
        ["profile=raw-provenance-audit&format=csv&section=adjustments", "factory-mix-adjustments-audit.csv"],
        ["profile=historical-audit&format=csv", "factory-mix-historical-batches-audit.csv"],
        ["profile=historical-audit&format=csv&level=sources", "factory-mix-historical-sources-audit.csv"],
      ];
      for (const [query, filename] of cases) {
        const res = await w.agent.get(`/api/factory/mix-batches?${query}`);
        expect(res.status, query).toBe(200);
        expect(res.headers["content-type"]).toMatch(/^text\/csv/);
        expect(res.headers["content-disposition"]).toContain(filename);
        expect(res.text.length).toBeGreaterThan(0);
      }
    }));

  it("drops source rows from the historical audit when includeSources=false", () =>
    withFactoryWorld(async (w) => {
      const id = await seedBatch(w);
      const full = await w.agent.get(`/api/factory/mix-batches?profile=historical-audit`);
      const lean = await w.agent.get(`/api/factory/mix-batches?profile=historical-audit&includeSources=false`);
      expect(lean.status).toBe(200);
      const fullBatch = full.body.batches.find((b: { batchId: number }) => b.batchId === id);
      const leanBatch = lean.body.batches.find((b: { batchId: number }) => b.batchId === id);
      expect(fullBatch).toHaveProperty("sources");
      expect(leanBatch).toBeDefined();
      expect(leanBatch).not.toHaveProperty("sources");
    }));
});

describe("batch lists", () => {
  it("lists live batches only, as a summary and with historical display values", () =>
    withFactoryWorld(async (w) => {
      const live = await seedBatch(w);
      const empty = await seedBatch(w, w.companyId, { total: "0" });
      const deleted = await seedBatch(w, w.companyId, { deleted: true });
      const summary = await w.agent.get(`/api/factory/mix-batches?profile=summary`);
      expect(summary.status).toBe(200);
      const ids = summary.body.map((b: { id: number }) => b.id);
      expect(ids).toEqual(expect.arrayContaining([live, empty]));
      expect(ids).not.toContain(deleted);
      expect(summary.body.find((b: { id: number }) => b.id === live).remainingKg).toBe("90.000");

      const full = await w.agent.get(`/api/factory/mix-batches`);
      expect(full.status).toBe(200);
      expect(full.headers["x-erp-payload-profile"]).toBe("mix-batches-historical-stored-costs");
      const liveRow = full.body.find((b: { id: number }) => b.id === live);
      expect(liveRow).toMatchObject({
        remainingKg: "90.000",
        displayTotalWeightKg: "100.000",
        displayTotalCost: "40.000000",
        displayCostPerKg: "0.400000",
      });
      // Zero kg falls back to the stored cost per kg.
      expect(full.body.find((b: { id: number }) => b.id === empty).displayCostPerKg).toBe("0.400000");
    }));

  it("returns historical cost sources with supplier fallbacks", () =>
    withFactoryWorld(async (w) => {
      const parent = await seedBatch(w);
      const child = await seedBatch(w);
      const supplierId = await w.one(
        `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, 'Acme') RETURNING id`,
        [w.companyId]
      );
      await w.q(
        `INSERT INTO factory_mix_batch_sources (mix_batch_id, supplier_id, weight_kg, total_cost, cost_per_kg, source_type)
         VALUES ($1, $2, 5, 2, 0.4, 'SUPPLIER')`,
        [child, supplierId]
      );
      await w.q(
        `INSERT INTO factory_mix_batch_sources (mix_batch_id, source_batch_id, weight_kg, total_cost, cost_per_kg, source_type)
         VALUES ($1, $2, 3, 1.2, 0.4, 'BATCH')`,
        [child, parent]
      );
      const res = await w.agent.get(`/api/factory/mix-batches/cost-sources`);
      expect(res.status).toBe(200);
      const names = res.body.filter((r: { mixBatchId: number }) => r.mixBatchId === child);
      expect(names.map((r: { supplierName: string }) => r.supplierName)).toEqual([
        "Acme",
        expect.stringMatching(/^Source batch: RD/),
      ]);
      expect(names[0].categoryName).toBe("Uncategorized");
    }));
});

describe("single batch", () => {
  it("refuses an invalid id, an unknown id and another company's batch", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.get(`/api/factory/mix-batches/0`)).status).toBe(400);
      expect((await w.agent.get(`/api/factory/mix-batches/2147483000`)).status).toBe(404);
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}O`]
      );
      const foreign = await seedBatch(w, other);
      const res = await w.agent.get(`/api/factory/mix-batches/${foreign}`);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe("Mix batch not found");
    }));

  it("returns the batch with its remaining kilograms", () =>
    withFactoryWorld(async (w) => {
      const id = await seedBatch(w);
      const res = await w.agent.get(`/api/factory/mix-batches/${id}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id, remainingKg: "90.000", status: "OPEN" });
    }));
});
