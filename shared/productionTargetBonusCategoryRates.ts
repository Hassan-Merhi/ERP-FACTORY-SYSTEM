import Decimal from "decimal.js";

/** Phase 8: category-level rate configuration, NOT a payment calculator.
 * A rate is only applied to category-attributed excess bales in later phases;
 * never multiply a whole worker-day by one category after an intra-day switch.
 */
export interface ProductionBonusCategoryRateVersion {
  id: number;
  categoryKey: string;
  categoryLabel: string;
  effectiveFrom: string;
  enabled: boolean;
  ratePerExtraBale: string;
}

export function normalizeBonusCategory(value: unknown): { key: string; label: string } | null {
  if (typeof value !== "string") return null;
  const label = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (
    !label ||
    label.length > 100 ||
    Array.from(label).some((char) => (char.codePointAt(0) ?? 0) < 0x20 || char === "\u007F")
  )
    return null;
  return { key: label.toLocaleLowerCase("en-US"), label };
}

export function isBonusCategoryDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T12:00:00.000Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function parseBonusCategoryRate(value: unknown): string | null {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^(?:0|[1-9]\d{0,4})(?:\.\d{1,4})?$/.test(String(value))
  )
    return null;
  const amount = new Decimal(String(value));
  if (!amount.isFinite() || amount.isNegative() || amount.greaterThan(10000)) return null;
  return amount.toFixed(4);
}

/** Choose the most recent effective version in this category, breaking same-day ties by ID. */
export function resolveBonusCategoryRate(
  category: string,
  productionDate: string,
  versions: ProductionBonusCategoryRateVersion[]
): ProductionBonusCategoryRateVersion | null {
  const normalized = normalizeBonusCategory(category);
  if (!normalized || !isBonusCategoryDate(productionDate)) return null;
  return (
    versions
      .filter((version) => version.categoryKey === normalized.key && version.effectiveFrom <= productionDate)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.id - a.id)[0] ?? null
  );
}
