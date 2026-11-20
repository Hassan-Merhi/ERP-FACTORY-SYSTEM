import { randomUUID } from "crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { stockGroups } from "@shared/schema";
import { db } from "../../db";
import { getClientDate } from "../../lib/dateUtils";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { requireExportAccess, requireSensitiveAccess } from "../../lib/permissionMiddleware";
import { deliverLocationStockWhatsApp } from "../../services/locationStockWhatsAppDelivery";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { logAudit } from "../_helpers";
import { validateRequest } from "../../lib/validateRequest";
import { sendLocationStockWhatsappInput } from "./locationWriteSchemas";

const LOCATION_WHATSAPP_PERMISSION = "exp_whatsapp_send";
const requireCostPriceAccess = requireSensitiveAccess("fld_cost_price");
const requireTotalValueAccess = requireSensitiveAccess("fld_total_value");

function parseIncludeCost(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function requireCostReportAccess(req: Request, res: Response, next: NextFunction): void {
  if (!parseIncludeCost(req.body?.includeCost)) {
    next();
    return;
  }

  requireCostPriceAccess(req, res, (error?: unknown) => {
    if (error) {
      next(error);
      return;
    }
    requireTotalValueAccess(req, res, next);
  });
}

function manualIdempotencyKey(req: Request, companyId: number, locationId: number): string {
  const supplied = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey.trim() : "";
  if (supplied && supplied.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(supplied)) {
    return `manual:${companyId}:${locationId}:${supplied}`;
  }
  return `manual:${companyId}:${locationId}:${randomUUID()}`;
}

export function registerLocationReportRoutes(app: Express) {
  // Fail-closed UI probe for the WITH COST option. The POST route repeats these
  // checks, so hiding/disabling the option in the browser is only a UX layer.
  app.get(
    "/api/location-inventory/whatsapp/cost-capability",
    requireAuth,
    requireNonPOS,
    requireExportAccess(LOCATION_WHATSAPP_PERMISSION),
    requireCostPriceAccess,
    requireTotalValueAccess,
    async (_req, res) => {
      res.json({ canSendWithCost: true });
    }
  );

  app.post(
    "/api/locations/:locationId/send-stock-whatsapp",
    requireAuth,
    requireNonPOS,
    requireExportAccess(LOCATION_WHATSAPP_PERMISSION),
    requireCostReportAccess,
    validateRequest(sendLocationStockWhatsappInput),
    async (req, res) => {
      try {
        const locationId = Number.parseInt(req.params.locationId, 10);
        if (!Number.isFinite(locationId)) return res.status(400).json({ message: "Invalid location ID" });

        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const location = await storage.getLocationById(locationId);
        if (!location) return res.status(404).json({ message: "Location not found" });
        if (location.companyId !== companyId) return res.status(403).json({ message: "Access denied" });

        const includeCost = parseIncludeCost(req.body?.includeCost);
        const hasGroupFilter = Object.prototype.hasOwnProperty.call(req.body ?? {}, "stockGroupId");
        let stockGroupId: number | null | undefined = undefined;
        let stockGroupName: string | null = null;

        if (hasGroupFilter) {
          const rawGroupId = req.body?.stockGroupId;
          if (rawGroupId === null || rawGroupId === "none") {
            stockGroupId = null;
            stockGroupName = "Unassigned";
          } else {
            const parsedGroupId = Number.parseInt(String(rawGroupId), 10);
            if (!Number.isFinite(parsedGroupId) || parsedGroupId <= 0) {
              return res.status(400).json({ message: "Invalid stock group ID" });
            }
            const [group] = await db
              .select({ id: stockGroups.id, name: stockGroups.name })
              .from(stockGroups)
              .where(and(eq(stockGroups.id, parsedGroupId), eq(stockGroups.companyId, companyId)))
              .limit(1);
            if (!group) return res.status(404).json({ message: "Stock group not found for this company" });
            stockGroupId = group.id;
            stockGroupName = group.name;
          }
        }

        const result = await deliverLocationStockWhatsApp({
          companyId,
          locationId,
          includeCost,
          includeZeroStock: false,
          includeNegativeStock: true,
          stockGroupId,
          categoryId: null,
          source: "manual",
          initiatedByUserId: req.session.userId!,
          idempotencyKey: manualIdempotencyKey(req, companyId, locationId),
          reportDate: getClientDate(req),
        });

        if (result.status === "running") {
          return res.status(202).json({
            message: "This stock report is already being sent.",
            deliveryId: result.deliveryId,
            duplicate: true,
          });
        }
        if (result.status === "skipped_empty") {
          return res.status(400).json({
            message: stockGroupName
              ? `No stock items matched ${stockGroupName} for this location.`
              : "No stock items matched this report for the location.",
            deliveryId: result.deliveryId,
          });
        }
        if (result.status === "failed") {
          return res.status(502).json({
            message: result.error || "WhatsApp send failed",
            deliveryId: result.deliveryId,
          });
        }

        try {
          await logAudit({
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId,
            action: "send_location_stock_whatsapp",
            tableName: "location_whatsapp_stock_deliveries",
            recordId: result.deliveryId,
            recordIdentifier: location.name,
            changes: {
              source: { old: null, new: "manual" },
              includeCost: { old: null, new: includeCost },
              stockGroupId: { old: null, new: stockGroupId ?? null },
              stockGroupName: { old: null, new: stockGroupName },
              itemCount: { old: null, new: result.itemCount },
              pageCount: { old: null, new: result.pageCount },
              whatsappGroupName: { old: null, new: result.destinationGroupName },
              fileName: { old: null, new: result.fileName },
              duplicate: { old: null, new: result.duplicate },
            },
          });
        } catch {
          // External delivery already completed; audit storage cannot turn it into a failed send.
        }

        res.json({
          message: `Stock PDF sent to ${result.destinationGroupName || "the linked WhatsApp group"}`,
          deliveryId: result.deliveryId,
          duplicate: result.duplicate,
          itemCount: result.itemCount,
          pageCount: result.pageCount,
          includeCost,
          stockGroupId: stockGroupId ?? null,
          stockGroupName,
          fileName: result.fileName,
        });
      } catch (error: unknown) {
        logger.error("[LocationStockWhatsApp] Error", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
