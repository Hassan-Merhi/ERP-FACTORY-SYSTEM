/**
 * Per-company Excel appearance: one existing system_settings row per company.
 * No new database tables and no cross-company request parameters.
 */
import { eq } from "drizzle-orm";
import { systemSettings } from "@shared/schema";
import { db } from "../db";
import {
  parseSavedExcelAppearance,
  validateExcelAppearance,
  type ExcelAppearanceSettings,
} from "@shared/universal-excel/appearanceSettings";

export function excelAppearanceSettingKey(companyId: number): string {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    throw new Error("Invalid Excel settings company");
  }
  return "excel_appearance_c_" + companyId;
}

export function canManageExcelAppearance(role: string | null | undefined): boolean {
  return role === "Admin" || role === "Developer";
}

export async function loadCompanyExcelAppearance(companyId: number): Promise<ExcelAppearanceSettings> {
  const key = excelAppearanceSettingKey(companyId);
  const [row] = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1);
  return parseSavedExcelAppearance(row?.value);
}

export async function saveCompanyExcelAppearance(
  companyId: number,
  raw: unknown
): Promise<ExcelAppearanceSettings> {
  const validated = validateExcelAppearance(raw);
  const key = excelAppearanceSettingKey(companyId);
  const value = JSON.stringify(validated);
  await db.insert(systemSettings).values({ key, value }).onConflictDoUpdate({
    target: systemSettings.key,
    set: { value, updatedAt: new Date() },
  });
  return validated;
}
