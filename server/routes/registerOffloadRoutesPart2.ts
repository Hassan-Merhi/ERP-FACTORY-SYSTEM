// Extracted from ./offloadRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { logger } from "../lib/logger";
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../auth";
import { parseMoneyInput } from "../lib/money";
import { assertActiveCompanyAccess, sendCompanyAccessError } from "../security/companyAccessBoundary";
import { containers } from "@shared/schema";
import {
  financialOperationErrorStatus,
  financialOperationRequestPayload,
  resolveOptionalFinancialOperationKey,
} from "../services/accounting/financialOperationRequest";
import {
  DurableFinancialOperationError,
  financialOperationFingerprint,
  withDurableFinancialOperation,
} from "../services/accounting/durableFinancialOperation";
import {
  applyOffloadOptionalToggleTx,
  OffloadOptionalToggleError,
  type OffloadOptionalToggleOutcome,
} from "../services/containers/offloadOptionalToggle";
import { requestedOptionalState } from "./registerOffloadRoutesPart1";

export function registerOffloadRoutesPart2(app: Express) {
  // Toggle offload optional status — suspends/unsuspends inventory + vouchers without reversing permanently.
  //
  // The effect set lives in applyOffloadOptionalToggleTx so the target state, the
  // row locks, and the replay decision are one transaction-owned unit: a retry or
  // a second simultaneous request cannot remove or restore the offloaded stock a
  // second time. A caller that supplies X-Idempotency-Key/clientRequestId also
  // gets the durable financial-operation replay, so an identical retransmission
  // returns the recorded outcome instead of running again.
  app.post(
    "/api/offloads/:id/toggle-optional",
    requireAuth,
    requireRole("Admin", "Developer", "Owner"),
    async (req, res) => {
      try {
        const access = await assertActiveCompanyAccess(req);
        const offloadId = parseInt(req.params.id);
        if (isNaN(offloadId)) return res.status(400).json({ message: "Invalid offload ID" });

        const requestId = resolveOptionalFinancialOperationKey(req);
        const toggleInput = {
          companyId: access.activeCompanyId,
          offloadId,
          requestedOptional: requestedOptionalState(req.body),
          requestId,
          actorUserId: req.session.userId ?? null,
          actorUsername: req.session.username ?? null,
        };

        if (requestId) {
          const operation = await withDurableFinancialOperation<OffloadOptionalToggleOutcome>(
            {
              companyId: Number(access.activeCompanyId),
              operationName: "container.offload-optional-toggle",
              idempotencyKey: requestId,
              requestFingerprint: financialOperationFingerprint({
                method: req.method,
                path: req.path,
                companyId: Number(access.activeCompanyId),
                body: financialOperationRequestPayload(req.body),
              }),
            },
            async (tx) => ({ value: await applyOffloadOptionalToggleTx(tx, toggleInput) })
          );
          return res.json({
            optional: operation.value.optional,
            replayed: operation.replayed || operation.value.replayed,
            message: operation.value.message,
          });
        }

        const outcome = await db.transaction(async (tx) => applyOffloadOptionalToggleTx(tx, toggleInput));
        res.json({ optional: outcome.optional, replayed: outcome.replayed, message: outcome.message });
      } catch (error: unknown) {
        if (error instanceof OffloadOptionalToggleError) {
          return res.status(error.status).json({ message: error.message, code: error.code });
        }
        if (error instanceof DurableFinancialOperationError) {
          return res.status(financialOperationErrorStatus(error)).json({ message: error.message, code: error.code });
        }
        logger.error("Error toggling offload optional:", { error: error });
        return sendCompanyAccessError(res, error);
      }
    }
  );

  // Container Offload Diagnostics - Analyze PO line items for potential issues
  app.get(
    "/api/containers/:id/offload-diagnostics",
    requireAuth,
    requireRole("Admin", "Developer", "Owner"),
    async (req, res) => {
      try {
        const containerId = parseInt(req.params.id);
        if (isNaN(containerId)) {
          return res.status(400).json({ message: "Invalid container ID" });
        }

        const access = await assertActiveCompanyAccess(req);
        const companyId = access.activeCompanyId;

        // Get container
        const container = await storage.getContainerById(containerId);
        if (!container || container.companyId !== companyId) {
          return res.status(404).json({ message: "Container not found" });
        }

        // Get all POs for this container
        const pos = await storage.getPurchaseOrdersByContainer(containerId);

        const lineItemDetails: Array<{
          poId: number;
          poNumber: string;
          lineItemId: number;
          stockItemId: number | null;
          stockItemCode: string | null;
          stockItemName: string | null;
          quantity: string;
          quantityParsed: number;
          rate: string;
          isValid: boolean;
          issues: string[];
        }> = [];

        const duplicateCheck = new Map<string, number[]>(); // stockItemId -> [lineItemIds]
        let totalQuantity = 0;
        let invalidLineItems = 0;
        let blankQuantities = 0;

        for (const po of pos) {
          const lineItems = await storage.getLineItemsByPO(po.id);

          for (const item of lineItems) {
            const issues: string[] = [];
            const quantityParsed = parseMoneyInput(item.quantity)?.toNumber() ?? NaN;

            // Check for issues
            if (!item.stockItemId || item.stockItemId === 0) {
              issues.push("No stock item assigned");
              invalidLineItems++;
            }

            if (isNaN(quantityParsed) || item.quantity === "" || item.quantity === null) {
              issues.push("Blank or invalid quantity");
              blankQuantities++;
            } else if (quantityParsed <= 0) {
              issues.push("Zero or negative quantity");
            } else {
              totalQuantity += quantityParsed;
            }

            // Track for duplicate detection
            if (item.stockItemId && item.stockItemId !== 0) {
              const key = `${po.id}-${item.stockItemId}`;
              if (!duplicateCheck.has(key)) {
                duplicateCheck.set(key, []);
              }
              duplicateCheck.get(key)!.push(item.id);
            }

            // Get stock item details
            let stockItemCode: string | null = null;
            let stockItemName: string | null = null;
            if (item.stockItemId) {
              const stockItem = await storage.getStockItemById(item.stockItemId);
              if (stockItem) {
                stockItemCode = stockItem.code;
                stockItemName = stockItem.name;
              }
            }

            lineItemDetails.push({
              poId: po.id,
              poNumber: po.poNumber || `PO-${po.id}`,
              lineItemId: item.id,
              stockItemId: item.stockItemId,
              stockItemCode,
              stockItemName,
              quantity: item.quantity,
              quantityParsed: isNaN(quantityParsed) ? 0 : quantityParsed,
              rate: item.rate,
              isValid: issues.length === 0,
              issues,
            });
          }
        }

        // Check for duplicates
        const duplicates: Array<{ stockItemId: number; poId: number; lineItemIds: number[] }> = [];
        for (const [key, lineItemIds] of Array.from(duplicateCheck.entries())) {
          if (lineItemIds.length > 1) {
            const [poId, stockItemId] = key.split("-").map(Number);
            duplicates.push({ stockItemId, poId, lineItemIds });

            // Mark duplicates in lineItemDetails
            for (const detail of lineItemDetails) {
              if (lineItemIds.includes(detail.lineItemId)) {
                detail.issues.push(`Duplicate: ${lineItemIds.length} entries for same stock item in same PO`);
                detail.isValid = false;
              }
            }
          }
        }

        // Check existing inventory for pre-sales
        const inventoryWarnings: Array<{
          stockItemId: number;
          stockItemCode: string;
          currentQty: number;
          incomingQty: number;
          resultQty: number;
        }> = [];

        // Group by stock item
        const stockItemTotals = new Map<number, number>();
        for (const item of lineItemDetails) {
          if (item.stockItemId && item.isValid) {
            stockItemTotals.set(item.stockItemId, (stockItemTotals.get(item.stockItemId) || 0) + item.quantityParsed);
          }
        }

        res.json({
          containerId,
          containerNumber: container.containerNumber,
          containerStatus: container.status,
          poCount: pos.length,
          lineItemCount: lineItemDetails.length,
          totalQuantity,
          invalidLineItems,
          blankQuantities,
          duplicateCount: duplicates.length,
          duplicates,
          lineItems: lineItemDetails,
          inventoryWarnings,
          hasIssues: invalidLineItems > 0 || blankQuantities > 0 || duplicates.length > 0,
          summary: {
            valid: lineItemDetails.filter((i) => i.isValid).length,
            invalid: lineItemDetails.filter((i) => !i.isValid).length,
          },
        });
      } catch (error: unknown) {
        logger.error("Container offload diagnostics error:", { error: error });
        return sendCompanyAccessError(res, error);
      }
    }
  );

  // Get all containers for diagnostics selection
  app.get("/api/admin/containers-for-diagnostics", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const allContainers = await db
        .select({
          id: containers.id,
          containerNumber: containers.containerNumber,
          status: containers.status,
          itemsTotal: containers.itemsTotal,
        })
        .from(containers)
        .where(eq(containers.companyId, companyId))
        .orderBy(desc(containers.id));

      res.json(allContainers);
    } catch (error: unknown) {
      logger.error("Get containers for diagnostics error:", { error: error });
      return sendCompanyAccessError(res, error);
    }
  });
}
