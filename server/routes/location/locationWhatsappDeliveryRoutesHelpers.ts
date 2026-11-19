// Extracted from ./locationWhatsappDeliveryRoutes.ts
import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { recoverStaleLocationStockDeliveries } from "../../services/locationStockWhatsAppDelivery";

export const LOCATION_WHATSAPP_PERMISSION = "exp_whatsapp_send";

export interface RetryDeliveryRow {
  id: string | number;
  company_id: number;
  location_id: number;
  status: string;
  include_cost: boolean;
  include_zero_stock: boolean;
  include_negative_stock: boolean;
  stock_group_id: number | null;
  stock_group_unassigned: boolean;
  category_id: number | null;
  scheduled_for: string | Date | null;
}

export function retryIdempotencyKey(req: Request, companyId: number, locationId: number, deliveryId: number): string {
  const supplied = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey.trim() : "";
  if (supplied && supplied.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(supplied)) {
    return `retry:${companyId}:${locationId}:${deliveryId}:${supplied}`;
  }
  return `retry:${companyId}:${locationId}:${deliveryId}:${randomUUID()}`;
}

export async function loadRetryDelivery(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await recoverStaleLocationStockDeliveries();
    const locationId = Number.parseInt(req.params.locationId, 10);
    const deliveryId = Number.parseInt(req.params.deliveryId, 10);
    const companyId = req.session.currentCompanyId;
    if (!Number.isFinite(locationId) || !Number.isFinite(deliveryId)) {
      res.status(400).json({ message: "Invalid location or delivery ID" });
      return;
    }
    if (!companyId) {
      res.status(400).json({ message: "No company selected" });
      return;
    }

    const result = await pool.query<RetryDeliveryRow>(
      `SELECT id, company_id, location_id, status,
              include_cost, include_zero_stock, include_negative_stock,
              stock_group_id, stock_group_unassigned, category_id, scheduled_for
         FROM location_whatsapp_stock_deliveries
        WHERE id = $1 AND location_id = $2 AND company_id = $3
        LIMIT 1`,
      [deliveryId, locationId, companyId]
    );
    const row = result.rows[0];
    if (!row) {
      res.status(404).json({ message: "Delivery attempt not found" });
      return;
    }
    if (row.status !== "failed" && row.status !== "skipped_empty") {
      res.status(409).json({ message: "Only failed or empty delivery attempts can be retried" });
      return;
    }

    const child = await pool.query<{ status: string }>(
      `SELECT status
         FROM location_whatsapp_stock_deliveries
        WHERE retry_of_id = $1
          AND company_id = $2
          AND location_id = $3
          AND status IN ('running', 'sent')
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
      [deliveryId, companyId, locationId]
    );
    if (child.rows[0]?.status === "running") {
      res.status(409).json({ message: "A retry for this delivery is already in progress" });
      return;
    }
    if (child.rows[0]?.status === "sent") {
      res.status(409).json({ message: "This delivery has already been successfully retried" });
      return;
    }

    req._locationStockRetryDelivery = { ...row, id: Number(row.id) };
    next();
  } catch (error: unknown) {
    logger.error("[LocationStockDelivery] Retry lookup failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function isoOrNull(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
