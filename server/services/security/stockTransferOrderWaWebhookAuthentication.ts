/**
 * Independent, constant-time Bearer authentication for GREEN API callbacks.
 * Store only the raw random secret in STO_WA_GREEN_API_WEBHOOK_TOKEN.
 * Configure Green API webhookUrlToken = Bearer <the same secret>.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export function webhookTokenIsConfigured(): boolean {
  const token = process.env.STO_WA_GREEN_API_WEBHOOK_TOKEN;
  return typeof token === "string" && token.length >= 32 && token.length <= 256 &&
    !/[\s\x00-\x1f]/.test(token);
}

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
