/**
 * fiscalTransferRoutes: StockTransferCreate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import { offlineEdgeText } from "../../i18n/offlineEdgeMessages";
import type { Express, Request } from "express";
import { getErrorMessage, getErrorStack } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { getClientDate } from "../../lib/dateUtils";
import { logger } from "../../lib/logger";
import { inventory, locations } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { parseMoneyInput, toMoney } from "../../lib/money";
import { allStockItemsOwned, ownLocationIds } from "../helpers/companyOwnership";
import { sendTransferWhatsApp } from "../../helpers/sendTransferWhatsApp";
import { getActiveCompanyPermissionContext } from "../../services/security/activeCompanyPermissionContext";
import { DuplicateStockTransferError, StockTransferPolicyError } from "../../storage/stock-ops/transfers-create";
import { createStockTransferTx } from "../../services/inventory/createStockTransfer";
import { isPhase9LanPrimary } from "../../edge/phase9PosOutbox";
import { capturePhase9StockTransferTx } from "../../edge/phase9StockOutbox";
import { stockTransferEvidence } from "./stockTransferOfflineEvidence";
import { sendBaleMirrorMovementRefusal } from "../../services/accounting/perpetualInventory/cutoverRefusal";
import {
  resolveStockDocumentRequestId,
  StockDocumentIdempotencyError,
} from "../../services/inventory/stockDocumentIdempotency";

async function resolvePosTransferRecipientLocationId(req: Request): Promise<number | null> {
  const context = await getActiveCompanyPermissionContext(req);
  if (context.role !== "POS" || !context.assignedLocationId) {
    return null;
  }
  return context.assignedLocationId;
}

export function registerStockTransferCreateRoutes(app: Express) {
  // Stock Transfers - POST endpoint (supports both creating new and using existing voucher)
  app.post("/api/stock-transfers", requireAuth, async (req, res) => {
    const _t = Date.now();
    const _uid = req.session.userId;
    const _cid = req.session.currentCompanyId;
    try {
      logger.info("stock transfer create started", {
        module: "stockTransfer",
        action: "create",
        userId: _uid,
        companyId: _cid,
      });
      const {
        voucherId,
        sourceLocationId,
        destinationLocationId,
        notes,
        items,
        allowNegativeInventory,
        voucherDate,
        optional,
        clientRequestId,
        workflowOrigin,
      } = req.body;
      // Only the dedicated order screen emits this marker. Do not infer it from editable voucher notes.
      if (workflowOrigin !== undefined && workflowOrigin !== "stock_transfer_order") {
        return res.status(400).json({ message: "Unsupported stock transfer workflow origin" });
      }
      if (workflowOrigin === "stock_transfer_order" &&
          !/^Stock Transfer Order - [0-9]+ items$/.test(String(notes ?? "").trim())) {
        return res.status(400).json({ message: "Stock Transfer Order origin requires an order-created document" });
      }
      const requestId = resolveStockDocumentRequestId(clientRequestId);

      // Log if user confirmed negative inventory override
      if (allowNegativeInventory) {
        logger.info(
          `[AUDIT] User ${req.session.userId} confirmed negative inventory override for stock transfer. Items: ${JSON.stringify(items.map((i: { stockItemId?: unknown; quantity?: unknown; sourceLocationId?: unknown }) => ({ stockItemId: i.stockItemId, quantity: i.quantity, sourceLocationId: i.sourceLocationId })))}`
        );
      }
      const companyId = req.session.currentCompanyId;

      // Branch: Create new transfer from scratch (sourceLocationId provided, no voucherId)
      if (
        !voucherId &&
        (sourceLocationId ||
          (items && items.length > 0 && items.every((i: { sourceLocationId?: unknown }) => i.sourceLocationId)))
      ) {
        if (!companyId) {
          return res.status(400).json({ message: "No company selected" });
        }
        if (!destinationLocationId) {
          return res.status(400).json({ message: "Destination location is required" });
        }
        if (!items || !Array.isArray(items) || items.length === 0) {
          return res.status(400).json({ message: "Items are required" });
        }
        // Input validation assertions for inventory safety
        for (const item of items) {
          const itemSourceId = item.sourceLocationId || sourceLocationId;
          if (!itemSourceId || isNaN(Number(itemSourceId))) {
            return res
              .status(400)
              .json({ message: `Invalid sourceLocationId for item ${item.stockItemId}: ${itemSourceId}` });
          }
          if (!item.stockItemId || isNaN(Number(item.stockItemId))) {
            return res.status(400).json({ message: `Invalid stockItemId: ${item.stockItemId}` });
          }
          const qty = parseMoneyInput(item.quantity);
          if (!qty || !qty.gt(0)) {
            return res.status(400).json({ message: `Invalid quantity for item ${item.stockItemId}: ${item.quantity}` });
          }
        }
        if (isNaN(Number(destinationLocationId))) {
          return res.status(400).json({ message: `Invalid destinationLocationId: ${destinationLocationId}` });
        }

        // Compute multi-source detection
        const uniqueSourceIds = new Set(items.map((i) => i.sourceLocationId || sourceLocationId).filter(Boolean));
        const resolvedHeaderSourceId = uniqueSourceIds.size === 1 ? Array.from(uniqueSourceIds)[0] : null;

        // Validate source/dest not the same (only for single-source mode)
        if (resolvedHeaderSourceId && resolvedHeaderSourceId === destinationLocationId) {
          return res.status(400).json({ message: "Source and destination must be different" });
        }

        // Every location is a body id, outside the path-based company scope:
        // the destination and every source must be locations of this company.
        const ownedLocations = await ownLocationIds(companyId, [
          destinationLocationId,
          sourceLocationId,
          ...items.map((item: { sourceLocationId?: unknown }) => item?.sourceLocationId),
        ]);
        const destLocation = ownedLocations.has(Number(destinationLocationId))
          ? await storage.getLocationById(destinationLocationId)
          : undefined;
        if (!destLocation) {
          return res.status(404).json({ message: "Destination location not found" });
        }
        if (
          items.some(
            (item: { sourceLocationId?: unknown }) =>
              !ownedLocations.has(Number(item?.sourceLocationId || sourceLocationId))
          )
        ) {
          return res.status(404).json({ message: "Source location not found" });
        }
        if (
          !(await allStockItemsOwned(
            companyId,
            items.map((item: { stockItemId?: unknown }) => item?.stockItemId)
          ))
        ) {
          return res.status(400).json({ message: "Stock item not found" });
        }

        // Validate each item has a valid source location
        for (const item of items) {
          const itemSourceId = item.sourceLocationId || sourceLocationId;
          if (!itemSourceId) {
            return res.status(400).json({ message: "Each item must have a source location" });
          }
          if (itemSourceId === destinationLocationId) {
            return res
              .status(400)
              .json({ message: `Item ${item.stockItemId}: Source and destination cannot be the same` });
          }
        }
        // Voucher, items and the journalled inventory movement are created atomically by createStockTransferTx.
        const effectiveDate = voucherDate || getClientDate(req);

        // A transfer moves stock the moment it commits, so a double click or a
        // retried request must not move it twice: createStockTransferTx keys it
        // on the caller's own request id (stockDocumentIdempotencyKey); a caller
        // that sends none is served exactly as before.
        const lanCapture = isPhase9LanPrimary();
        const txResult = await db.transaction(async (tx) => {
          const created = await createStockTransferTx(tx, {
            companyId,
            requestId,
            items,
            sourceLocationId,
            destinationLocationId,
            resolvedHeaderSourceId,
            effectiveDate,
            notes,
            optional,
            allowNegativeInventory,
            actorUserId: _uid,
            workflowOrigin,
          });
          // Factory LAN server during an outage: record the transfer's inputs
          // on the "stock" stream, in this transaction.
          if (lanCapture && !created.replayed) {
            await capturePhase9StockTransferTx(
              tx,
              stockTransferEvidence(req, created, {
                companyId,
                requestId,
                items,
                sourceLocationId,
                destinationLocationId,
                effectiveDate,
                notes,
                optional,
                allowNegativeInventory,
              })
            );
          }
          return created;
        });

        res.status(201).json({
          transfer: txResult.transfer,
          items: txResult.transferItems,
          voucher: txResult.newVoucher,
          replayed: txResult.replayed,
        });

        // Fire-and-forget: POS notifications go to the group configured for
        // the POS user's assigned location, not the transfer destination. A
        // replay already sent it; sending again would notify the branch twice
        // about one delivery.
        if (req.user?.role === "POS" && !txResult.replayed)
          setImmediate(async () => {
            try {
              const recipientLocationId = await resolvePosTransferRecipientLocationId(req);
              if (!recipientLocationId) {
                logger.warn("[TransferWA] POS user has no active assigned location; skipping notification", {
                  userId: req.session.userId,
                  companyId: req.session.currentCompanyId,
                });
                return;
              }
              const waSourceId = txResult.transfer.sourceLocationId;
              let sourceName = "Multiple Sources";
              if (waSourceId) {
                const [srcLoc] = await db
                  .select({ name: locations.name })
                  .from(locations)
                  .where(eq(locations.id, waSourceId));
                if (srcLoc?.name) sourceName = srcLoc.name;
              }
              await sendTransferWhatsApp({
                destinationLocationId,
                recipientLocationId,
                sourceLocationName: sourceName,
                destLocationName: destLocation.name,
                items: txResult.transferItems.map((i) => ({
                  stockItemId: i.stockItemId,
                  quantity: toMoney(i.quantity).toNumber(),
                })),
                voucherNumber: txResult.newVoucher.voucherNumber,
                voucherDate: txResult.newVoucher.voucherDate,
              });
            } catch (e: unknown) {
              logger.error("[TransferWA] Failed to send:", { error: getErrorMessage(e) });
            }
          });
        return;
      }

      // Original flow: Use existing voucher (voucherId required). The factory
      // LAN server records new transfers only; this form stays cloud-only.
      if (isPhase9LanPrimary()) {
        return res.status(409).json({
          code: "EDGE_PHASE9_STOCK_TRANSFER_FORM_CLOUD_ONLY",
          message: offlineEdgeText("stockTransferFormCloudOnly", req.headers["accept-language"]),
        });
      }
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      if (!voucherId) {
        return res.status(400).json({ message: "Either voucherId or sourceLocationId is required" });
      }
      if (!destinationLocationId) {
        return res.status(400).json({ message: "Destination location is required" });
      }
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "Items are required" });
      }

      // Validate that destination location exists
      const destLocation = await storage.getLocationById(destinationLocationId);
      if (!destLocation) {
        return res.status(404).json({ message: "Destination location not found" });
      }

      // Validate that voucher exists
      const voucher = await storage.getVoucherById(voucherId);
      if (!voucher) {
        return res.status(404).json({ message: "Voucher not found" });
      }

      // Validate items and their source locations
      for (const item of items) {
        if (!item.sourceLocationId) {
          return res.status(400).json({ message: "Source location is required for all items" });
        }
        if (!item.stockItemId) {
          return res.status(400).json({ message: "Stock item ID is required for all items" });
        }
        if (!item.quantity || !(parseMoneyInput(item.quantity)?.gt(0) ?? false)) {
          return res.status(400).json({ message: "Quantity must be positive for all items" });
        }
        if (!item.rate || (parseMoneyInput(item.rate)?.lt(0) ?? true)) {
          return res.status(400).json({ message: "Rate must be non-negative for all items" });
        }

        // Validate that source and destination are different for each item
        if (item.sourceLocationId === destinationLocationId) {
          return res.status(400).json({
            message: "Source and destination locations must be different for each item",
          });
        }

        // Validate that source location exists
        const sourceLocation = await storage.getLocationById(item.sourceLocationId);
        if (!sourceLocation) {
          return res.status(404).json({
            message: `Source location with ID ${item.sourceLocationId} not found`,
          });
        }
      }

      logger.info("[Stock Transfer] Creating transfer:", {
        voucherId,
        destinationLocationId,
        itemCount: items.length,
      });

      // Auto-fill rate from inventory for items with no rate (e.g. POS users who don't see cost)
      const itemsWithRate = await Promise.all(
        items.map(async (item) => {
          if (!item.rate || (parseMoneyInput(item.rate)?.isZero() ?? false)) {
            const [invRow] = await db
              .select({ averageRate: inventory.averageRate })
              .from(inventory)
              .where(and(eq(inventory.locationId, item.sourceLocationId), eq(inventory.stockItemId, item.stockItemId)))
              .limit(1);
            return { ...item, rate: String(invRow?.averageRate ?? "0") };
          }
          return { ...item, rate: String(item.rate) };
        })
      );

      const transfer = await storage.createStockTransfer(voucherId, destinationLocationId, notes || "", itemsWithRate, {
        allowNegativeInventory: allowNegativeInventory !== false,
        activeCompanyId: companyId,
      });

      logger.info("[Stock Transfer] Transfer created successfully:", {
        transferId: transfer.transfer.id,
        itemsCount: transfer.items.length,
      });
      logger.info("stock transfer create succeeded", {
        module: "stockTransfer",
        action: "create",
        userId: _uid,
        companyId: _cid,
        durationMs: Date.now() - _t,
      });
      res.status(201).json(transfer);

      // Fire-and-forget: POS notifications go to the group configured for the
      // POS user's assigned location, not the transfer destination.
      if (req.user?.role === "POS")
        setImmediate(async () => {
          try {
            const recipientLocationId = await resolvePosTransferRecipientLocationId(req);
            if (!recipientLocationId) {
              logger.warn("[TransferWA] POS user has no active assigned location; skipping notification", {
                userId: req.session.userId,
                companyId: req.session.currentCompanyId,
              });
              return;
            }
            const uniqueSrcIds = [...new Set(itemsWithRate.map((i) => Number(i.sourceLocationId)).filter(Boolean))];
            let sourceName = "Multiple Sources";
            if (uniqueSrcIds.length === 1) {
              const [srcLoc] = await db
                .select({ name: locations.name })
                .from(locations)
                .where(eq(locations.id, uniqueSrcIds[0]));
              if (srcLoc?.name) sourceName = srcLoc.name;
            }
            await sendTransferWhatsApp({
              destinationLocationId,
              recipientLocationId,
              sourceLocationName: sourceName,
              destLocationName: destLocation.name,
              items: transfer.items.map((i) => ({
                stockItemId: i.stockItemId,
                quantity: toMoney(i.quantity).toNumber(),
              })),
              voucherNumber: voucher.voucherNumber,
              voucherDate: voucher.voucherDate,
            });
          } catch (e: unknown) {
            logger.error("[TransferWA] Failed to send (original-flow):", { error: getErrorMessage(e) });
          }
        });
    } catch (error: unknown) {
      if (sendBaleMirrorMovementRefusal(res, error)) return;
      if (error instanceof StockTransferPolicyError) {
        logger.warn("stock transfer create rejected by inventory policy", {
          module: "stockTransfer",
          action: "create",
          userId: _uid,
          companyId: _cid,
          code: error.code,
        });
        const status = error.code === "STOCK_TRANSFER_NEGATIVE_STOCK_DISABLED" ? 409 : 400;
        return res.status(status).json({ code: error.code, message: error.message });
      }
      if (error instanceof DuplicateStockTransferError) {
        // The voucher already carries a transfer. Building a second one would
        // move the same stock twice under one document number.
        logger.warn("stock transfer create refused a duplicate document", {
          module: "stockTransfer",
          action: "create",
          userId: _uid,
          companyId: _cid,
        });
        return res.status(409).json({ code: error.code, message: error.message });
      }
      if (error instanceof StockDocumentIdempotencyError) {
        // A malformed request id is the caller's to fix; a corrupt marker is
        // evidence nobody should paper over by creating a second transfer.
        logger.warn("stock transfer create rejected the request id", {
          module: "stockTransfer",
          action: "create",
          userId: _uid,
          companyId: _cid,
          code: error.code,
        });
        const status = error.code === "STOCK_DOCUMENT_REQUEST_ID_INVALID" ? 400 : 409;
        return res.status(status).json({ code: error.code, message: error.message });
      }
      logger.error("stock transfer create failed", {
        module: "stockTransfer",
        action: "create",
        userId: _uid,
        companyId: _cid,
        durationMs: Date.now() - _t,
        error,
      });
      logger.error("[Stock Transfer] Error creating transfer:", {
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
