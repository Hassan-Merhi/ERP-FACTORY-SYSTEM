/**
 * Canonical Priority Scan palette, in the approved display order.
 *
 * These values govern NEW priority selections. Never migrate or rewrite
 * historical allocation colors or print snapshots to match this list.
 */
export const PRIORITY_SCAN_COLORS = [
  "#7FFF00",
  "#FFD700",
  "#808000",
  "#B22222",
  "#9400D3",
  "#DAA520",
  "#6A5ACD",
  "#FFB6C1",
  "#F7E7CE",
  "#614051",
  "#B0E0E6",
] as const;

export type PriorityScanColor = (typeof PRIORITY_SCAN_COLORS)[number];

export const DEFAULT_PRIORITY_SCAN_COLOR: PriorityScanColor = PRIORITY_SCAN_COLORS[0];

/** Comparison is case-insensitive; historical saved colors remain untouched. */
export function isApprovedPriorityScanColor(value: unknown): value is PriorityScanColor {
  return typeof value === "string" && PRIORITY_SCAN_COLORS.some((color) => color.toLowerCase() === value.toLowerCase());
}
