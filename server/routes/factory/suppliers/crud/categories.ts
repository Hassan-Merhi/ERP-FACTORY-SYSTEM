/**
 * supplierCrudRoutes: FactorySupplierCategory endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../../lib/parseId";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { factorySuppliers, factorySupplierCategories, insertFactorySupplierCategorySchema } from "@shared/schema";
import { eq, and, asc } from "drizzle-orm";
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  stringIdParams,
  validateRequest,
  type RequestSchemas,
} from "../../../../lib/validateRequest";

// The create handler still re-parses with the insert schema; companyId comes
// from the session. parseId() still checks the ids.
const createCategoryInput = {
  query: emptyQuery,
  body: insertFactorySupplierCategorySchema.omit({ companyId: true }).strict(),
} satisfies RequestSchemas;

const updateCategoryInput = {
  params: stringIdParams,
  query: emptyQuery,
  body: z.strictObject({
    name: z.string().optional(),
    displayOrder: z.union([z.number(), z.string()]).optional(),
  }),
} satisfies RequestSchemas;

const deleteCategoryInput = {
  params: stringIdParams,
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export function registerFactorySupplierCategoryRoutes(app: Express) {
  app.get("/api/factory/supplier-categories", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const cats = await db
        .select()
        .from(factorySupplierCategories)
        .where(eq(factorySupplierCategories.companyId, companyId))
        .orderBy(asc(factorySupplierCategories.displayOrder), asc(factorySupplierCategories.name));
      res.json(cats);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.post(
    "/api/factory/supplier-categories",
    requireAuth,
    validateRequest(createCategoryInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const parsed = insertFactorySupplierCategorySchema.parse({ ...req.body, companyId });
        const [created] = await db.insert(factorySupplierCategories).values(parsed).returning();
        res.json(created);
      } catch (err: unknown) {
        res.status(400).json({ message: getErrorMessage(err) });
      }
    }
  );

  app.patch(
    "/api/factory/supplier-categories/:id",
    requireAuth,
    validateRequest(updateCategoryInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });
        const { name, displayOrder } = req.body;
        const [updated] = await db
          .update(factorySupplierCategories)
          .set({
            ...(name !== undefined && { name }),
            ...(displayOrder !== undefined && { displayOrder }),
            updatedAt: new Date(),
          })
          .where(and(eq(factorySupplierCategories.id, id), eq(factorySupplierCategories.companyId, companyId)))
          .returning();
        if (!updated) return res.status(404).json({ message: "Category not found" });
        res.json(updated);
      } catch (err: unknown) {
        res.status(400).json({ message: getErrorMessage(err) });
      }
    }
  );

  app.delete(
    "/api/factory/supplier-categories/:id",
    requireAuth,
    validateRequest(deleteCategoryInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });
        // Unassign any suppliers that belong to this category
        await db
          .update(factorySuppliers)
          .set({ supplierCategoryId: null, updatedAt: new Date() })
          .where(and(eq(factorySuppliers.companyId, companyId), eq(factorySuppliers.supplierCategoryId, id)));
        const [deleted] = await db
          .delete(factorySupplierCategories)
          .where(and(eq(factorySupplierCategories.id, id), eq(factorySupplierCategories.companyId, companyId)))
          .returning();
        if (!deleted) return res.status(404).json({ message: "Category not found" });
        res.json({ message: "Category deleted" });
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // ───────────────────────────────────────────────
  // 1c. Factory Supplier Payments
  // ───────────────────────────────────────────────
}
