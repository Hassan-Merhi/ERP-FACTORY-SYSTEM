/** Fresh company-scoped settings, loaded at export-click time.
 * Never use a stale global appearance after switching companies.
 */
import {
  excelAppearanceSettingsSchema,
  type ExcelAppearanceSettings,
} from "@shared/universal-excel/appearanceSettings";

export interface ExcelAppearanceResponse {
  appearance: ExcelAppearanceSettings;
  companyName: string;
}

export async function fetchExcelAppearance(): Promise<ExcelAppearanceResponse> {
  const res = await fetch("/api/excel-export/appearance", {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Could not load company Excel appearance (" + res.status + ")");
  const raw: unknown = await res.json();
  if (!raw || typeof raw !== "object" || !("appearance" in raw)) {
    throw new Error("Invalid company Excel appearance response");
  }
  const appearance = excelAppearanceSettingsSchema.parse(raw.appearance);
  const name = "companyName" in raw && typeof raw.companyName === "string"
    ? raw.companyName : "";
  return { appearance, companyName: name };
}

/** Optional enhancement for older customized print workbooks. If the settings
 * endpoint is unreachable, the original export is still usable unchanged. */
export async function optionalSpecializedExcelAppearance(): Promise<ExcelAppearanceSettings | undefined> {
  try {
    return (await fetchExcelAppearance()).appearance;
  } catch {
    return undefined;
  }
}
