/**
 * containerLoadedItemsRoutes: ContainerLoadedItemImport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response, RequestHandler } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { parseId } from "../../lib/parseId";
import { buildAliasMap, resolveBarcode } from "../helpers/proformaBarcodeHelpers";
import { poLineItems, purchaseOrders, stockItems, supplierContainerLoadedItems } from "@shared/schema";

import { verifyContainerOwnership } from "./_helpers";

export function registerContainerLoadedItemImportRoutes(app: Express, requireAuth: RequestHandler) {
  app.post("/api/containers/:containerId/import-loaded-items", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const containerId = parseId(req.params.containerId);
      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
      if (!(await verifyContainerOwnership(containerId, companyId)))
        return res.status(403).json({ message: "Access denied" });
      const { items } = req.body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "No items to import" });
      }
      // Resolve alias codes → primary stock-item codes before saving so that
      // items imported with different (supplier) codes match the proforma.
      const { map: aliasMap } = await buildAliasMap(companyId);
      const values = items.map((l) => ({
        containerId,
        barcode: resolveBarcode(String(l.barcode || l.Barcode || "").trim(), aliasMap),
        itemName: String(l.itemName || l["Item Name"] || "").trim() || null,
        qty: parseInt(l.qty || l.Qty || 0) || 0,
        weightPerBale: l.weightPerBale || l["Weight per Bale"] || null,
        pricePerBale: l.pricePerBale || l["Price per Bale"] || null,
      }));
      await db.insert(supplierContainerLoadedItems).values(values);
      const allItems = await db
        .select()
        .from(supplierContainerLoadedItems)
        .where(eq(supplierContainerLoadedItems.containerId, containerId));
      res.json({ imported: values.length, items: allItems });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post(
    "/api/containers/:containerId/auto-populate-loaded-items",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const containerId = parseId(req.params.containerId);
        if (containerId === null) return res.status(400).json({ message: "Invalid id" });
        if (!(await verifyContainerOwnership(containerId, companyId)))
          return res.status(403).json({ message: "Access denied" });

        const existingItems = await db
          .select()
          .from(supplierContainerLoadedItems)
          .where(eq(supplierContainerLoadedItems.containerId, containerId));
        if (existingItems.length > 0) {
          return res
            .status(400)
            .json({ message: "Container already has loaded items. Clear them first to re-populate." });
        }

        const pos = await db.select().from(purchaseOrders).where(eq(purchaseOrders.containerId, containerId));

        if (pos.length === 0) {
          return res.status(400).json({ message: "No purchase orders found for this container" });
        }

        const poIds = pos.map((po) => po.id);
        const lineItems = await db
          .select({
            stockItemCode: stockItems.code,
            itemName: poLineItems.itemName,
            quantity: poLineItems.quantity,
            rate: poLineItems.rate,
            stockItemId: poLineItems.stockItemId,
          })
          .from(poLineItems)
          .leftJoin(stockItems, eq(poLineItems.stockItemId, stockItems.id))
          .where(inArray(poLineItems.poId, poIds));

        if (lineItems.length === 0) {
          return res.status(400).json({ message: "No line items found in purchase orders" });
        }

        const itemsWithBarcode = lineItems.filter((item) => item.stockItemCode && item.stockItemCode.trim() !== "");
        const skippedCount = lineItems.length - itemsWithBarcode.length;

        if (itemsWithBarcode.length === 0) {
          return res.status(400).json({
            message: `All ${lineItems.length} PO items are missing barcodes (stock item codes). Cannot auto-populate.`,
          });
        }

        const values = itemsWithBarcode.map((item) => ({
          containerId,
          barcode: item.stockItemCode!.trim(),
          itemName: item.itemName || null,
          qty: Math.round(parseFloat(item.quantity || "0")),
          weightPerBale: null as string | null,
          pricePerBale: item.rate || null,
        }));

        await db.insert(supplierContainerLoadedItems).values(values);
        const allItems = await db
          .select()
          .from(supplierContainerLoadedItems)
          .where(eq(supplierContainerLoadedItems.containerId, containerId));
        res.json({ imported: values.length, skipped: skippedCount, items: allItems });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
