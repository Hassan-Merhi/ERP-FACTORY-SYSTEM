/**
 * employeePosFinancialRoutes: WorkerCategory endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { factoryWorkerCategories, insertFactoryWorkerCategorySchema } from "@shared/schema";
import { eq, and } from "drizzle-orm";

export function registerWorkerCategoryRoutes(app: Express) {
  // ── Worker Categories ──────────────────────────────────────────────────────
  app.get("/api/factory/worker-categories", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const cats = await db
        .select()
        .from(factoryWorkerCategories)
        .where(eq(factoryWorkerCategories.companyId, companyId))
        .orderBy(factoryWorkerCategories.name);
      res.json(cats);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.post("/api/factory/worker-categories", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const body = insertFactoryWorkerCategorySchema.parse({ ...req.body, companyId });
      const [cat] = await db.insert(factoryWorkerCategories).values(body).returning();
      res.json(cat);
    } catch (e: unknown) {
      res.status(400).json({ message: getErrorMessage(e) });
    }
  });

  app.patch("/api/factory/worker-categories/:id", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      const body = insertFactoryWorkerCategorySchema.partial().parse(req.body);
      const [cat] = await db
        .update(factoryWorkerCategories)
        .set(body)
        .where(and(eq(factoryWorkerCategories.id, id), eq(factoryWorkerCategories.companyId, companyId)))
        .returning();
      if (!cat) return res.status(404).json({ message: "Not found" });
      res.json(cat);
    } catch (e: unknown) {
      res.status(400).json({ message: getErrorMessage(e) });
    }
  });

  app.delete("/api/factory/worker-categories/:id", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      await db
        .delete(factoryWorkerCategories)
        .where(and(eq(factoryWorkerCategories.id, id), eq(factoryWorkerCategories.companyId, companyId)));
      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
