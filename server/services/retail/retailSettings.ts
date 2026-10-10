/**
 * Retail Wave 2 selling settings (discount/override approval policy + tax).
 *
 * One row per retail company. When a company has never saved settings the defaults
 * below apply, so every existing retail company keeps the pre-Wave-2 behaviour:
 * discounts are allowed up to 10% without approval, overrides need a manager, and
 * tax is off.
 */
import { eq } from "drizzle-orm";
import { RETAIL_DEFAULT_DISCOUNT_LIMIT_PERCENT, retailPosSettings } from "@shared/schema";
import { db } from "../../db";

export interface RetailSellingSettings {
  discountLimitPercent: number;
  requireManagerApproval: boolean;
  priceOverrideRequiresApproval: boolean;
  taxEnabled: boolean;
  taxLabel: string;
  /** Fraction, e.g. 0.18 for 18%. */
  taxRate: number;
  taxInclusive: boolean;
}

export const DEFAULT_RETAIL_SELLING_SETTINGS: RetailSellingSettings = {
  discountLimitPercent: RETAIL_DEFAULT_DISCOUNT_LIMIT_PERCENT,
  requireManagerApproval: true,
  priceOverrideRequiresApproval: true,
  taxEnabled: false,
  taxLabel: "Tax",
  taxRate: 0,
  taxInclusive: false,
};

type SettingsRow = typeof retailPosSettings.$inferSelect;

function toNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeRetailSettings(row: SettingsRow | null | undefined): RetailSellingSettings {
  if (!row) return { ...DEFAULT_RETAIL_SELLING_SETTINGS };
  return {
    discountLimitPercent: Math.min(Math.max(toNumber(row.discountLimitPercent, 10), 0), 100),
    requireManagerApproval: row.requireManagerApproval !== false,
    priceOverrideRequiresApproval: row.priceOverrideRequiresApproval !== false,
    taxEnabled: row.taxEnabled === true,
    taxLabel: (row.taxLabel ?? "Tax").trim() || "Tax",
    taxRate: Math.min(Math.max(toNumber(row.taxRate, 0), 0), 0.99999),
    taxInclusive: row.taxInclusive === true,
  };
}

export async function loadRetailSettings(
  companyId: number,
  executor: Pick<typeof db, "select"> = db
): Promise<RetailSellingSettings> {
  const [row] = await executor
    .select()
    .from(retailPosSettings)
    .where(eq(retailPosSettings.companyId, companyId))
    .limit(1);
  return normalizeRetailSettings(row);
}

export interface RetailSettingsPatch {
  discountLimitPercent?: number;
  requireManagerApproval?: boolean;
  priceOverrideRequiresApproval?: boolean;
  taxEnabled?: boolean;
  taxLabel?: string;
  taxRate?: number;
  taxInclusive?: boolean;
}

/** Validates a settings patch and throws a user-facing error for bad values. */
export function validateRetailSettingsPatch(patch: RetailSettingsPatch): RetailSettingsPatch {
  const next: RetailSettingsPatch = {};
  if (patch.discountLimitPercent !== undefined) {
    const value = Number(patch.discountLimitPercent);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error("Discount limit percent must be between 0 and 100");
    }
    next.discountLimitPercent = value;
  }
  for (const key of [
    "requireManagerApproval",
    "priceOverrideRequiresApproval",
    "taxEnabled",
    "taxInclusive",
  ] as const) {
    if (patch[key] !== undefined) next[key] = Boolean(patch[key]);
  }
  if (patch.taxLabel !== undefined) {
    const label = String(patch.taxLabel).trim();
    if (label.length > 40) throw new Error("Tax label cannot exceed 40 characters");
    next.taxLabel = label || "Tax";
  }
  if (patch.taxRate !== undefined) {
    const value = Number(patch.taxRate);
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new Error("Tax rate must be between 0 and 1 (for example 0.18 for 18%)");
    }
    next.taxRate = value;
  }
  return next;
}

/** Upserts the settings row and returns the stored, normalized settings. */
export async function saveRetailSettings(
  companyId: number,
  patch: RetailSettingsPatch,
  updatedBy: string | null
): Promise<RetailSellingSettings> {
  const clean = validateRetailSettingsPatch(patch);
  const current = await loadRetailSettings(companyId);
  const merged: RetailSellingSettings = { ...current, ...clean };
  await db
    .insert(retailPosSettings)
    .values({
      companyId,
      discountLimitPercent: String(merged.discountLimitPercent),
      requireManagerApproval: merged.requireManagerApproval,
      priceOverrideRequiresApproval: merged.priceOverrideRequiresApproval,
      taxEnabled: merged.taxEnabled,
      taxLabel: merged.taxLabel,
      taxRate: String(merged.taxRate),
      taxInclusive: merged.taxInclusive,
      updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: retailPosSettings.companyId,
      set: {
        discountLimitPercent: String(merged.discountLimitPercent),
        requireManagerApproval: merged.requireManagerApproval,
        priceOverrideRequiresApproval: merged.priceOverrideRequiresApproval,
        taxEnabled: merged.taxEnabled,
        taxLabel: merged.taxLabel,
        taxRate: String(merged.taxRate),
        taxInclusive: merged.taxInclusive,
        updatedBy,
        updatedAt: new Date(),
      },
    });
  return merged;
}
