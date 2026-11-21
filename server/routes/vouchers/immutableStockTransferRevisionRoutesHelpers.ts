// Extracted from ./immutableStockTransferRevisionRoutes.ts
import type { Request, Response } from "express";
import { logger } from "../../lib/logger";
import { logAudit } from "../_helpers";
import type { DbTransaction } from "../../db";
import { type ImmutableRevisionResult } from "../../services/immutableStockTransferRevisionLifecycle";
import { sendRevisedTransferWhatsApp } from "../../helpers/sendRevisedTransferWhatsApp";
import { getErrorMessage } from "../../lib/httpHandlers";
import { sendBaleMirrorMovementRefusal } from "../../services/accounting/perpetualInventory/cutoverRefusal";

export function userId(req: Request): string {
  return String(req.user?.id ?? req.session.userId ?? "").trim();
}

function statusForError(error: unknown): number {
  const code = String((error as { code: unknown })?.code ?? "");
  const message = String((error as { message: unknown })?.message ?? "");
  if (code === "STOCK_TRANSFER_REVISION_SCOPE") return 403;
  if (
    code === "STOCK_TRANSFER_REVISION_STALE" ||
    code === "STOCK_TRANSFER_REVISION_DUPLICATE" ||
    code === "STOCK_TRANSFER_REVISION_STATUS" ||
    code === "STOCK_TRANSFER_INSUFFICIENT_STOCK" ||
    code === "STOCK_TRANSFER_DESTINATION_STOCK_CONFLICT"
  ) {
    return 409;
  }
  if (/not found/i.test(message)) return 404;
  if (/required|positive|non-negative|different|missing|deleted|inactive|duplicate|no effective/i.test(message)) {
    return 400;
  }
  return 500;
}

export function sendError(res: Response, error: unknown, context: string) {
  // Wave 15: a factory bale-mirror item after the cut-over (409, translated).
  if (sendBaleMirrorMovementRefusal(res, error)) return res;
  const status = statusForError(error);
  if (status === 500) logger.error(`[ImmutableStockTransferRevision ${context}]`, { error });
  // Unexpected (500) failures are logged above; never echo their internal message to the client.
  const payload: Record<string, unknown> = {
    message: String(
      (status === 500 ? undefined : (error as { message: unknown })?.message) ??
        `Failed to ${context.toLowerCase()} stock transfer revision`
    ),
  };
  // Named reads only: a computed `error[field]` read could reach `stack`.
  const details = error as {
    code?: unknown;
    stockItemId?: unknown;
    sourceLocationId?: unknown;
    requiredQuantity?: unknown;
    availableQuantity?: unknown;
  } | null;
  if (details?.code !== undefined) payload.code = details.code;
  if (details?.stockItemId !== undefined) payload.stockItemId = details.stockItemId;
  if (details?.sourceLocationId !== undefined) payload.sourceLocationId = details.sourceLocationId;
  if (details?.requiredQuantity !== undefined) payload.requiredQuantity = details.requiredQuantity;
  if (details?.availableQuantity !== undefined) payload.availableQuantity = details.availableQuantity;
  return res.status(status).json(payload);
}

/**
 * Post the revised-transfer image to the WhatsApp group configured for the
 * transfer's destination, mirroring what creating the transfer itself sends.
 * Fire-and-forget: a WhatsApp outage must never fail the revision that was
 * already committed.
 */
export function revisionItemsForAudit(items: ImmutableRevisionResult["items"]) {
  return items.map((item) => ({
    stockItemId: Number(item.stockItemId),
    stockItemName: String(item.stockItemName || `Item #${item.stockItemId}`),
    sourceLocationId: Number(item.sourceLocationId || 0),
    sourceLocationName: item.sourceLocationName ? String(item.sourceLocationName) : null,
    originalQuantity: Number(item.originalQuantity || 0),
    newQuantity: Number(item.newQuantity || 0),
    delta: Number(item.delta || 0),
  }));
}

export function queueRevisedTransferWhatsApp(result: ImmutableRevisionResult) {
  // Only revisions submitted for review (POS adjustments) are broadcast, the
  // same set the legacy handler sent before the immutable routes took over.
  if (!result.optional) return;

  const items = result.items
    .map((item) => ({
      stockItemId: Number(item.stockItemId),
      stockItemName: item.stockItemName ?? null,
      originalQuantity: Number(item.originalQuantity) || 0,
      delta: Number(item.delta) || 0,
      newQuantity: Number(item.newQuantity) || 0,
    }))
    .filter((item) => item.stockItemId > 0);
  if (items.length === 0) return;

  const sourceLocationId = Number(result.items.find((item) => item.sourceLocationId)?.sourceLocationId ?? 0);

  setImmediate(async () => {
    try {
      await sendRevisedTransferWhatsApp({
        sourceLocationId,
        sourceLocationName: result.sourceLocationName,
        destinationLocationId: result.destinationLocationId,
        destLocationName: result.destinationLocationName,
        items,
        voucherNumber: result.voucherNumber,
        voucherDate: result.voucherDate,
      });
    } catch (error) {
      logger.error("[RevisedTransferWA] Failed to send revision image", { error: getErrorMessage(error) });
    }
  });
}

export async function auditRevision(
  req: Request,
  companyId: number,
  revisionId: number,
  identifier: string,
  action: "create" | "update" | "approve",
  changes: Record<string, { old?: unknown; new?: unknown }>,
  tx: DbTransaction
) {
  // Phase 21 (B): written on the revision's transaction, so a failed audit
  // rolls the revision back.
  await logAudit(
    {
      userId: userId(req) || "unknown",
      username: req.session.username || req.user?.username || "unknown",
      companyId,
      action,
      tableName: "stock_transfer_revisions",
      recordId: revisionId,
      recordIdentifier: identifier,
      changes,
    },
    tx
  );
}
