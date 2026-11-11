import { FEATURE_KEYS, type FeatureKey } from "./schema/common";

/**
 * Validate the exact ERP page-grant set before changing authorizations.
 *
 * The endpoint accepts only currently registered feature keys. Unknown names,
 * duplicates and non-string input must never clear existing permissions as a
 * side-effect of malformed input.
 */
export function parseErpPageGrantKeys(value: unknown): FeatureKey[] | null {
  if (!Array.isArray(value)) return null;

  const available = new Set<string>(FEATURE_KEYS);
  const seen = new Set<string>();
  const result: FeatureKey[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !available.has(entry) || seen.has(entry)) return null;
    seen.add(entry);
    result.push(entry as FeatureKey);
  }
  return result;
}

/**
 * Existing ERP cost-visibility flags include six legacy restrictions as well
 * as the three checkboxes currently exposed by user settings. Preserve all
 * recognized historical values: silently dropping them would reveal data.
 */
export const ERP_HIDDEN_COST_FIELD_KEYS = [
  "accounts_balances",
  "analytics_financials",
  "container_costs",
  "daybook_amounts",
  "stock_rates",
  "voucher_amounts",
  "sales_profit_cost",
  "hide_export_selling_price",
  "hide_export_cost_price",
] as const;

export function parseErpHiddenCostFields(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const allowed = new Set<string>(ERP_HIDDEN_COST_FIELD_KEYS);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.has(entry) || seen.has(entry)) return null;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}
