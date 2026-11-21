// Extracted from ./locationStockWhatsAppDelivery.ts
import { pool } from "../db";

export type LocationStockDeliverySource = "manual" | "scheduled" | "retry";

export type LocationStockDeliveryStatus = "running" | "sent" | "failed" | "skipped_empty";

export interface LocationStockDeliveryRequest {
  companyId: number;
  locationId: number;
  includeCost: boolean;
  includeZeroStock?: boolean;
  includeNegativeStock?: boolean;
  stockGroupId?: number | null;
  categoryId?: number | null;
  source: LocationStockDeliverySource;
  initiatedByUserId?: string | null;
  scheduledFor?: string | null;
  retryOfId?: number | null;
  idempotencyKey: string;
  reportDate?: string;
}

export interface LocationStockDeliveryResult {
  deliveryId: number;
  status: LocationStockDeliveryStatus;
  duplicate: boolean;
  itemCount: number | null;
  pageCount: number | null;
  fileName: string | null;
  error: string | null;
  destinationGroupName: string | null;
}

interface DeliveryContext {
  locationName: string;
  companyName: string;
  chatId: string | null;
  groupName: string | null;
  destinationEnabled: boolean;
}

export async function loadDeliveryContext(companyId: number, locationId: number): Promise<DeliveryContext> {
  const result = await pool.query<{
    location_name: string;
    company_name: string;
    whatsapp_group_chat_id: string | null;
    whatsapp_group_name: string | null;
    destination_enabled: boolean | null;
  }>(
    `SELECT l.name AS location_name,
            c.name AS company_name,
            d.whatsapp_group_chat_id,
            d.whatsapp_group_name,
            d.enabled AS destination_enabled
       FROM locations l
       JOIN companies c ON c.id = l.company_id
       LEFT JOIN location_whatsapp_stock_reports d
         ON d.location_id = l.id AND d.company_id = l.company_id
      WHERE l.id = $1 AND l.company_id = $2
      LIMIT 1`,
    [locationId, companyId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Location not found for the active company");
  return {
    locationName: row.location_name,
    companyName: row.company_name,
    chatId: row.whatsapp_group_chat_id?.trim() || null,
    groupName: row.whatsapp_group_name ?? null,
    destinationEnabled: row.destination_enabled === true,
  };
}

export async function claimDelivery(
  request: LocationStockDeliveryRequest,
  context: DeliveryContext
): Promise<{ id: number; duplicate: boolean; existing?: LocationStockDeliveryResult }> {
  const stockGroupUnassigned = request.stockGroupId === null;
  const storedStockGroupId = typeof request.stockGroupId === "number" ? request.stockGroupId : null;
  const result = await pool.query<{ id: string | number }>(
    `INSERT INTO location_whatsapp_stock_deliveries (
        company_id, location_id, source, retry_of_id, idempotency_key, status,
        include_cost, include_zero_stock, include_negative_stock,
        stock_group_id, stock_group_unassigned, category_id,
        initiated_by_user_id, scheduled_for,
        destination_chat_id, destination_group_name, started_at
      ) VALUES ($1,$2,$3,$4,$5,'running',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id`,
    [
      request.companyId,
      request.locationId,
      request.source,
      request.retryOfId ?? null,
      request.idempotencyKey,
      request.includeCost,
      request.includeZeroStock === true,
      request.includeNegativeStock !== false,
      storedStockGroupId,
      stockGroupUnassigned,
      request.categoryId ?? null,
      request.initiatedByUserId ?? null,
      request.scheduledFor ?? null,
      context.chatId,
      context.groupName,
    ]
  );

  if (result.rows.length) return { id: Number(result.rows[0].id), duplicate: false };

  const existing = await pool.query<{
    id: string | number;
    status: LocationStockDeliveryStatus;
    item_count: number | null;
    page_count: number | null;
    file_name: string | null;
    error: string | null;
    destination_group_name: string | null;
  }>(
    `SELECT id, status, item_count, page_count, file_name, error, destination_group_name
       FROM location_whatsapp_stock_deliveries
      WHERE idempotency_key = $1
      LIMIT 1`,
    [request.idempotencyKey]
  );
  const row = existing.rows[0];
  if (!row) throw new Error("Could not claim WhatsApp delivery");
  return {
    id: Number(row.id),
    duplicate: true,
    existing: {
      deliveryId: Number(row.id),
      status: row.status,
      duplicate: true,
      itemCount: row.item_count,
      pageCount: row.page_count,
      fileName: row.file_name,
      error: row.error,
      destinationGroupName: row.destination_group_name,
    },
  };
}

export async function completeDelivery(
  deliveryId: number,
  status: Exclude<LocationStockDeliveryStatus, "running">,
  details: {
    error?: string | null;
    itemCount?: number | null;
    pageCount?: number | null;
    fileName?: string | null;
    reportGenerated?: boolean;
  } = {}
): Promise<void> {
  await pool.query(
    `UPDATE location_whatsapp_stock_deliveries
        SET status = $2,
            error = $3,
            item_count = COALESCE($4::integer, item_count),
            page_count = COALESCE($5::integer, page_count),
            file_name = COALESCE($6::text, file_name),
            report_generated_at = CASE WHEN $7::boolean THEN COALESCE(report_generated_at, now()) ELSE report_generated_at END,
            completed_at = now()
      WHERE id = $1`,
    [
      deliveryId,
      status,
      details.error ? details.error.slice(0, 1000) : null,
      details.itemCount ?? null,
      details.pageCount ?? null,
      details.fileName ?? null,
      details.reportGenerated === true,
    ]
  );
}

export async function updateGeneratedMetadata(
  deliveryId: number,
  itemCount: number,
  pageCount: number,
  fileName: string
): Promise<void> {
  await pool.query(
    `UPDATE location_whatsapp_stock_deliveries
        SET report_generated_at = now(), item_count = $2, page_count = $3, file_name = $4
      WHERE id = $1`,
    [deliveryId, itemCount, pageCount, fileName]
  );
}
