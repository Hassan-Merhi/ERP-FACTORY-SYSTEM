// Extracted from ./factoryStatusBuilderRoutes.ts
import { parseId, parseOptionalId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { resolveRequestCompanyId } from "../../services/security/requestCompanyScope";
import { statusReportTemplates, statusMetrics, statusReportRuns, statusMetricValues } from "@shared/schema";
import { eq, and, asc } from "drizzle-orm";

// Templates and runs carry a company; metrics and values hang off them. Every
// route below resolves its target through these so an id from another
// company answers 404 instead of being read or written.
async function ownTemplate(templateId: number, companyId: number) {
  const [template] = await db
    .select()
    .from(statusReportTemplates)
    .where(and(eq(statusReportTemplates.id, templateId), eq(statusReportTemplates.companyId, companyId)));
  return template;
}

async function ownMetric(metricId: number, companyId: number) {
  const [metric] = await db.select().from(statusMetrics).where(eq(statusMetrics.id, metricId));
  return metric && (await ownTemplate(metric.templateId, companyId)) ? metric : undefined;
}

export function registerFactoryStatusBuilderRoutesPart1(app: Express) {
  // ── PATCH /api/factory/status-builder/templates/:id ───────────────────────
  app.patch("/api/factory/status-builder/templates/:id", requireAuth, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const companyId = resolveRequestCompanyId(req);
      if (!companyId) return res.status(400).json({ error: "companyId required" });
      if (!(await ownTemplate(id, companyId))) return res.status(404).json({ error: "Template not found" });
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
      const companyId = resolveRequestCompanyId(req);
      if (!companyId) return res.status(400).json({ error: "companyId required" });
      if (!(await ownTemplate(templateId, companyId))) return res.status(404).json({ error: "Template not found" });
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
        return res.status(400).json({ error: "Invalid request data", field: "templateId" });
      }
      if (typeof name !== "string" || name.trim() === "") {
        return res.status(400).json({ error: "name is required" });
      }
      const companyId = resolveRequestCompanyId(req);
      if (!companyId) return res.status(400).json({ error: "companyId required" });
      if (!(await ownTemplate(templateId, companyId))) return res.status(404).json({ error: "Template not found" });
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
      const companyId = resolveRequestCompanyId(req);
      if (!companyId) return res.status(400).json({ error: "companyId required" });
      if (!(await ownMetric(id, companyId))) return res.status(404).json({ message: "Not found" });
      const [updated] = await db.update(statusMetrics).set(updates).where(eq(statusMetrics.id, id)).returning();
      if (!updated) return res.status(404).json({ message: "Not found" });
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
      const companyId = resolveRequestCompanyId(req);
      if (!companyId) return res.status(400).json({ error: "companyId required" });
      if (!(await ownMetric(id, companyId))) return res.status(404).json({ message: "Not found" });
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

      const companyId = resolveRequestCompanyId(req);
      if (!companyId) return res.status(400).json({ error: "companyId required" });
      const template = await ownTemplate(templateId, companyId);
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
}
