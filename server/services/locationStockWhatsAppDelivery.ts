import { pool } from "../db";
import { generateStockPdf } from "../helpers/generateStockPdf";
import { releaseManagedExportAttachment } from "../helpers/exportAttachmentSource";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { sendWhatsAppFileToChatIdPos } from "./whatsappService";
import {
  loadDeliveryContext,
  claimDelivery,
  completeDelivery,
  updateGeneratedMetadata,
  type LocationStockDeliveryRequest,
  type LocationStockDeliveryResult,
} from "./locationStockWhatsAppDeliveryHelpers";
export type {
  LocationStockDeliverySource,
  LocationStockDeliveryStatus,
  LocationStockDeliveryRequest,
  LocationStockDeliveryResult,
} from "./locationStockWhatsAppDeliveryHelpers";

function safeFilePart(value: string): string {
  return value.replace(/[^\w\s.-]/g, "_").replace(/\s+/g, "_");
}

function normalizeReportDate(value?: string): string {
  const raw = value || new Date().toISOString().slice(0, 10);
  return raw.replace(/[^0-9]/g, "").slice(0, 8) || new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

export async function recordLocationStockDeliveryFailure(
  request: LocationStockDeliveryRequest,
  error: string
): Promise<LocationStockDeliveryResult> {
  const context = await loadDeliveryContext(request.companyId, request.locationId);
  const claimed = await claimDelivery(request, context);
  if (claimed.duplicate && claimed.existing) return claimed.existing;
  await completeDelivery(claimed.id, "failed", { error });
  return {
    deliveryId: claimed.id,
    status: "failed",
    duplicate: false,
    itemCount: null,
    pageCount: null,
    fileName: null,
    error,
    destinationGroupName: context.groupName,
  };
}

/**
 * A process can disappear after claiming a delivery but before recording the
 * external result. Re-sending automatically is unsafe because WhatsApp may have
 * accepted the file before the crash. Mark stale attempts failed instead; the UI
 * exposes an explicit retry so duplicates remain a user-controlled decision.
 */
export async function recoverStaleLocationStockDeliveries(): Promise<number> {
  const result = await pool.query<{ id: string | number; location_id: number }>(
    `UPDATE location_whatsapp_stock_deliveries
        SET status = 'failed',
            error = COALESCE(error, 'Delivery interrupted before completion; retry manually if needed'),
            completed_at = now()
      WHERE status = 'running'
        AND started_at < now() - interval '20 minutes'
      RETURNING id, location_id`
  );
  for (const row of result.rows) {
    await pool
      .query(
        `UPDATE location_whatsapp_stock_schedules
          SET last_status = 'failed',
              last_error = 'Delivery interrupted before completion; retry manually if needed',
              updated_at = now()
        WHERE location_id = $1 AND last_status = 'running'`,
        [row.location_id]
      )
      .catch(() => undefined);
  }
  if (result.rowCount) {
    logger.warn("[LocationStockWhatsAppDelivery] recovered stale running deliveries", {
      count: result.rowCount,
    });
  }
  return result.rowCount ?? 0;
}

export async function deliverLocationStockWhatsApp(
  request: LocationStockDeliveryRequest
): Promise<LocationStockDeliveryResult> {
  const context = await loadDeliveryContext(request.companyId, request.locationId);
  const claimed = await claimDelivery(request, context);
  if (claimed.duplicate && claimed.existing) return claimed.existing;
  const deliveryId = claimed.id;

  try {
    if (!context.chatId) {
      const error = "No WhatsApp group is linked to this location";
      await completeDelivery(deliveryId, "failed", { error });
      return {
        deliveryId,
        status: "failed",
        duplicate: false,
        itemCount: null,
        pageCount: null,
        fileName: null,
        error,
        destinationGroupName: context.groupName,
      };
    }
    if (!context.chatId.endsWith("@g.us")) {
      const error = "The linked WhatsApp destination is not a valid group";
      await completeDelivery(deliveryId, "failed", { error });
      return {
        deliveryId,
        status: "failed",
        duplicate: false,
        itemCount: null,
        pageCount: null,
        fileName: null,
        error,
        destinationGroupName: context.groupName,
      };
    }
    if (!context.destinationEnabled) {
      const error = "WhatsApp stock reports are disabled for this location";
      await completeDelivery(deliveryId, "failed", { error });
      return {
        deliveryId,
        status: "failed",
        duplicate: false,
        itemCount: null,
        pageCount: null,
        fileName: null,
        error,
        destinationGroupName: context.groupName,
      };
    }

    const { buffer, pageCount, rowCount } = await generateStockPdf(
      request.companyId,
      context.companyName,
      request.locationId,
      context.locationName,
      request.includeCost,
      request.stockGroupId,
      {
        includeZeroStock: request.includeZeroStock === true,
        includeNegativeStock: request.includeNegativeStock !== false,
        categoryId: request.categoryId ?? null,
      }
    );

    const safeLocation = safeFilePart(context.locationName);
    const mode = request.includeCost ? "with_cost" : "no_cost";
    const fileName = `${safeLocation}_Godown_${normalizeReportDate(request.reportDate)}_${mode}.pdf`;

    try {
      await updateGeneratedMetadata(deliveryId, rowCount, pageCount, fileName);

      if (rowCount === 0) {
        await completeDelivery(deliveryId, "skipped_empty", {
          itemCount: 0,
          pageCount,
          fileName,
          reportGenerated: true,
        });
        return {
          deliveryId,
          status: "skipped_empty",
          duplicate: false,
          itemCount: 0,
          pageCount,
          fileName,
          error: null,
          destinationGroupName: context.groupName,
        };
      }

      const maxAllowedPages = Math.ceil(rowCount / 20) + 5;
      if (pageCount > maxAllowedPages) {
        const error = `PDF safety guard rejected ${pageCount} pages for ${rowCount} rows`;
        await completeDelivery(deliveryId, "failed", {
          error,
          itemCount: rowCount,
          pageCount,
          fileName,
          reportGenerated: true,
        });
        return {
          deliveryId,
          status: "failed",
          duplicate: false,
          itemCount: rowCount,
          pageCount,
          fileName,
          error,
          destinationGroupName: context.groupName,
        };
      }

      const caption = `Stock Report — ${context.locationName} — ${request.includeCost ? "With Cost" : "Without Cost"}`;
      const sendResult = await sendWhatsAppFileToChatIdPos(
        context.chatId,
        buffer,
        fileName,
        caption,
        "application/pdf"
      );
      if (!sendResult.success) {
        const error = sendResult.error || "WhatsApp send failed";
        await completeDelivery(deliveryId, "failed", {
          error,
          itemCount: rowCount,
          pageCount,
          fileName,
          reportGenerated: true,
        });
        return {
          deliveryId,
          status: "failed",
          duplicate: false,
          itemCount: rowCount,
          pageCount,
          fileName,
          error,
          destinationGroupName: context.groupName,
        };
      }

      await completeDelivery(deliveryId, "sent", {
        itemCount: rowCount,
        pageCount,
        fileName,
        reportGenerated: true,
      });
      logger.info("[LocationStockWhatsAppDelivery] sent", {
        deliveryId,
        companyId: request.companyId,
        locationId: request.locationId,
        source: request.source,
        includeCost: request.includeCost,
        rowCount,
        pageCount,
        groupName: context.groupName,
      });
      return {
        deliveryId,
        status: "sent",
        duplicate: false,
        itemCount: rowCount,
        pageCount,
        fileName,
        error: null,
        destinationGroupName: context.groupName,
      };
    } finally {
      await releaseManagedExportAttachment(buffer);
    }
  } catch (error: unknown) {
    const message = getErrorMessage(error) || "WhatsApp stock report failed";
    await completeDelivery(deliveryId, "failed", { error: message }).catch(() => undefined);
    logger.error("[LocationStockWhatsAppDelivery] failed", {
      deliveryId,
      companyId: request.companyId,
      locationId: request.locationId,
      source: request.source,
      error,
    });
    return {
      deliveryId,
      status: "failed",
      duplicate: false,
      itemCount: null,
      pageCount: null,
      fileName: null,
      error: message,
      destinationGroupName: context.groupName,
    };
  }
}
