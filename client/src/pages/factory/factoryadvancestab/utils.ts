/**
 * Pure helpers and lookup tables for the FactoryAdvancesTab page.
 *
 * Extracted from FactoryAdvancesTab.tsx during the Phase 4 god-file split.
 */

import { formatUsd } from "@/lib/moneyDisplay";

export function fmt(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  return isNaN(n) ? "$0.00" : formatUsd(n, 2);
}
