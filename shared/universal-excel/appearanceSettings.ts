/** Company-scoped Phase 9 Excel report appearance contract.
 * Strict parsing ensures this public/read-only export setting cannot carry
 * untrusted URLs, spreadsheet formulas, invalid colors or oversized images.
 */
import { z } from "zod";
import { resolveUniversalExcelAppearance, type UniversalExcelAppearance } from "./design";

const safeLabel = z.string().trim().min(1).max(70).refine(
  text => !Array.from(text).some(char => char.charCodeAt(0) < 32 || char === "&"),
  "Excel print labels cannot include control characters or &"
);
const safeExtra = z.string().trim().max(90).refine(
  text => !Array.from(text).some(char => char.charCodeAt(0) < 32 || char === "&"),
  "Excel print text cannot include control characters or &"
);
const imageDataUrl = z.string().max(185_000).refine(
  text => /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(text),
  "Logo must be a small PNG or JPEG data URL"
).refine(text => {
  const body = text.substring(text.indexOf(",") + 1);
  const byteLength = Math.floor(body.length * 3 / 4) - (body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0);
  return byteLength <= 135_000 &&
    (text.startsWith("data:image/png;base64,iVBORw0KGgo") ||
     text.startsWith("data:image/jpeg;base64,/9j/"));
}, "Logo must be a PNG/JPEG under 135 KB");

export const excelAppearanceSettingsSchema = z.object({
  preset: z.enum(["dakzo", "slate"]),
  brandName: safeLabel,
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  showBranding: z.boolean(),
  alternateRows: z.boolean(),
  printLayout: z.boolean(),
  showCompanyName: z.boolean(),
  showExportDate: z.boolean(),
  dateFormat: z.enum(["dd/mm/yyyy", "mm/dd/yyyy"]),
  headerText: safeExtra,
  footerText: safeExtra,
  logoDataUrl: imageDataUrl.nullable(),
}).strict();

export type ExcelAppearanceSettings = z.infer<typeof excelAppearanceSettingsSchema>;

export const DEFAULT_EXCEL_APPEARANCE_SETTINGS: ExcelAppearanceSettings = {
  preset: "dakzo",
  brandName: "DAKZO SYSTEMS",
  accentColor: "#183153",
  showBranding: true,
  alternateRows: true,
  printLayout: true,
  showCompanyName: true,
  showExportDate: true,
  dateFormat: "dd/mm/yyyy",
  headerText: "",
  footerText: "",
  logoDataUrl: null,
};

/** Treat malformed or legacy saved rows as default, never interpret arbitrary JSON. */
export function parseSavedExcelAppearance(value: string | null | undefined): ExcelAppearanceSettings {
  if (!value) return { ...DEFAULT_EXCEL_APPEARANCE_SETTINGS };
  try {
    const parsed: unknown = JSON.parse(value);
    const result = excelAppearanceSettingsSchema.safeParse(parsed);
    return result.success ? result.data : { ...DEFAULT_EXCEL_APPEARANCE_SETTINGS };
  } catch {
    return { ...DEFAULT_EXCEL_APPEARANCE_SETTINGS };
  }
}

export function validateExcelAppearance(value: unknown): ExcelAppearanceSettings {
  const settings = excelAppearanceSettingsSchema.parse(value);
  resolveUniversalExcelAppearance(settings satisfies UniversalExcelAppearance);
  return settings;
}
