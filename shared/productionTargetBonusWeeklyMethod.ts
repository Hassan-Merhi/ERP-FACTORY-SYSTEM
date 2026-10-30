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

/** Accept keyboard-entered ISO or US-style dates without changing partial input. */
export function parseTypedProductionBonusDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!iso && !us) return null;
  const year = iso ? iso[1] : us![3];
  const month = iso ? iso[2] : us![1];
  const day = iso ? iso[3] : us![2];
  const normalized = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isBonusCategoryDate(normalized) ? normalized : null;
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
