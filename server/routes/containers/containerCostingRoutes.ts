import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import type { Express } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { stockItems, containers, purchaseOrders, poLineItems } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";

export function registerContainerCostingRoutes(app: Express) {
  app.post("/api/containers/:id/price-import/preview", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const containerId = parseId(req.params.id);

      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
      const rows: { barcode: string; price: string }[] = req.body.rows || [];
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: "No rows provided" });
      }

      // Get all POs for this container
       const container = await storage.getContainerByIdForCompany(containerId, companyId);
       if (!container) return res.status(404).json({ message: "Container not found" });
       const containerPOs = await storage.getPurchaseOrdersByContainerForCompany(containerId, companyId);
      if (containerPOs.length === 0) {
        return res.status(400).json({ message: "No purchase orders found for this container" });
      }
      const poIds = containerPOs.map((po) => po.id);

      // Load all line items for those POs in one query
      const allLineItems =
        poIds.length > 0
          ? await db
              .select({
                id: poLineItems.id,
                poId: poLineItems.poId,
                stockItemId: poLineItems.stockItemId,
                itemName: poLineItems.itemName,
                quantity: poLineItems.quantity,
                rate: poLineItems.rate,
                stockItemCode: stockItems.code,
              })
              .from(poLineItems)
              .leftJoin(stockItems, eq(poLineItems.stockItemId, stockItems.id))
              .where(inArray(poLineItems.poId, poIds))
          : [];

      const preview = await Promise.all(
        rows.map(async (row) => {
          const barcode = String(row.barcode || "").trim();
          const newRate = parseFloat(String(row.price || ""));
          if (!barcode) return { barcode, status: "invalid", itemName: null, currentRate: null, newRate: null };
          if (isNaN(newRate) || newRate < 0)
            return { barcode, status: "invalid_price", itemName: null, currentRate: null, newRate: null };

          // Find matching stock item (code or alias)
          const stockItem = await storage.getStockItemByCodeOrAlias(barcode, companyId);
          if (!stockItem) return { barcode, status: "not_found", itemName: null, currentRate: null, newRate };

          // Find matching line items in container POs
          const matched = allLineItems.filter((li) => li.stockItemId === stockItem.id);
          if (matched.length === 0) {
            return { barcode, itemName: stockItem.name, status: "not_in_container", currentRate: null, newRate };
          }

          const lineItemIds = matched.map((li) => li.id);
          const currentRate = parseFloat(matched[0].rate);
          const noChange = Math.abs(currentRate - newRate) < 0.001;

          return {
            barcode,
            itemName: matched[0].itemName || stockItem.name,
            lineItemIds,
            status: noChange ? "no_change" : "will_update",
            currentRate,
            newRate,
          };
        })
      );

      res.json({ preview });
    } catch (error: unknown) {
      logger.error("Error in container price-import preview:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/containers/:id/price-import/apply", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const containerId = parseId(req.params.id);

      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
      const rows: { lineItemIds: number[]; newRate: number }[] = req.body.rows || [];
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: "No rows provided" });
      }

      // Collect all line item IDs to update
      const allLineItemIds = rows.flatMap((r) => r.lineItemIds || []);
      if (allLineItemIds.length === 0) return res.json({ success: true, updated: 0 });

      await db.transaction(async (tx) => {
        // Update each line item with its new rate
        for (const row of rows) {
          const newRate = parseFloat(String(row.newRate));
          if (isNaN(newRate) || newRate < 0) continue;
          for (const lineItemId of row.lineItemIds || []) {
            // Get the current line item to know its quantity
            const [item] = await tx.select().from(poLineItems).where(eq(poLineItems.id, lineItemId)).limit(1);
            if (!item) continue;
            const qty = parseFloat(item.quantity);
            const newLineTotal = qty * newRate;
            await tx
              .update(poLineItems)
              .set({ rate: newRate.toFixed(2), lineTotal: newLineTotal.toFixed(2) })
              .where(eq(poLineItems.id, lineItemId));
          }
        }

        // Recalculate itemsTotal for all affected POs, then the container
         const containerPOs = await storage.getPurchaseOrdersByContainerForCompany(containerId, companyId);
        const _poIds = containerPOs.map((po) => po.id);

        let containerItemsTotal = 0;
        let containerChargesTotal = 0;

        for (const po of containerPOs) {
          const lineItems = await tx.select().from(poLineItems).where(eq(poLineItems.poId, po.id));
          const newItemsTotal = lineItems.reduce((sum: number, li) => sum + parseFloat(li.lineTotal || "0"), 0);
          await tx
            .update(purchaseOrders)
            .set({ itemsTotal: newItemsTotal.toFixed(2) })
            .where(eq(purchaseOrders.id, po.id));
          containerItemsTotal += newItemsTotal;
          containerChargesTotal +=
            parseFloat(po.freight || "0") +
            parseFloat(po.surcharge || "0") +
            parseFloat(po.fumigation || "0") +
            parseFloat(po.documentCharges || "0") -
            parseFloat(po.discount || "0") +
            parseFloat(po.otherCharges || "0");
        }

        await tx
          .update(containers)
          .set({
            itemsTotal: containerItemsTotal.toFixed(2),
            chargesTotal: containerChargesTotal.toFixed(2),
            grandTotal: (containerItemsTotal + containerChargesTotal).toFixed(2),
          })
          .where(eq(containers.id, containerId));
      });

      res.json({ success: true, updated: allLineItemIds.length });
    } catch (error: unknown) {
      logger.error("Error in container price-import apply:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get all accounts (combined from ledgers, bank accounts, fixed assets, and suppliers)
}
