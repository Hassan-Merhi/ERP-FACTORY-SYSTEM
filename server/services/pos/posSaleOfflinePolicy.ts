import type { HandlerErrorResult } from "./posSaleTypes";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RATE = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,12})?$/;

/**
 * Offline sale rules on the factory LAN server (owner decisions 2026-11-01
 * and 2026-11-02): cash, bank and credit sales in any accepted currency are
 * recorded offline. Each sale needs the till's client sale id (the cloud
 * replay's idempotency key); a non-USD sale needs the exchange rate the
 * cashier entered; supplier-partner company sales stay online-only.
 * Returns the refusal, or null when the sale may be recorded offline.
 */
export function phase9PosSaleRefusal(input: {
  clientSaleId: unknown;
  currency: unknown;
  exchangeRate: unknown;
  isSpCompany: boolean;
}): HandlerErrorResult | null {
  const refuse = (code: string, message: string): HandlerErrorResult => ({ status: 409, body: { code, message } });
  if (typeof input.clientSaleId !== "string" || !UUID.test(input.clientSaleId)) {
    return refuse("EDGE_POS_CLIENT_SALE_ID_REQUIRED", "Offline sales need the till's sale id; refresh the POS page.");
  }
  if (String(input.currency || "USD").toUpperCase() !== "USD" && !RATE.test(String(input.exchangeRate ?? ""))) {
    return refuse(
      "EDGE_POS_OFFLINE_RATE_REQUIRED",
      "Enter the exchange rate for this sale while the factory is offline."
    );
  }
  if (input.isSpCompany) {
    return refuse("EDGE_POS_OFFLINE_COMPANY_UNSUPPORTED", "This company's sales stay online-only.");
  }
  return null;
}
