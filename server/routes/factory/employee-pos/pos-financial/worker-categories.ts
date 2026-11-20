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
import {
  filterActiveFactoryWorkerIds,
  pruneInactiveFactoryWorkerCategoryMembers,
} from "../../../../lib/factoryWorkerCategoryMembership";
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  stringParam,
  validateRequest,
  type RequestSchemas,
} from "../../../../lib/validateRequest";

// Request shapes for validateRequest. The handlers still parse with
// insertFactoryWorkerCategorySchema, which applies the defaults and answers
// its own 400s.
const categoryParams = z.strictObject({ id: stringParam });
const createCategoryInput = {
  query: emptyQuery,
  body: z.strictObject({ name: z.string(), workerIds: z.array(z.number()).optional() }),
} satisfies RequestSchemas;
const updateCategoryInput = {
  params: categoryParams,
  query: emptyQuery,
  body: z.strictObject({
    name: z.string().optional(),
    workerIds: z.array(z.number()).optional(),
    // The update schema has always accepted and written companyId (no client sends it).
    companyId: z.number().optional(),
  }),
} satisfies RequestSchemas;
const deleteCategoryInput = { params: categoryParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerWorkerCategoryRoutes(app: Express) {
  // ── Worker Categories ──────────────────────────────────────────────────────
  app.get(
    "/api/factory/worker-categories",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        // Keep categories active-only, including cleaning any legacy stale memberships.
        const cats = await pruneInactiveFactoryWorkerCategoryMembers(db, companyId);
        res.json(cats);
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  app.post(
    "/api/factory/worker-categories",
    requireAuth,
    validateRequest(createCategoryInput),
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const parsed = insertFactoryWorkerCategorySchema.parse({ ...req.body, companyId });
        const body = {
          ...parsed,
          workerIds: await filterActiveFactoryWorkerIds(db, companyId, parsed.workerIds),
        };
        const [cat] = await db.insert(factoryWorkerCategories).values(body).returning();
        res.json(cat);
      } catch (e: unknown) {
        res.status(400).json({ message: getErrorMessage(e) });
      }
    }
  );

  app.patch(
    "/api/factory/worker-categories/:id",
    requireAuth,
    validateRequest(updateCategoryInput),
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const id = parseInt(req.params.id);
        const parsed = insertFactoryWorkerCategorySchema.partial().parse(req.body);
        const body =
          parsed.workerIds === undefined
            ? parsed
            : {
                ...parsed,
                workerIds: await filterActiveFactoryWorkerIds(db, companyId, parsed.workerIds),
              };
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
    }
  );

  app.delete(
    "/api/factory/worker-categories/:id",
    requireAuth,
    validateRequest(deleteCategoryInput),
    async (req: import("express").Request, res: import("express").Response) => {
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
    }
  );
}
