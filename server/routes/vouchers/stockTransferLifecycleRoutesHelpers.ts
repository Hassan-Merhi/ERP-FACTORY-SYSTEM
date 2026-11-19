// Extracted from ./stockTransferLifecycleRoutes.ts
import type { Response } from "express";
import { sendBaleMirrorMovementRefusal } from "../../services/accounting/perpetualInventory/cutoverRefusal";
import { logger } from "../../lib/logger";

function errorStatus(error: unknown): number {
  const code = String((error as { code: unknown })?.code ?? "");
  const message = String((error as { message: unknown })?.message ?? "");
  if (code === "STOCK_TRANSFER_INSUFFICIENT_STOCK" || /insufficient stock/i.test(message)) return 409;
  if (/belong.*different company/i.test(message)) return 403;
  if (/required|positive|different|missing|deleted|not found|not a stock transfer|inactive/i.test(message)) return 400;
  return 500;
}

export function sendError(res: Response, error: unknown, context: string) {
  if (sendBaleMirrorMovementRefusal(res, error)) return res;
  const status = errorStatus(error);
  if (status === 500) logger.error(`[StockTransferLifecycle ${context}]`, { error: error });
  // Unexpected (500) failures are logged above; never echo their internal message to the client.
  const payload: Record<string, unknown> = {
    message: String(
      (status === 500 ? undefined : (error as { message: unknown })?.message) ??
        `Failed to ${context.toLowerCase()} stock transfer`
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
