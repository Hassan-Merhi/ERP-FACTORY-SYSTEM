/**
 * /api/factory/status-builder template, metric and run routes
 * (factoryStatusBuilderRoutes) through the real app inside one rolled-back
 * transaction: the default template and its seeded metrics, validation,
 * other-company templates/metrics/runs answering 404 without writes, run
 * creation, refresh (linked values are still the built-in estimates) and
 * saving before values and manual adjustments.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const BASE = "/api/factory/status-builder";

async function foreignTemplate(w: FactoryWorld) {
  const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
    `${w.tag}O`,
  ]);
  const templateId = await w.one(
    `INSERT INTO status_report_templates (company_id, name) VALUES ($1, 'Theirs') RETURNING id`,
    [other]
  );
  const metricId = await w.one(
    `INSERT INTO status_metrics (template_id, name, before_source_type, source_type, source_field, operation, filters_json, sort_order)
     VALUES ($1, 'Their metric', 'manual', 'manual', 'quantity', 'sum', '{}'::jsonb, 0) RETURNING id`,
    [templateId]
  );
  const runId = await w.one(
    `INSERT INTO status_report_runs (template_id, company_id, run_date) VALUES ($1, $2, '2026-06-01') RETURNING id`,
    [templateId, other]
  );
  return { other, templateId, metricId, runId };
}

describe("factory status builder", () => {
  it("creates the default template once with three seeded metrics", () =>
    withFactoryWorld(async (w) => {
      const first = await w.agent.get(`${BASE}/template`);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).toMatchObject({ companyId: w.companyId, name: "Default Template" });
      const second = await w.agent.get(`${BASE}/template`);
      expect(second.body.id).toBe(first.body.id);
      const metrics = await w.agent.get(`${BASE}/templates/${first.body.id}/metrics`);
      expect(metrics.body.map((m: { name: string }) => m.name)).toEqual(["Production", "Stock In", "In / Out Gate"]);
      const renamed = await w.agent.patch(`${BASE}/templates/${first.body.id}`).send({ name: "Daily" });
      expect(renamed.body.name).toBe("Daily");
    }));

  it("refuses bad input and another company's template, metric and run", () =>
    withFactoryWorld(async (w) => {
      const theirs = await foreignTemplate(w);
      const snapshot = async () => ({
        templates: await w.q(`SELECT name FROM status_report_templates WHERE id = $1`, [theirs.templateId]),
        metrics: await w.q(`SELECT name, sort_order FROM status_metrics WHERE template_id = $1`, [theirs.templateId]),
        values: await w.q(`SELECT count(*)::int AS n FROM status_metric_values WHERE run_id = $1`, [theirs.runId]),
      });
      const before = await snapshot();

      expect((await w.agent.patch(`${BASE}/templates/abc`).send({ name: "x" })).status).toBe(400);
      expect((await w.agent.patch(`${BASE}/templates/${theirs.templateId}`).send({ name: "x" })).status).toBe(404);
      expect((await w.agent.get(`${BASE}/templates/abc/metrics`)).status).toBe(400);
      expect((await w.agent.get(`${BASE}/templates/${theirs.templateId}/metrics`)).status).toBe(404);

      const post = (body: Record<string, unknown>) => w.agent.post(`${BASE}/metrics`).send(body);
      expect((await post({ name: "x" })).body.field).toBe("templateId");
      expect((await post({ templateId: theirs.templateId, name: " " })).body.error).toBe("name is required");
      expect((await post({ templateId: theirs.templateId, name: "Mine" })).status).toBe(404);

      expect((await w.agent.patch(`${BASE}/metrics/abc`).send({ name: "x" })).status).toBe(400);
      expect((await w.agent.patch(`${BASE}/metrics/${theirs.metricId}`).send({})).body.message).toBe(
        "No fields to update"
      );
      expect((await w.agent.patch(`${BASE}/metrics/${theirs.metricId}`).send({ sortOrder: 9 })).status).toBe(404);
      expect((await w.agent.patch(`${BASE}/metrics/2147483000`).send({ name: "x" })).status).toBe(404);
      expect((await w.agent.delete(`${BASE}/metrics/abc`)).status).toBe(400);
      expect((await w.agent.delete(`${BASE}/metrics/${theirs.metricId}`)).status).toBe(404);

      expect((await w.agent.get(`${BASE}/run`).query({ date: "2026-06-01" })).status).toBe(400);
      expect(
        (await w.agent.get(`${BASE}/run`).query({ templateId: theirs.templateId, date: "2026-06-01" })).status
      ).toBe(404);
      expect((await w.agent.post(`${BASE}/runs/abc/refresh`).send({})).status).toBe(400);
      expect((await w.agent.post(`${BASE}/runs/${theirs.runId}/refresh`).send({})).status).toBe(404);
      const values = (body: unknown, id: number | string = theirs.runId) =>
        w.agent.patch(`${BASE}/runs/${id}/values`).send(body as object);
      expect((await values({}, "abc")).status).toBe(400);
      expect((await values({})).body.message).toBe("entries must be an array");
      expect((await values({ entries: [{ metricId: "x" }] })).body.field).toBe("entries.metricId");
      expect((await values({ entries: [{ metricId: theirs.metricId, beforeValue: 1 }] })).status).toBe(404);

      expect(await snapshot()).toEqual(before);
    }));

  it("builds a run, refreshes linked estimates and keeps manual adjustments", () =>
    withFactoryWorld(async (w) => {
      const template = (await w.agent.get(`${BASE}/template`)).body;
      const custom = await w.agent.post(`${BASE}/metrics`).send({ templateId: template.id, name: "Manual count" });
      expect(custom.status).toBe(200);
      expect(custom.body).toMatchObject({ sourceType: "manual", operation: "sum", sortOrder: 0 });
      const patched = await w.agent
        .patch(`${BASE}/metrics/${custom.body.id}`)
        .send({ sortOrder: 5, filtersJson: { a: 1 }, sourceField: "kg", beforeSourceType: "manual", operation: "sum" });
      expect(patched.body).toMatchObject({ sortOrder: 5, sourceField: "kg" });

      const run = await w.agent.get(`${BASE}/run`).query({ templateId: template.id, date: "2026-06-01" });
      expect(run.status, JSON.stringify(run.body)).toBe(200);
      expect(run.body.values).toHaveLength(4);
      const again = await w.agent.get(`${BASE}/run`).query({ templateId: template.id, date: "2026-06-01" });
      expect(again.body.run.id).toBe(run.body.run.id);
      expect(again.body.values).toHaveLength(4);
      const runId = run.body.run.id;

      const metrics = (await w.agent.get(`${BASE}/templates/${template.id}/metrics`)).body as Array<{
        id: number;
        name: string;
      }>;
      const byName = new Map(metrics.map((m) => [m.name, m.id]));
      const saved = await w.agent.patch(`${BASE}/runs/${runId}/values`).send({
        entries: [
          { metricId: byName.get("Production"), beforeValue: 10, manualAdjustment: 2 },
          { metricId: byName.get("Manual count") },
        ],
      });
      expect(saved.status).toBe(200);

      // A metric added after the run was built has no value row yet.
      const late = await w.agent.post(`${BASE}/metrics`).send({ templateId: template.id, name: "Late", sortOrder: 9 });
      const refreshed = await w.agent.post(`${BASE}/runs/${runId}/refresh`).send({});
      expect(refreshed.status).toBe(200);
      const value = (id: number) =>
        refreshed.body.values.find((v: { metricId: number }) => v.metricId === id) as Record<string, unknown>;
      const production = value(byName.get("Production")!);
      expect(Number(production.manualAdjustment)).toBe(2);
      expect(Number(production.finalTotal)).toBe(10 + Number(production.linkedValue) + 2);
      expect(production.warningsJson).toEqual(["Source integration pending — showing estimated data for this date"]);
      expect(Number(value(byName.get("Manual count")!).linkedValue)).toBe(0);
      expect(value(late.body.id)).toBeDefined();
      const gate = Number(value(byName.get("In / Out Gate")!).linkedValue);
      expect(gate).toBeGreaterThan(-120);

      // Values for a metric that has none yet are inserted.
      const fresh = await w.agent.post(`${BASE}/metrics`).send({ templateId: template.id, name: "Fresh" });
      const insert = await w.agent
        .patch(`${BASE}/runs/${runId}/values`)
        .send({ entries: [{ metricId: fresh.body.id, beforeValue: 3, manualAdjustment: 1 }] });
      const freshValue = insert.body.values.find((v: { metricId: number }) => v.metricId === fresh.body.id);
      expect(Number(freshValue.finalTotal)).toBe(4);

      const removed = await w.agent.delete(`${BASE}/metrics/${fresh.body.id}`);
      expect(removed.body).toEqual({ success: true });
      const [left] = await w.q(`SELECT count(*)::int AS n FROM status_metric_values WHERE metric_id = $1`, [
        fresh.body.id,
      ]);
      expect(left.n).toBe(0);
    }));
});
