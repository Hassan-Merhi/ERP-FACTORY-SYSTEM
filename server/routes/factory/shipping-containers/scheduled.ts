/**
 * Factory scheduled containers endpoints, separate from shipping availability.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryScheduledContainers, insertFactoryScheduledContainerSchema } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { getCompanyId } from "./_helpers";

export function registerScheduledContainerRoutes(app: Express) {
  // Company-scoped scheduled container CRUD
  const SCHEDULED_KEY = "/api/factory/scheduled-containers";

  app.get(SCHEDULED_KEY, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const rows = await db
        .select()
        .from(factoryScheduledContainers)
        .where(eq(factoryScheduledContainers.companyId, companyId))
        .orderBy(desc(factoryScheduledContainers.date));
      res.json(rows);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.post(SCHEDULED_KEY, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const parsed = insertFactoryScheduledContainerSchema.safeParse({ ...req.body, companyId });
      if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid data" });
      const [row] = await db.insert(factoryScheduledContainers).values(parsed.data).returning();
      res.json(row);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.patch(`${SCHEDULED_KEY}/:id`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      const { date, shippingCompany, scheduledContainers, note, details, isArchived } = req.body;
      const updates: Record<string, unknown> = {};
      if (date !== undefined) {
        // A blank or unparseable date passed the !== undefined check and
        // reached the date column as-is, failing the query as a 500.
        if (typeof date !== "string" || date.trim() === "" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
          return res.status(400).json({ message: "Invalid request data", field: "date" });
        }
        updates.date = date;
      }
      if (shippingCompany !== undefined) {
        if (typeof shippingCompany !== "string" || !shippingCompany.trim()) {
          return res.status(400).json({ message: "Invalid request data", field: "shippingCompany" });
        }
        updates.shippingCompany = shippingCompany.trim();
      }
      if (scheduledContainers !== undefined) {
        // Number("") is 0 and Number("abc") is NaN; neither belongs in an
        // integer column straight from the request body.
        const parsed = Number(scheduledContainers);
        if (!Number.isInteger(parsed) || parsed < 0) {
          return res.status(400).json({ message: "Invalid request data", field: "scheduledContainers" });
        }
        updates.scheduledContainers = parsed;
      }
      if (note !== undefined) updates.note = note || null;
      if (details !== undefined) updates.details = details || null;
      if (isArchived !== undefined) {
        if (typeof isArchived !== "boolean") {
          return res.status(400).json({ message: "Invalid request data", field: "isArchived" });
        }
        updates.isArchived = isArchived;
        updates.archivedAt = isArchived ? new Date() : null;
      }
      if (Object.keys(updates).length === 0) return res.status(400).json({ message: "No fields to update" });
      const [row] = await db
        .update(factoryScheduledContainers)
        .set(updates)
        .where(and(eq(factoryScheduledContainers.id, id), eq(factoryScheduledContainers.companyId, companyId)))
        .returning();
      if (!row) return res.status(404).json({ message: "Not found" });
      res.json(row);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.delete(`${SCHEDULED_KEY}/:id`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      await db
        .delete(factoryScheduledContainers)
        .where(and(eq(factoryScheduledContainers.id, id), eq(factoryScheduledContainers.companyId, companyId)));
      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
