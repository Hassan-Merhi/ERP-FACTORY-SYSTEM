import Decimal from "decimal.js";
import { isBonusCategoryDate } from "./productionTargetBonusCategoryRates";

/** Phase 12 settings only. These rules must not activate an award/payment path. */
export type ProductionBonusMethod = "per_extra_bale" | "weekly_flat";

export interface ProductionBonusWeeklyMethodVersion {
  id: number;
  method: ProductionBonusMethod;
  effectiveWeek: string;
  flatBonusUsd: string;
}

export function mondayOfProductionBonusWeek(day: unknown): string | null {
  if (!isBonusCategoryDate(day)) return null;
  const date = new Date(day + "T12:00:00.000Z");
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - ((weekday + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export function parseWeeklyFlatBonusUsd(value: unknown): string | null {
  if ((typeof value !== "string" && typeof value !== "number") ||
      !/^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,2})?$/.test(String(value))) return null;
  const amount = new Decimal(String(value));
  if (!amount.isFinite() || amount.isNegative() || amount.greaterThan(100000)) return null;
  return amount.toFixed(2);
}

/** Weekly versions take effect at the beginning of a Monday-Sunday production week. */
export function resolveProductionBonusWeeklyMethod(
  asOf: string,
  versions: ProductionBonusWeeklyMethodVersion[],
): ProductionBonusWeeklyMethodVersion | null {
  const week = mondayOfProductionBonusWeek(asOf);
  if (!week) return null;
  return versions.filter(version => version.effectiveWeek <= week)
    .sort((a, b) => b.effectiveWeek.localeCompare(a.effectiveWeek) || b.id - a.id)[0] ?? null;
}
