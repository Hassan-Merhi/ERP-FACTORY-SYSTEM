/**
 * factoryProductsRoutes: FactoryCategory endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryCategories, insertFactoryCategorySchema } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  idParams,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../../lib/validateRequest";

// The handler adds companyId from the session, so the body never carries it.
const createCategoryInput = {
  query: emptyQuery,
  body: insertFactoryCategorySchema.omit({ companyId: true }).strict(),
} satisfies RequestSchemas;

// The body is spread into the update; only the editable category fields are accepted.
const updateCategoryInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    name: z.string().optional(),
    nameAr: z.string().nullable().optional(),
    isActive: z.boolean().optional(),
  }),
} satisfies RequestSchemas;

const deleteCategoryInput = { params: idParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerFactoryCategoryRoutes(app: Express) {
  app.get("/api/factory/categories", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const results = await db
        .select()
        .from(factoryCategories)
        .where(and(eq(factoryCategories.companyId, companyId), isNull(factoryCategories.deletedAt)))
        .orderBy(factoryCategories.name);

      res.json(results);
    } catch (error: unknown) {
      logger.error("Error fetching factory categories:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post(
    "/api/factory/categories",
    requireAuth,
    validateRequest(createCategoryInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const parsed = insertFactoryCategorySchema.parse({ ...req.body, companyId });
        const [category] = await db.insert(factoryCategories).values(parsed).returning();
        res.json(category);
      } catch (error: unknown) {
        logger.error("Error creating factory category:", { error: error });
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.patch(
    "/api/factory/categories/:id",
    requireAuth,
    validateRequest(updateCategoryInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { id } = validatedInput(req, updateCategoryInput).params;
        const [updated] = await db
          .update(factoryCategories)
          .set({ ...req.body, updatedAt: new Date() })
          .where(and(eq(factoryCategories.id, id), eq(factoryCategories.companyId, companyId)))
          .returning();

        if (!updated) return res.status(404).json({ message: "Category not found" });
        res.json(updated);
      } catch (error: unknown) {
        logger.error("Error updating factory category:", { error: error });
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.delete(
    "/api/factory/categories/:id",
    requireAuth,
    validateRequest(deleteCategoryInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { id } = validatedInput(req, deleteCategoryInput).params;
        const [updated] = await db
          .update(factoryCategories)
          .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(factoryCategories.id, id), eq(factoryCategories.companyId, companyId)))
          .returning();

        if (!updated) return res.status(404).json({ message: "Category not found" });
        res.json(updated);
      } catch (error: unknown) {
        logger.error("Error deleting factory category:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
