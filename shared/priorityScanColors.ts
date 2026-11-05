/**
 * Canonical Priority Scan palette, in the approved display order.
 *
 * These values govern NEW priority selections. Never migrate or rewrite
 * historical allocation colors or print snapshots to match this list.
 */
export const PRIORITY_SCAN_COLORS = [
  "#9400D3",
  "#F28500",
  "#FFD700",
  "#39FF14",
  "#808000",
  "#B22222",
  "#6A5ACD",
  "#000000",
  "#B0E0E6",
  "#DB7093",
  "#A7FC00",
] as const;

export type PriorityScanColor = (typeof PRIORITY_SCAN_COLORS)[number];

export const DEFAULT_PRIORITY_SCAN_COLOR: PriorityScanColor = PRIORITY_SCAN_COLORS[0];

/**
 * Fixed display letters for the eleven approved colors.
 *
 * Letters are identities of color HEX values, not queue positions; changing
 * priority, changing companies or reprinting does not remap a saved color.
 * Historical colors outside today's palette deliberately have no letter.
 */
export const PRIORITY_SCAN_COLOR_LETTERS = {
  "#9400D3": "D",
  "#F28500": "N",
  "#FFD700": "O",
  "#39FF14": "P",
  "#808000": "Q",
  "#B22222": "R",
  "#6A5ACD": "S",
  "#000000": "T",
  "#B0E0E6": "U",
  "#DB7093": "V",
  "#A7FC00": "C",
} as const satisfies Record<PriorityScanColor, string>;

export type PriorityScanLetter = (typeof PRIORITY_SCAN_COLOR_LETTERS)[PriorityScanColor];

/** Case-insensitive HEX lookup for UI badges; no database writes or history rewrite. */
export function getPriorityScanLetter(color: unknown): PriorityScanLetter | null {
  if (typeof color !== "string") return null;
  const approvedColor = PRIORITY_SCAN_COLORS.find((hex) => hex.toLowerCase() === color.toLowerCase());
  return approvedColor ? PRIORITY_SCAN_COLOR_LETTERS[approvedColor] : null;
}

/** Choose legible black/white lettering on the approved swatch background. */
export function getPriorityScanLetterInk(color: unknown): "#000000" | "#FFFFFF" {
  if (typeof color !== "string" || !getPriorityScanLetter(color)) return "#FFFFFF";
  const rgb = [1, 3, 5].map((offset) => {
    const component = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return luminance > 0.179 ? "#000000" : "#FFFFFF";
}

/** Comparison is case-insensitive; historical saved colors remain untouched. */
export function isApprovedPriorityScanColor(value: unknown): value is PriorityScanColor {
  return typeof value === "string" && PRIORITY_SCAN_COLORS.some((color) => color.toLowerCase() === value.toLowerCase());
}
