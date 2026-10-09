/**
 * Shared state and helpers for the supplierBalanceRoutes routes.
 *
 * Extracted verbatim from the former single-file supplierBalanceRoutes.ts.
 */
import { resolveStoredFxRate } from "../../../../services/factory/currencyConversion";

// Resolves a display/aggregate FX rate for the with-balances summary: prefers the
// user-configured company rate, then the row's own confirmed rate; returns 0 (never a
// silent 1) when neither is available, so that currency's contribution to the USD total
// is excluded rather than guessed — callers should treat a 0 result as "unresolved".
export function resolveDisplayFx(
  ccy: string,
  configuredRate: number | undefined,
  storedRate: string | number | null | undefined,
  confirmed?: boolean
): number {
  if (ccy === "USD") return 1;
  if (configuredRate !== undefined) return configuredRate;
  const { fxRate, looksSet } = resolveStoredFxRate(ccy, storedRate, confirmed);
  return looksSet ? fxRate : 0;
}

export const PAYABLE_CONTAINER_STATUSES = new Set(["OFFLOADED", "RECEIVED", "PARTIALLY_RECEIVED"]);

export const isPayableContainer = (c: Record<string, unknown>) =>
  PAYABLE_CONTAINER_STATUSES.has(String(c.status || "").toUpperCase());

/** True when freight should be included in the supplier's payable balance.
 *  Explicit freightPaidBy flag takes priority.
 *  For legacy offloaded containers missing the flag: the offload route always
 *  sets freightSupplierId when it credits the supplier — so if that column is
 *  null on an already-offloaded container, the freight went to an own account. */
export const isSupplierPaidFreight = (c: Record<string, unknown>): boolean => {
  if (c.freightPaidBy === "own") return false;
  if (c.freightPaidBy === "supplier") return true;
  // freightPaidBy is null (legacy row): use freightSupplierId as ground truth
  // only for containers that have already been offloaded (offload always writes
  // freightSupplierId for supplier-paid freight, leaves it null for own-account).
  const offloadedStatuses = new Set(["OFFLOADED", "RECEIVED", "PARTIALLY_RECEIVED"]);
  if (offloadedStatuses.has(String(c.status || "").toUpperCase())) {
    return c.freightSupplierId !== null && c.freightSupplierId !== undefined;
  }
  // Pending / OTW: default to "supplier" (legacy behaviour; determined at offload).
  return true;
};

// One implementation serves the supplier list, the broker statement page and
// net position, so they all read the same exact balances.
export { buildBrokerStatement } from "../broker/_helpers";
