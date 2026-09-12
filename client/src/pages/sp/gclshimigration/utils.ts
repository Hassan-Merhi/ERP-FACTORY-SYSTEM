/**
 * Pure helpers and lookup tables for the GcLshiMigration page.
 *
 * Extracted from GcLshiMigration.tsx during the Phase 4 god-file split.
 */

export function fmtNum(n: number | string | undefined | null) {
  return Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
