/** Normalize destination names for proformas and agreed prices. */
export function normalizeProformaDestination(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase()
    .replace(/[\u2019\u2018]/g, "'");
  if (!normalized || normalized.length > 120) return null;
  if (["LUBUMBASHI", "LSHI", "L'SHI", "L SHI"].includes(normalized)) return "L'SHI";
  if (normalized === "MALI 53") return "MALI";
  // Historical proformas use KALEMIE while the saved destination price list
  // was created as KALEME. Treat these spellings as one destination.
  if (normalized === "KALEMIE") return "KALEME";
  return normalized;
}
