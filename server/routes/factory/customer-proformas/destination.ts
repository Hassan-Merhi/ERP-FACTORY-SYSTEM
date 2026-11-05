/** Normalize destination names for proformas and agreed prices. */
export function normalizeProformaDestination(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ").toUpperCase().replace(/[\u2019\u2018]/g, "'");
  if (!normalized || normalized.length > 120) return null;
  if (["LUBUMBASHI", "LSHI", "L'SHI", "L SHI"].includes(normalized)) return "L'SHI";
  if (normalized === "MALI 53") return "MALI";
  return normalized;
}
