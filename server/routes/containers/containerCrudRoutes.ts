import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireRole, requireNonPOS } from "../../auth";
import { logAudit } from "../_helpers";
import {
  stockItems,
  containers,
  containerOffloads,
  purchaseOrders,
  poLineItems,
  stockGrades,
  stockCategories,
  suppliers,
} from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { hasIntercompanyTradesTable } from "../../lib/intercompanyTradeAvailability";
import { containerDetailVisibilityCondition } from "../../lib/containerDetailVisibilityCondition";
import { registerContainerCrudRoutesPart1 } from "./registerContainerCrudRoutesPart1";
import {
  emptyBody,
  emptyQuery,
  idParams,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../lib/validateRequest";

const deleteContainerInput = { params: idParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerContainerCrudRoutes(app: Express) {
  registerContainerCrudRoutesPart1(app);

  // ── Bulk OTW line-items (replaces N individual /api/containers/:id fan-out) ─
  // MUST be registered BEFORE the /:id route to avoid being swallowed by it.
  app.get("/api/containers/otw-items", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const companyId = req.session.currentCompanyId;

      const rows = await db
        .select({
          stockItemCode: stockItems.code,
          stockItemName: sql<string>`COALESCE(
            CASE WHEN ${stockItems.deletedAt} IS NULL THEN ${stockItems.name} ELSE NULL END,
            ${poLineItems.itemName}
          )`,
          quantity: poLineItems.quantity,
          totalCost: poLineItems.lineTotal,
          rate: poLineItems.rate,
          containerNumber: containers.containerNumber,
          supplierId: containers.supplierId,
          supplierName: sql<string>`COALESCE(${suppliers.legalName}, 'Unknown')`,
          importDate: containers.importDate,
          gradeId: stockItems.gradeId,
          gradeName: stockGrades.name,
          categoryId: stockItems.categoryId,
          categoryName: stockCategories.name,
        })
        .from(containers)
        .innerJoin(purchaseOrders, eq(purchaseOrders.containerId, containers.id))
        .innerJoin(poLineItems, eq(poLineItems.poId, purchaseOrders.id))
        .leftJoin(stockItems, eq(stockItems.id, poLineItems.stockItemId))
        .leftJoin(stockGrades, eq(stockGrades.id, stockItems.gradeId))
        .leftJoin(stockCategories, eq(stockCategories.id, stockItems.categoryId))
        .leftJoin(suppliers, eq(suppliers.id, containers.supplierId))
        .where(and(eq(containers.companyId, companyId), eq(containers.status, "OTW")));

      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get container details with POs, line items, and charges
  app.get("/api/containers/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const containerId = parseId(req.params.id);
      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // The production ERP may not have the optional intercompany tables.
      // Build owner-only SQL in that case, without referencing a missing table.
      const hasTradeTable = await hasIntercompanyTradesTable();
      const [container] = await db
        .select()
        .from(containers)
        .where(containerDetailVisibilityCondition(containerId, companyId, hasTradeTable))
        .limit(1);

      if (!container) {
        return res.status(404).json({ message: "Container not found" });
      }

      const pos = await storage.getPurchaseOrdersByContainerForCompany(containerId, companyId);
      const charges = await storage.getChargesByContainer(containerId);

      // Get line items for all POs
      const allLineItems = await Promise.all(pos.map((po) => storage.getLineItemsByPO(po.id)));

      const posWithItems = pos.map((po, index) => ({
        ...po,
        items: allLineItems[index],
      }));

      // Fetch offload ID so the frontend can link to the offload detail page
      let offloadId: number | null = null;
      if (container.status === "OFFLOADED") {
        const [offloadRow] = await db
          .select({ id: containerOffloads.id })
          .from(containerOffloads)
          .where(eq(containerOffloads.containerId, containerId))
          .limit(1);
        offloadId = offloadRow?.id ?? null;
      }

      res.json({
        container,
        pos: posWithItems,
        charges,
        offloadId,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Offload container to location (ERP only — SP companies must use /api/sp/offload)

  app.delete(
    "/api/containers/:id",
    requireAuth,
    requireRole("Admin"),
    validateRequest(deleteContainerInput),
    async (req, res) => {
      try {
        const { id } = validatedInput(req, deleteContainerInput).params;

        const existingContainer = await storage.getContainerById(id);
        if (!existingContainer) {
          return res.status(404).json({ message: "Container not found" });
        }

        // Verify container belongs to current company
        if (existingContainer.companyId !== req.session.currentCompanyId) {
          return res.status(403).json({
            message: "Access denied: Container belongs to a different company",
          });
        }

        // Phase 21 (B): the delete audit is written on the deletion's transaction.
        await storage.deleteContainer(
          id,
          {
            userId: req.session.userId ?? "unknown",
            username: req.session.username || "unknown",
          },
          async (tx) => {
            await logAudit(
              {
                userId: req.session.userId!,
                username: req.session.username || "unknown",
                companyId: req.session.currentCompanyId!,
                action: "delete",
                tableName: "containers",
                recordId: existingContainer.id,
                recordIdentifier: existingContainer.containerNumber || `Container #${id}`,
                changes: {
                  containerNumber: { old: existingContainer.containerNumber },
                  status: { old: existingContainer.status },
                  importDate: { old: existingContainer.importDate },
                },
              },
              tx
            );
          }
        );
        res.json({ message: "Container deleted successfully" });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Backfill voucher entries for existing POs
}
