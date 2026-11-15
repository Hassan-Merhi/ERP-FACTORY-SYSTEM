import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import type { Express } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { getAccessibleCompanyIds, isPrivilegedRole } from "../../security/companyAccessBoundary";
import {
  stockItems,
  containers,
  containerCharges,
  purchaseOrders,
  poLineItems,
  suppliers,
  stockItemMergeLogs,
} from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import { toMoney } from "../../lib/money";
import { registerContainerFreightReadRoutesPart1 } from "./registerContainerFreightReadRoutesPart1";

export function registerContainerFreightReadRoutes(app: Express) {
  registerContainerFreightReadRoutesPart1(app);
  registerContainerFreightReadRoutesPart2(app);
}

function registerContainerFreightReadRoutesPart2(app: Express) {
  // ── Global PO / Parent JV sync-all endpoint ──────────────────────────────
  // Scans every PO in the current company, recalculates exact amounts, and
  // updates only mismatched local vouchers + mismatched parent INTERCO-PARENT
  // vouchers. Idempotent — safe to run multiple times.

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
  // Export single container with all details (JSON)

  app.get("/api/purchase-orders/:id", requireAuth, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid purchase order ID" });
      }

      // Check role permissions - only Admin and Owner can view purchase orders
      const userRole = req.session.currentRole;
      if (!userRole || (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer")) {
        return res.status(403).json({ message: "Only Admin and Owner can view purchase orders" });
      }

      const po = await db.query.purchaseOrders.findFirst({
        where: eq(purchaseOrders.id, id),
      });

      if (!po) {
        return res.status(404).json({ message: "Purchase order not found" });
      }

      // Verify the caller belongs to the owning company. Comparing against
      // req.session.currentCompanyId alone refused purchase orders in the
      // caller's other companies, which is a read regression: the company
      // selector chooses a view, membership decides access.
      const accessiblePoCompanyIds = await getAccessibleCompanyIds(req.session.userId!);
      if (!accessiblePoCompanyIds.has(po.companyId)) {
        return res.status(403).json({
          message: "Access denied: Purchase order belongs to a different company",
        });
      }

      // The role gate above reads req.session.currentRole, which is the role
      // held in the *selected* company. While this route only served the
      // selected company that was the same thing. Now that membership in
      // another company is enough to reach the row, it is not: a caller who is
      // Admin here and an ordinary member elsewhere would otherwise read that
      // other company's purchase orders on the strength of this company's
      // role. So for a purchase order outside the selected company, the
      // privileged role is required in the company that owns it.
      if (po.companyId !== req.session.currentCompanyId) {
        const companyRoles = await storage.getUserCompaniesWithRoles(req.session.userId!);
        const isDeveloperAccount = companyRoles.some((entry) => entry.role === "Developer");
        const owningRole = companyRoles.find((entry) => Number(entry.companyId) === po.companyId)?.role;
        if (!isDeveloperAccount && !isPrivilegedRole(owningRole)) {
          return res.status(403).json({
            message: "Access denied: Purchase order belongs to a different company",
          });
        }
      }

      // Get line items for this PO
      const lineItems = await db.query.poLineItems.findMany({
        where: eq(poLineItems.poId, id),
      });

      // Get supplier info
      const supplier = await db.query.suppliers.findFirst({
        where: eq(suppliers.id, po.supplierId),
      });

      // Get container info
      const container = await db.query.containers.findFirst({
        where: eq(containers.id, po.containerId),
      });

      // Check if PO has no charges stored - if so, fetch from containerCharges table
      const poFreight = toMoney(po.freight).toNumber();
      const poSurcharge = toMoney(po.surcharge).toNumber();
      const poFumigation = toMoney(po.fumigation).toNumber();
      const poDocCharges = toMoney(po.documentCharges).toNumber();
      const poDiscount = toMoney(po.discount).toNumber();
      const poOtherCharges = toMoney(po.otherCharges).toNumber();

      const finalCharges = {
        freight: poFreight.toString(),
        surcharge: poSurcharge.toString(),
        fumigation: poFumigation.toString(),
        documentCharges: poDocCharges.toString(),
        discount: poDiscount.toString(),
        otherCharges: poOtherCharges.toString(),
      };

      // If all charges are 0 AND charges haven't been explicitly edited, try to fetch from containerCharges table
      // This ensures that if user edited charges to 0, we respect that instead of showing container charges
      if (
        poFreight === 0 &&
        poSurcharge === 0 &&
        poFumigation === 0 &&
        poDocCharges === 0 &&
        poDiscount === 0 &&
        poOtherCharges === 0 &&
        !po.chargesEdited
      ) {
        const containerChargesData = await db.query.containerCharges.findMany({
          where: eq(containerCharges.containerId, po.containerId),
        });

        for (const charge of containerChargesData) {
          const amount = toMoney(charge.amount).toNumber();
          switch (charge.chargeType) {
            case "Freight":
              finalCharges.freight = Math.abs(amount).toString();
              break;
            case "Surcharge":
              finalCharges.surcharge = Math.abs(amount).toString();
              break;
            case "Fumigation":
              finalCharges.fumigation = Math.abs(amount).toString();
              break;
            case "Document Charges":
              finalCharges.documentCharges = Math.abs(amount).toString();
              break;
            case "Discount":
              finalCharges.discount = Math.abs(amount).toString();
              break;
            case "Other Charges":
              finalCharges.otherCharges = Math.abs(amount).toString();
              break;
          }
        }
      }

      res.json({
        ...po,
        items: lineItems,
        supplierName: supplier?.legalName || "Unknown Supplier",
        supplierCode: supplier?.code || "",
        containerNumber: container?.containerNumber || "",
        ...finalCharges,
        itemsTotal: po.itemsTotal?.toString() || "0",
      });
    } catch (error: unknown) {
      logger.error("Get PO error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
