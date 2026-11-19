// Extracted from ./createSaleService.ts: shared helpers.
import type { CreatePosSaleResult, HandlerErrorResult } from "./posSaleTypes";

/** The rate a cashier entered for a non-USD sale on the factory LAN server. */
export function offlineEnteredRate(
  currency: unknown,
  exchangeRate: unknown
): { currency: string; exchangeRate: string } | null {
  const code = String(currency || "USD").toUpperCase();
  if (code === "USD" || exchangeRate == null || exchangeRate === "") return null;
  return { currency: code, exchangeRate: String(exchangeRate) };
}

export function err(result: HandlerErrorResult): CreatePosSaleResult {
  return { status: result.status, body: result.body };
}
