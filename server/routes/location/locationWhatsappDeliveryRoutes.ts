import { getErrorDetails } from "@shared/errorUtils";
import type { Express, NextFunction, Request, Response } from "express";
import { pool } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { requireExportAccess, requireSensitiveAccess } from "../../lib/permissionMiddleware";
import {
  deliverLocationStockWhatsApp,
  recoverStaleLocationStockDeliveries,
} from "../../services/locationStockWhatsAppDelivery";
import { storage } from "../../storage";
import { logAudit } from "../_helpers";
import { validateRequest } from "../../lib/validateRequest";
import { retryLocationStockDeliveryInput } from "./locationWriteSchemas";
import {
  LOCATION_WHATSAPP_PERMISSION,
  retryIdempotencyKey,
  loadRetryDelivery,
  isoOrNull,
  type RetryDeliveryRow,
} from "./locationWhatsappDeliveryRoutesHelpers";

const requireCostPriceAccess = requireSensitiveAccess("fld_cost_price");
const requireTotalValueAccess = requireSensitiveAccess("fld_total_value");

declare global {
  namespace Express {
    interface Request {
      _locationStockRetryDelivery?: RetryDeliveryRow & { id: number };
    }
  }
}

function requireRetryCostAccess(req: Request, res: Response, next: NextFunction): void {
  if (!req._locationStockRetryDelivery?.include_cost) {
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

export function registerLocationWhatsappDeliveryRoutes(app: Express) {
  app.get(
    "/api/locations/:locationId/whatsapp-deliveries",
    requireAuth,
    requireNonPOS,
    requireExportAccess(LOCATION_WHATSAPP_PERMISSION),
    async (req, res) => {
      try {
        await recoverStaleLocationStockDeliveries();
        const locationId = Number.parseInt(req.params.locationId, 10);
        if (!Number.isFinite(locationId)) return res.status(400).json({ message: "Invalid location ID" });
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const location = await storage.getLocationById(locationId);
        if (!location) return res.status(404).json({ message: "Location not found" });
        if (location.companyId !== companyId) return res.status(403).json({ message: "Access denied" });

        const parsedLimit = Number.parseInt(String(req.query.limit ?? "50"), 10);
        const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 50;
        const result = await pool.query<{
          id: string | number;
          source: "manual" | "scheduled" | "retry";
          retry_of_id: string | number | null;
          status: "running" | "sent" | "failed" | "skipped_empty";
          include_cost: boolean;
          include_zero_stock: boolean;
          include_negative_stock: boolean;
          stock_group_id: number | null;
          stock_group_unassigned: boolean;
          stock_group_name: string | null;
          category_id: number | null;
          category_name: string | null;
          initiated_by_user_id: string | null;
          initiated_by_username: string | null;
          scheduled_for: string | Date | null;
          destination_group_name: string | null;
          report_generated_at: string | Date | null;
          item_count: number | null;
          page_count: number | null;
          file_name: string | null;
          error: string | null;
          started_at: string | Date;
          completed_at: string | Date | null;
        }>(
          `SELECT d.id, d.source, d.retry_of_id, d.status,
                  d.include_cost, d.include_zero_stock, d.include_negative_stock,
                  d.stock_group_id, d.stock_group_unassigned, sg.name AS stock_group_name,
                  d.category_id, sc.name AS category_name,
                  d.initiated_by_user_id, u.username AS initiated_by_username,
                  d.scheduled_for, d.destination_group_name,
                  d.report_generated_at, d.item_count, d.page_count, d.file_name,
                  d.error, d.started_at, d.completed_at
             FROM location_whatsapp_stock_deliveries d
             LEFT JOIN stock_groups sg ON sg.id = d.stock_group_id AND sg.company_id = d.company_id
             LEFT JOIN stock_categories sc ON sc.id = d.category_id AND sc.company_id = d.company_id
             LEFT JOIN users u ON u.id = d.initiated_by_user_id
            WHERE d.location_id = $1 AND d.company_id = $2
            ORDER BY d.started_at DESC, d.id DESC
            LIMIT $3`,
          [locationId, companyId, limit]
        );
        const summaryResult = await pool.query<{
          latest_status: "running" | "sent" | "failed" | "skipped_empty" | null;
          latest_error: string | null;
          latest_at: string | Date | null;
          last_sent_at: string | Date | null;
          last_sent_source: "manual" | "scheduled" | "retry" | null;
          last_sent_include_cost: boolean | null;
        }>(
          `SELECT
             (SELECT status FROM location_whatsapp_stock_deliveries
               WHERE location_id = $1 AND company_id = $2
               ORDER BY started_at DESC, id DESC LIMIT 1) AS latest_status,
             (SELECT error FROM location_whatsapp_stock_deliveries
               WHERE location_id = $1 AND company_id = $2
               ORDER BY started_at DESC, id DESC LIMIT 1) AS latest_error,
             (SELECT started_at FROM location_whatsapp_stock_deliveries
               WHERE location_id = $1 AND company_id = $2
               ORDER BY started_at DESC, id DESC LIMIT 1) AS latest_at,
             (SELECT COALESCE(completed_at, started_at) FROM location_whatsapp_stock_deliveries
               WHERE location_id = $1 AND company_id = $2 AND status = 'sent'
               ORDER BY started_at DESC, id DESC LIMIT 1) AS last_sent_at,
             (SELECT source FROM location_whatsapp_stock_deliveries
               WHERE location_id = $1 AND company_id = $2 AND status = 'sent'
               ORDER BY started_at DESC, id DESC LIMIT 1) AS last_sent_source,
             (SELECT include_cost FROM location_whatsapp_stock_deliveries
               WHERE location_id = $1 AND company_id = $2 AND status = 'sent'
               ORDER BY started_at DESC, id DESC LIMIT 1) AS last_sent_include_cost`,
          [locationId, companyId]
        );

        const blockedRetryParents = new Set(
          result.rows
            .filter(
              (row) =>
                row.source === "retry" && row.retry_of_id != null && (row.status === "running" || row.status === "sent")
            )
            .map((row) => Number(row.retry_of_id))
        );
        const deliveries = result.rows.map((row) => ({
          id: Number(row.id),
          source: row.source,
          retryOfId: row.retry_of_id == null ? null : Number(row.retry_of_id),
          status: row.status,
          includeCost: row.include_cost,
          includeZeroStock: row.include_zero_stock,
          includeNegativeStock: row.include_negative_stock,
          stockGroupId: row.stock_group_id,
          stockGroupName: row.stock_group_unassigned ? "Unassigned" : row.stock_group_name,
          categoryId: row.category_id,
          categoryName: row.category_name,
          initiatedByUserId: row.initiated_by_user_id,
          initiatedByUsername: row.initiated_by_username,
          scheduledFor: row.scheduled_for ? String(row.scheduled_for).slice(0, 10) : null,
          destinationGroupName: row.destination_group_name,
          reportGeneratedAt: isoOrNull(row.report_generated_at),
          itemCount: row.item_count,
          pageCount: row.page_count,
          fileName: row.file_name,
          error: row.error,
          startedAt: isoOrNull(row.started_at),
          completedAt: isoOrNull(row.completed_at),
          canRetry:
            (row.status === "failed" || row.status === "skipped_empty") && !blockedRetryParents.has(Number(row.id)),
        }));
        const summary = summaryResult.rows[0];
        res.json({
          locationId,
          deliveries,
          summary: {
            latestStatus: summary?.latest_status ?? null,
            latestError: summary?.latest_error ?? null,
            latestAt: isoOrNull(summary?.latest_at),
            lastSentAt: isoOrNull(summary?.last_sent_at),
            lastSentSource: summary?.last_sent_source ?? null,
            lastSentIncludeCost: summary?.last_sent_include_cost ?? null,
          },
        });
      } catch (error) {
        if (getErrorDetails(error).code === "42P01") {
          return res.json({
            locationId: Number.parseInt(req.params.locationId, 10),
            deliveries: [],
            summary: {
              latestStatus: null,
              latestError: null,
              latestAt: null,
              lastSentAt: null,
              lastSentSource: null,
              lastSentIncludeCost: null,
            },
          });
        }
        logger.error("[LocationStockDelivery] History failed", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/locations/:locationId/whatsapp-deliveries/:deliveryId/retry",
    requireAuth,
    requireNonPOS,
    requireExportAccess(LOCATION_WHATSAPP_PERMISSION),
    loadRetryDelivery,
    requireRetryCostAccess,
    validateRequest(retryLocationStockDeliveryInput),
    async (req, res) => {
      const original = req._locationStockRetryDelivery!;
      try {
        const location = await storage.getLocationById(original.location_id);
        if (!location) return res.status(404).json({ message: "Location not found" });

        const stockGroupId = original.stock_group_unassigned
          ? null
          : original.stock_group_id == null
            ? undefined
            : original.stock_group_id;
        const scheduledFor = original.scheduled_for ? String(original.scheduled_for).slice(0, 10) : null;
        const result = await deliverLocationStockWhatsApp({
          companyId: original.company_id,
          locationId: original.location_id,
          includeCost: original.include_cost,
          includeZeroStock: original.include_zero_stock,
          includeNegativeStock: original.include_negative_stock,
          stockGroupId,
          categoryId: original.category_id,
          source: "retry",
          initiatedByUserId: req.session.userId!,
          scheduledFor,
          retryOfId: original.id,
          idempotencyKey: retryIdempotencyKey(req, original.company_id, original.location_id, original.id),
        });

        if (result.status === "running")
          return res.status(202).json({ message: "This retry is already in progress", ...result });
        if (result.status === "skipped_empty")
          return res
            .status(400)
            .json({ message: "The retry found no stock matching the original report filters", ...result });
        if (result.status === "failed")
          return res.status(502).json({ message: result.error || "WhatsApp retry failed", ...result });

        try {
          await logAudit({
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId: original.company_id,
            action: "retry_location_stock_whatsapp",
            tableName: "location_whatsapp_stock_deliveries",
            recordId: result.deliveryId,
            recordIdentifier: location.name,
            changes: {
              retryOfId: { old: null, new: original.id },
              includeCost: { old: null, new: original.include_cost },
              status: { old: original.status, new: result.status },
              itemCount: { old: null, new: result.itemCount },
              whatsappGroupName: { old: null, new: result.destinationGroupName },
            },
          });
        } catch {
          /* retry already completed externally */
        }

        res.json({ message: "Stock report retry sent successfully", ...result });
      } catch (error: unknown) {
        if ((error as { code: "23505" })?.code === "23505") {
          return res
            .status(409)
            .json({ message: "A retry for this delivery is already in progress or has already succeeded" });
        }
        logger.error("[LocationStockDelivery] Retry failed", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      } finally {
        delete req._locationStockRetryDelivery;
      }
    }
  );
}
