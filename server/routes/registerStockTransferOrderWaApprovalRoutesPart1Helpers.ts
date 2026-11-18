// Extracted from ./registerStockTransferOrderWaApprovalRoutesPart1.ts
import type { Response } from "express";
import { logger } from "../lib/logger";
import { StockTransferOrderDeliveryReconciliationError } from "../services/stockTransferOrderWaDeliveryReconciliation";
import { StockTransferOrderApprovalError } from "../services/stockTransferOrderWhatsAppApprovalBatch";

export const groupPattern = /^[0-9]{5,25}@g[.]us$/;

export const recipientPattern = /^[0-9]{5,25}@(g[.]us|c[.]us)$/;

export const phonePattern = /^\+[1-9][0-9]{6,14}$/;

export function clean(v: unknown) {
  // Replace ASCII control characters (U+0000–U+001F, U+007F) with spaces.
  const text = Array.from(String(v ?? ""), (ch) => {
    const code = ch.charCodeAt(0);
    return ch.length === 1 && (code <= 0x1f || code === 0x7f) ? " " : ch;
  }).join("");
  return text.trim().slice(0, 100);
}

export function errorResponse(res: Response, e: unknown) {
  const status = Number((e as { status?: number })?.status ?? 0);
  if (status === 401 || status === 403) {
    return res.status(status).json({ message: "Active company permission is no longer valid." });
  }
  if (e instanceof StockTransferOrderDeliveryReconciliationError) {
    return res.status(e.status).json({ message: e.message });
  }
  if (e instanceof StockTransferOrderApprovalError) {
    return res.status(e.code === "STO_WA_SCOPE" ? 403 : 409).json({ code: e.code, message: e.message });
  }
  if ((e as { code?: string })?.code === "23505") {
    return res.status(409).json({ message: "An order already belongs to an active approval batch." });
  }
  logger.error("[STO WA] Phase 2 failed", { error: e });
  return res.status(500).json({ message: "Stock Transfer Order WhatsApp operation failed." });
}

export const BATCH_STATE_CHANGED = "Approval batch changed during delivery";

export type RevisionSummary = {
  voucher_number_snapshot: string;
  revision_number_snapshot: number;
  source_location_name: string | null;
  changed_items: number;
  net_delta: string;
};
