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
