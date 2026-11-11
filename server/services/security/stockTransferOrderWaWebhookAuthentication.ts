/**
 * Independent, constant-time Bearer authentication for GREEN API callbacks.
 * Store only the raw random secret in STO_WA_GREEN_API_WEBHOOK_TOKEN.
 * Configure Green API webhookUrlToken = Bearer <the same secret>.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export function webhookTokenIsConfigured(): boolean {
  const token = process.env.STO_WA_GREEN_API_WEBHOOK_TOKEN;
  return typeof token === "string" && token.length >= 32 && token.length <= 256 &&
    // No whitespace and no ASCII control characters (U+0000–U+001F).
    !Array.from(token).some((ch) => /\s/.test(ch) || ch.charCodeAt(0) <= 0x1f);
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
