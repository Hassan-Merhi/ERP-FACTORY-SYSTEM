// Extracted from ./generate.ts to keep that module under the source-size cap.
import { nk } from "./layout";

/**
 * Resolve any lookup key to a value, trying:
 *   1. Direct hit in map
 *   2. Via alias map (original key)
 *   3. Via alias map (normalized key)
 *   4. Direct hit on normalized key
 * Falls through all keys in order.
 */
export function resolveFromMap<V>(map: Map<string, V>, alias: Map<string, string>, ...keys: string[]): V | undefined {
  for (const k of keys) {
    if (!k) continue;
    if (map.has(k)) return map.get(k);
    const c = alias.get(k) ?? alias.get(nk(k));
    if (c && map.has(c)) return map.get(c);
    if (map.has(nk(k))) return map.get(nk(k));
  }
  return undefined;
}
