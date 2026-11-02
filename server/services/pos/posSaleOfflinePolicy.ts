import type { HandlerErrorResult } from "./posSaleTypes";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Owner-approved offline sale shape (2026-11-01) on the factory LAN server:
 * a cash sale in USD with a client sale id (the cloud replay's idempotency
 * key), never a credit or bank sale and never a supplier-partner company
 * sale. Returns the refusal, or null when the sale may be recorded offline.
 */
export function phase9PosSaleRefusal(input: {
  clientSaleId: unknown;
  isCreditSale: unknown;
  accountType: string;
  currency: unknown;
  isSpCompany: boolean;
}): HandlerErrorResult | null {
  const refuse = (code: string, message: string): HandlerErrorResult => ({ status: 409, body: { code, message } });
  if (typeof input.clientSaleId !== "string" || !UUID.test(input.clientSaleId)) {
    return refuse("EDGE_POS_CLIENT_SALE_ID_REQUIRED", "Offline sales need the till's sale id; refresh the POS page.");
  }
  if (input.isCreditSale || input.accountType !== "cash") {
    return refuse("EDGE_POS_OFFLINE_CASH_ONLY", "Only cash sales can be recorded while the factory is offline.");
  }
  if (String(input.currency || "USD").toUpperCase() !== "USD") {
    return refuse("EDGE_POS_OFFLINE_USD_ONLY", "Only USD sales can be recorded while the factory is offline.");
  }
  if (input.isSpCompany) {
    return refuse("EDGE_POS_OFFLINE_COMPANY_UNSUPPORTED", "This company's sales stay online-only.");
  }
  return null;
}
