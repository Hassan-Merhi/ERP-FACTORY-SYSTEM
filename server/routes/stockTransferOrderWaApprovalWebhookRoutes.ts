/**
 * GREEN API server-to-server webhook for Stock Transfer Order approval only.
 * Registered BEFORE ERP session/tenant/module boundaries, which apply to
 * human API actions. Authentication here is a dedicated strong bearer secret.
 *
 * Never log credentials or message bodies. Green API may retry notifications;
 * the database uniquely guards both provider message IDs and one decision per
 * approval batch.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { logger } from "../lib/logger";
import { parseStockTransferOrderWaReply } from "../services/stockTransferOrderWhatsAppReplyParser";
import { recordStockTransferOrderWaReply } from "../services/stockTransferOrderWhatsAppInbound";

export const STOCK_TRANSFER_ORDER_WA_WEBHOOK_PATH =
  "/api/stock-transfer-order/wa-approval/webhook";

export function webhookTokenIsConfigured(): boolean {
  const token = process.env.STO_WA_GREEN_API_WEBHOOK_TOKEN;
  return typeof token === "string" && token.length >= 32 && token.length <= 256 &&
    !/[\s\x00-\x1f]/.test(token);
}

/**
 * Compare hashes in constant time even for an incorrect token length. Env
 * holds the raw secret; GREEN API webhookUrlToken must be Bearer <secret>.
 */
export function authorizedStockTransferOrderWaWebhook(authHeader: unknown): boolean {
  if (!webhookTokenIsConfigured() || typeof authHeader !== "string" ||
      !authHeader.startsWith("Bearer ") || authHeader.length > 300) {
    return false;
  }
  const actual = authHeader.slice("Bearer ".length);
  const expected = process.env.STO_WA_GREEN_API_WEBHOOK_TOKEN!;
  const a = createHash("sha256").update(actual).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function stockTransferOrderWaWebhookHandler(req: Request, res: Response) {
    res.setHeader("Cache-Control", "no-store");
    if (!webhookTokenIsConfigured()) {
      return res.status(503).json({ code: "STO_WA_WEBHOOK_NOT_CONFIGURED" });
    }
    if (!authorizedStockTransferOrderWaWebhook(req.headers.authorization)) {
      return res.status(401).json({ code: "STO_WA_WEBHOOK_UNAUTHORIZED" });
    }
    const reply = parseStockTransferOrderWaReply(req.body);
    if (!reply) {
      return res.status(200).json({ accepted: false, outcome: "ignored" });
    }
    try {
      const result = await recordStockTransferOrderWaReply(reply);
      // Acknowledge provider redeliveries with HTTP 200, not an error that
      // would trigger further retries. Phase 4 consumes the staged event.
      if (result.outcome === "accepted") {
        return res.status(200).json({
          accepted: true, decisionRecorded: true, approvalExecuted: false,
          batchId: result.batchId, command: result.command,
        });
      }
      return res.status(200).json({ accepted: false, outcome: result.outcome });
    } catch (error) {
      logger.error("[STO WA] Incoming provider event could not be staged", {
        type: "stock_transfer_order_wa_webhook_failure",
        message: error instanceof Error ? error.message : "unknown_error",
      });
      // Database unavailability is transient. An authenticated provider retry
      // is safe because accepted decisions are unique at the database level.
      res.setHeader("Retry-After", "30");
      return res.status(503).json({ code: "STO_WA_WEBHOOK_TEMPORARILY_UNAVAILABLE" });
    }
}

export function registerStockTransferOrderWaApprovalWebhookRoutes(app: Express): void {
  app.post(STOCK_TRANSFER_ORDER_WA_WEBHOOK_PATH, stockTransferOrderWaWebhookHandler);
}
