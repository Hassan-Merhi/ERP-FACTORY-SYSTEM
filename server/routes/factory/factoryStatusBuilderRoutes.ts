import { parseId, parseOptionalId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { resolveRequestCompanyId } from "../../services/security/requestCompanyScope";
import { statusReportTemplates, statusMetrics, statusReportRuns, statusMetricValues } from "@shared/schema";
import { eq, and, asc } from "drizzle-orm";

// ─── Source data stubs ────────────────────────────────────────────────────────
// Returns deterministic mock values per (sourceType, date).
// Replace these stubs with real DB queries when integrating with factory data.
async function fetchLinkedValue(
  _companyId: number,
  sourceType: string,
  _sourceField: string,
  operation: string,
  runDate: string
): Promise<{ value: number; warnings: string[] }> {
  if (sourceType === "manual") return { value: 0, warnings: [] };

  // Deterministic seed from date string so the same date always gives the same value
  const seed = runDate
    .replace(/-/g, "")
    .split("")
    .reduce((a, c) => a + c.charCodeAt(0), 0);

  let value = 0;
  if (sourceType === "production") value = 350 + ((seed * 7) % 200);
  if (sourceType === "stock_in") value = 80 + ((seed * 3) % 150);
  if (sourceType === "gate") {
    const inVal = 200 + ((seed * 11) % 180);
    const outVal = 100 + ((seed * 5) % 120);
    value = operation === "in_minus_out" ? inVal - outVal : inVal;
  }

  return {
    value,
    warnings: ["Source integration pending — showing estimated data for this date"],
  };
}

export function registerFactoryStatusBuilderRoutes(app: Express) {
  // ── GET /api/factory/status-builder/template?companyId=X ──────────────────
  // Returns (or creates) the default template + seed metrics for a company.
  app.get("/api/factory/status-builder/template", requireAuth, async (req, res) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      if (!companyId) return res.status(400).json({ error: "companyId required" });

      let [template] = await db
        .select()
        .from(statusReportTemplates)
        .where(eq(statusReportTemplates.companyId, companyId))
        .limit(1);

      if (!template) {
        const [created] = await db
          .insert(statusReportTemplates)
          .values({ companyId, name: "Default Template" })
          .returning();
        template = created;

        // Seed with the three sample metrics specified in the requirements
        await db.insert(statusMetrics).values([
          {
            templateId: created.id,
            name: "Production",
            beforeSourceType: "manual",
            sourceType: "production",
            sourceField: "quantity",
            operation: "sum",
            filtersJson: {},
            sortOrder: 0,
          },
          {
            templateId: created.id,
            name: "Stock In",
            beforeSourceType: "manual",
            sourceType: "stock_in",
            sourceField: "quantity",
            operation: "sum",
            filtersJson: {},
            sortOrder: 1,
          },
          {
            templateId: created.id,
            name: "In / Out Gate",
            beforeSourceType: "manual",
            sourceType: "gate",
            sourceField: "quantity",
            operation: "in_minus_out",
            filtersJson: {},
            sortOrder: 2,
          },
        ]);
      }

      res.json(template);
    } catch (err: unknown) {
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // ── PATCH /api/factory/status-builder/templates/:id ───────────────────────
  app.patch("/api/factory/status-builder/templates/:id", requireAuth, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { name } = req.body;
      const [updated] = await db
        .update(statusReportTemplates)
        .set({ name, updatedAt: new Date() })
        .where(eq(statusReportTemplates.id, id))
        .returning();
      res.json(updated);
    } catch (err: unknown) {
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // ── GET /api/factory/status-builder/templates/:id/metrics ─────────────────
  app.get("/api/factory/status-builder/templates/:id/metrics", requireAuth, async (req, res) => {
    try {
      const templateId = parseId(req.params.id);
      if (templateId === null) return res.status(400).json({ message: "Invalid id" });
      const metrics = await db
        .select()
        .from(statusMetrics)
        .where(eq(statusMetrics.templateId, templateId))
        .orderBy(asc(statusMetrics.sortOrder));
      res.json(metrics);
    } catch (err: unknown) {
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // ── POST /api/factory/status-builder/metrics ──────────────────────────────
  app.post("/api/factory/status-builder/metrics", requireAuth, async (req, res) => {
    try {
      const { templateId, name, beforeSourceType, sourceType, sourceField, operation, filtersJson, sortOrder } =
        req.body;
      // template_id and name are both NOT NULL and neither was validated, so a
      // body without them failed the insert as a 500 instead of a 400.
      if (!Number.isInteger(templateId)) {
        return res.status(400).json({ error: "templateId is required and must be an integer" });
      }
      if (typeof name !== "string" || name.trim() === "") {
        return res.status(400).json({ error: "name is required" });
      }
      const [metric] = await db
        .insert(statusMetrics)
        .values({
          templateId,
          name,
          beforeSourceType: beforeSourceType ?? "manual",
          sourceType: sourceType ?? "manual",
          sourceField: sourceField ?? "quantity",
          operation: operation ?? "sum",
          filtersJson: filtersJson ?? {},
          sortOrder: sortOrder ?? 0,
        })
        .returning();
      res.json(metric);
    } catch (err: unknown) {
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // ── PATCH /api/factory/status-builder/metrics/:id ─────────────────────────
  app.patch("/api/factory/status-builder/metrics/:id", requireAuth, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { name, beforeSourceType, sourceType, sourceField, operation, filtersJson, sortOrder } = req.body;
      // A body carrying none of these fields left every value undefined, so the
      // update reached drizzle as .set({}) — "No values to set", a 500.
      const updates = {
        ...(name !== undefined && { name }),
        ...(beforeSourceType !== undefined && { beforeSourceType }),
        ...(sourceType !== undefined && { sourceType }),
        ...(sourceField !== undefined && { sourceField }),
        ...(operation !== undefined && { operation }),
        ...(filtersJson !== undefined && { filtersJson }),
        ...(sortOrder !== undefined && { sortOrder }),
      };
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ message: "No fields to update" });
      }
      const [updated] = await db.update(statusMetrics).set(updates).where(eq(statusMetrics.id, id)).returning();
      if (!updated) return res.status(404).json({ message: "Metric not found" });
      res.json(updated);
    } catch (err: unknown) {
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // ── DELETE /api/factory/status-builder/metrics/:id ────────────────────────
  app.delete("/api/factory/status-builder/metrics/:id", requireAuth, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      // Remove any stored values for this metric before deleting
      await db.delete(statusMetricValues).where(eq(statusMetricValues.metricId, id));
      await db.delete(statusMetrics).where(eq(statusMetrics.id, id));
      res.json({ success: true });
    } catch (err: unknown) {
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // ── GET /api/factory/status-builder/run?templateId=X&date=YYYY-MM-DD ──────
  // Returns (or creates) the run for a template+date, plus all metric values.
  app.get("/api/factory/status-builder/run", requireAuth, async (req, res) => {
    try {
      const templateId = parseOptionalId(req.query.templateId);
      const runDate = req.query.date as string;
      if (!templateId || !runDate) return res.status(400).json({ error: "templateId and date required" });

      const [template] = await db.select().from(statusReportTemplates).where(eq(statusReportTemplates.id, templateId));
      if (!template) return res.status(404).json({ error: "Template not found" });

      let [run] = await db
        .select()
        .from(statusReportRuns)
        .where(and(eq(statusReportRuns.templateId, templateId), eq(statusReportRuns.runDate, runDate)));

      if (!run) {
        const [created] = await db
          .insert(statusReportRuns)
          .values({ templateId, companyId: template.companyId, runDate })
          .returning();
        run = created;
      }

      // Ensure a value row exists for each metric
      const metrics = await db
        .select()
        .from(statusMetrics)
        .where(eq(statusMetrics.templateId, templateId))
        .orderBy(asc(statusMetrics.sortOrder));

      const existing = await db.select().from(statusMetricValues).where(eq(statusMetricValues.runId, run.id));

      const existingIds = new Set(existing.map((v) => v.metricId));
      const missing = metrics.filter((m) => !existingIds.has(m.id));

      if (missing.length > 0) {
        await db.insert(statusMetricValues).values(
          missing.map((m) => ({
            runId: run.id,
            metricId: m.id,
            beforeValue: "0",
            linkedValue: "0",
            manualAdjustment: "0",
            difference: "0",
            finalTotal: "0",
            warningsJson: [],
          }))
        );
      }

      const values = await db.select().from(statusMetricValues).where(eq(statusMetricValues.runId, run.id));
      res.json({ run, values });
    } catch (err: unknown) {
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // ── POST /api/factory/status-builder/runs/:id/refresh ────────────────────
  // Re-fetches all linked source values; manual adjustments are preserved.
  app.post("/api/factory/status-builder/runs/:id/refresh", requireAuth, async (req, res) => {
    try {
      const runId = parseId(req.params.id);
      if (runId === null) return res.status(400).json({ message: "Invalid id" });
      const [run] = await db.select().from(statusReportRuns).where(eq(statusReportRuns.id, runId));
      if (!run) return res.status(404).json({ error: "Run not found" });

      const metrics = await db
        .select()
        .from(statusMetrics)
        .where(eq(statusMetrics.templateId, run.templateId))
        .orderBy(asc(statusMetrics.sortOrder));

      const existingValues = await db.select().from(statusMetricValues).where(eq(statusMetricValues.runId, runId));
      const byMetricId = new Map(existingValues.map((v) => [v.metricId, v]));
      const now = new Date();

      for (const metric of metrics) {
        const existing = byMetricId.get(metric.id);
        const manualAdj = parseFloat(existing?.manualAdjustment ?? "0") || 0;
        const beforeVal = parseFloat(existing?.beforeValue ?? "0") || 0;

        const { value: linked, warnings } = await fetchLinkedValue(
          run.companyId,
          metric.sourceType,
          metric.sourceField,
          metric.operation,
          run.runDate
        );

        const difference = linked + manualAdj;
        const finalTotal = beforeVal + difference;

        if (existing) {
          await db
            .update(statusMetricValues)
            .set({
              linkedValue: linked.toString(),
              difference: difference.toString(),
              finalTotal: finalTotal.toString(),
              warningsJson: warnings,
              lastRefreshed: now,
              updatedAt: now,
            })
            .where(eq(statusMetricValues.id, existing.id));
        } else {
          await db.insert(statusMetricValues).values({
            runId,
            metricId: metric.id,
            beforeValue: "0",
            linkedValue: linked.toString(),
            manualAdjustment: "0",
            difference: difference.toString(),
            finalTotal: finalTotal.toString(),
            warningsJson: warnings,
            lastRefreshed: now,
          });
        }
      }

      await db.update(statusReportRuns).set({ updatedAt: now }).where(eq(statusReportRuns.id, runId));
      const updated = await db.select().from(statusMetricValues).where(eq(statusMetricValues.runId, runId));
      res.json({ values: updated });
    } catch (err: unknown) {
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // ── PATCH /api/factory/status-builder/runs/:runId/values ─────────────────
  // Saves before values and manual adjustments; recalculates difference + finalTotal.
  app.patch("/api/factory/status-builder/runs/:runId/values", requireAuth, async (req, res) => {
    try {
      const runId = parseId(req.params.runId);
      if (runId === null) return res.status(400).json({ message: "Invalid id" });
      const { entries } = req.body as {
        entries: { metricId: number; manualAdjustment: number; beforeValue: number }[];
      };
      // A body without an entries array reached the for..of as undefined and
      // threw "entries is not iterable", which surfaced as a 500.
      if (!Array.isArray(entries)) {
        return res.status(400).json({ message: "entries must be an array" });
      }
      if (entries.some((entry) => !Number.isInteger(entry?.metricId))) {
        return res.status(400).json({ message: "each entry requires an integer metricId" });
      }
      const now = new Date();

      for (const entry of entries) {
        const [existing] = await db
          .select()
          .from(statusMetricValues)
          .where(and(eq(statusMetricValues.runId, runId), eq(statusMetricValues.metricId, entry.metricId)))
          .limit(1);

        const linkedVal = parseFloat(existing?.linkedValue ?? "0") || 0;
        const beforeVal = entry.beforeValue ?? 0;
        const manualAdj = entry.manualAdjustment ?? 0;
        const difference = linkedVal + manualAdj;
        const finalTotal = beforeVal + difference;

        if (existing) {
          await db
            .update(statusMetricValues)
            .set({
              beforeValue: beforeVal.toString(),
              manualAdjustment: manualAdj.toString(),
              difference: difference.toString(),
              finalTotal: finalTotal.toString(),
              updatedAt: now,
            })
            .where(eq(statusMetricValues.id, existing.id));
        } else {
          await db.insert(statusMetricValues).values({
            runId,
            metricId: entry.metricId,
            beforeValue: beforeVal.toString(),
            linkedValue: "0",
            manualAdjustment: manualAdj.toString(),
            difference: difference.toString(),
            finalTotal: finalTotal.toString(),
            warningsJson: [],
          });
        }
      }

      const updated = await db.select().from(statusMetricValues).where(eq(statusMetricValues.runId, runId));
      res.json({ values: updated });
    } catch (err: unknown) {
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });
}
