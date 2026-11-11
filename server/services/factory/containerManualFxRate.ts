/**
 * An explicit manual FX quote is a confirmation for this one container only.
 * It must never create/change the company's effective-dated exchange-rate table.
 * Keep the value within factory_containers.fx_rate_to_usd numeric(20, 8).
 */
import type Decimal from "decimal.js";
import { parseMoneyInput } from "../../lib/money";

export function parseContainerManualFxRate(input: unknown, currencyCode: string): Decimal | null {
  if (typeof input !== "string" && typeof input !== "number") return null;
  const raw = String(input).trim();
  // A partial number like "1.12foo" must never be silently accepted as a posted FX quote.
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return null;
  const rate = parseMoneyInput(raw);
  if (
    !rate ||
    !rate.isFinite() ||
    rate.lte(0) ||
    rate.decimalPlaces() > 8 ||
    rate.gt("999999999999.99999999")
  ) return null;
  // USD is the accounting base currency: an exchange rate other than 1
  // would make the stored container FX disagree with its USD postings.
  if (currencyCode.trim().toUpperCase() === "USD" && !rate.eq(1)) return null;
  return rate;
}

export const CONTAINER_MANUAL_FX_INVALID =
  "Enter a valid positive manual FX rate (up to 8 decimal places). USD must be 1.";
