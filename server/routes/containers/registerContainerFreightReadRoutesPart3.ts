// Extracted from ./containerFreightReadRoutes.ts
import { parseId } from "../../lib/parseId";
import { logger } from "../../lib/logger";
import type { Express } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import { stockItems, poLineItems, stockItemMergeLogs } from "@shared/schema";
import { inArray } from "drizzle-orm";

export function registerContainerFreightReadRoutesPart3(app: Express) {
  app.get("/api/containers/:id/purchase-orders", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ message: "Not authenticated" });
      }

      const containerId = parseId(req.params.id);

      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(containerId)) {
        return res.status(400).json({ message: "Invalid container ID" });
      }

      // Authorized against every company this user belongs to, not just the
      // active one. Scoping the lookup to req.session.currentCompanyId made a
      // container owned by another of the caller's own companies answer 404,
      // which is a read regression rather than isolation: membership, not the
      // company selector, is what grants access here.
      const container = await storage.getContainerById(containerId);

      if (!container) {
        return res.status(404).json({ message: "Container not found" });
      }

      const accessibleCompanyIds = await getAccessibleCompanyIds(userId);
      if (!accessibleCompanyIds.has(container.companyId)) {
        // Same 404 as a missing container, so a non-member cannot use the
        // status code to discover that this id exists.
        return res.status(404).json({ message: "Container not found" });
      }

      const supplier = await storage.getSupplierById(container.supplierId);
      // Scoped to the container's own company — the one just authorized —
      // rather than the session's active company, so the rows cannot span
      // tenants even if a container id were ever reused across them.
      const purchaseOrders = await storage.getPurchaseOrdersByContainerForCompany(containerId, container.companyId);

      // Batch-fetch all line items and stock items in 2 queries instead of N*M
      const poIds = purchaseOrders.map((po) => po.id);
      const [allLineItems, allStockItems] =
        poIds.length > 0
          ? await Promise.all([
              db.select().from(poLineItems).where(inArray(poLineItems.poId, poIds)).execute(),
              db
                .select({
                  id: stockItems.id,
                  code: stockItems.code,
                  name: stockItems.name,
                  deletedAt: stockItems.deletedAt,
                })
                .from(stockItems)
                .where(
                  inArray(stockItems.id, [
                    ...new Set(
                      (
                        await db
                          .select({ id: poLineItems.stockItemId })
                          .from(poLineItems)
                          .where(inArray(poLineItems.poId, poIds))
                          .execute()
                      )
                        .map((r) => r.id)
                        .filter(Boolean) as number[]
                    ),
                  ])
                )
                .execute(),
            ])
          : [[], []];

      const stockItemMap = new Map(allStockItems.map((s) => [s.id, s]));

      // Resolve deleted stock items → kept items via merge logs so OTW shows current names
      const deletedItemIds = allStockItems.filter((s) => s.deletedAt != null).map((s) => s.id);
      if (deletedItemIds.length > 0) {
        const mergeLogs = await db
          .select()
          .from(stockItemMergeLogs)
          .where(inArray(stockItemMergeLogs.mergedItemId, deletedItemIds));
        if (mergeLogs.length > 0) {
          const keptIds = [...new Set(mergeLogs.map((l) => l.keptItemId))];
          const keptItems = await db
            .select({
              id: stockItems.id,
              code: stockItems.code,
              name: stockItems.name,
              deletedAt: stockItems.deletedAt,
            })
            .from(stockItems)
            .where(inArray(stockItems.id, keptIds));
          const keptMap = new Map(keptItems.map((s) => [s.id, s]));
          for (const log of mergeLogs) {
            const kept = keptMap.get(log.keptItemId);
            if (kept) stockItemMap.set(log.mergedItemId, kept);
          }
        }
      }
      const lineItemsByPO = new Map<number, typeof allLineItems>();
      for (const li of allLineItems) {
        const arr = lineItemsByPO.get(li.poId!) || [];
        arr.push(li);
        lineItemsByPO.set(li.poId!, arr);
      }

      const posWithItems = purchaseOrders.map((po) => {
        const lineItemsForPO = lineItemsByPO.get(po.id) || [];
        const itemsWithNames = lineItemsForPO.map((item) => {
          const stockItem = item.stockItemId ? stockItemMap.get(item.stockItemId) : null;
          return {
            stockItemCode: stockItem?.code || "",
            stockItemName: stockItem?.name || item.itemName,
            quantity: item.quantity,
            rate: item.rate,
            lineTotal: item.lineTotal,
          };
        });
        return {
          id: po.id,
          poNumber: po.poNumber,
          currency: po.currency,
          itemsTotal: po.itemsTotal,
          freight: po.freight,
          surcharge: po.surcharge,
          fumigation: po.fumigation,
          documentCharges: po.documentCharges,
          discount: po.discount,
          otherCharges: po.otherCharges,
          status: po.status,
          lineItems: itemsWithNames,
        };
      });

      res.json({
        container: {
          id: container.id,
          containerNumber: container.containerNumber,
          status: container.status,
          importDate: container.importDate,
          grandTotal: container.grandTotal,
        },
        supplier: supplier ? { id: supplier.id, legalName: supplier.legalName } : null,
        purchaseOrders: posWithItems,
      });
    } catch (error) {
      logger.error("Error fetching container POs:", { error: error });
      res.status(500).json({ message: "Failed to fetch purchase orders" });
    }
  });
}
