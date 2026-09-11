/**
 * containerLoadedItemsRoutes: ContainerLoadedItemCrud endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response, RequestHandler } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { parseId } from "../../lib/parseId";
import { buildAliasMap, resolveBarcode } from "../helpers/proformaBarcodeHelpers";
import { supplierContainerLoadedItems } from "@shared/schema";

import { verifyContainerOwnership } from "./_helpers";

export function registerContainerLoadedItemCrudRoutes(app: Express, requireAuth: RequestHandler) {
  app.get("/api/containers/:containerId/loaded-items", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const containerId = parseId(req.params.containerId);
      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
      if (!(await verifyContainerOwnership(containerId, companyId)))
        return res.status(403).json({ message: "Access denied" });
      const items = await db
        .select()
        .from(supplierContainerLoadedItems)
        .where(eq(supplierContainerLoadedItems.containerId, containerId));
      res.json(items);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/containers/:containerId/loaded-items", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const containerId = parseId(req.params.containerId);
      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
      if (!(await verifyContainerOwnership(containerId, companyId)))
        return res.status(403).json({ message: "Access denied" });
      const { barcode, itemName, qty, weightPerBale, pricePerBale } = req.body;
      // Resolve alias code → primary stock-item code before saving so that
      // items entered with supplier/alias codes match the proforma correctly.
      const { map: aliasMap } = await buildAliasMap(companyId);
      const resolvedBarcode = resolveBarcode(String(barcode ?? "").trim(), aliasMap);
      const [item] = await db
        .insert(supplierContainerLoadedItems)
        .values({
          containerId,
          barcode: resolvedBarcode,
          itemName: itemName || null,
          qty: parseInt(qty) || 0,
          weightPerBale: weightPerBale || null,
          pricePerBale: pricePerBale || null,
        })
        .returning();
      res.json(item);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/container-loaded-items/:itemId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const itemId = parseId(req.params.itemId);
      if (itemId === null) return res.status(400).json({ message: "Invalid id" });
      const [item] = await db
        .select()
        .from(supplierContainerLoadedItems)
        .where(eq(supplierContainerLoadedItems.id, itemId));
      if (!item) return res.status(404).json({ message: "Item not found" });
      if (!(await verifyContainerOwnership(item.containerId, companyId)))
        return res.status(403).json({ message: "Access denied" });
      const updates: Partial<typeof supplierContainerLoadedItems.$inferInsert> = {};
      if (req.body.barcode !== undefined) updates.barcode = req.body.barcode;
      if (req.body.itemName !== undefined) updates.itemName = req.body.itemName;
      if (req.body.qty !== undefined) updates.qty = parseInt(req.body.qty) || 0;
      if (req.body.weightPerBale !== undefined) updates.weightPerBale = req.body.weightPerBale;
      if (req.body.pricePerBale !== undefined) updates.pricePerBale = req.body.pricePerBale;
      const [updated] = await db
        .update(supplierContainerLoadedItems)
        .set(updates)
        .where(eq(supplierContainerLoadedItems.id, itemId))
        .returning();
      res.json(updated);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/container-loaded-items/:itemId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const itemId = parseId(req.params.itemId);
      if (itemId === null) return res.status(400).json({ message: "Invalid id" });
      const [item] = await db
        .select()
        .from(supplierContainerLoadedItems)
        .where(eq(supplierContainerLoadedItems.id, itemId));
      if (!item) return res.status(404).json({ message: "Item not found" });
      if (!(await verifyContainerOwnership(item.containerId, companyId)))
        return res.status(403).json({ message: "Access denied" });
      await db.delete(supplierContainerLoadedItems).where(eq(supplierContainerLoadedItems.id, itemId));
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
