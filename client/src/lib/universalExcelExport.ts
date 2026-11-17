/**
 * Browser adapter. Call from an export-button handler, not at initial page
 * load: ExcelJS and the existing compatibility helper must remain lazy.
 */
import type { UniversalExcelWorkbookSpec, UniversalExcelSheetResult } from "@shared/universal-excel/engine";
import { validateUniversalExcelFilename } from "@shared/universal-excel/filename";
import { fetchExcelAppearance } from "./excelAppearanceClient";

export async function downloadUniversalExcelWorkbook(
  spec: UniversalExcelWorkbookSpec,
  fileName: string
): Promise<UniversalExcelSheetResult[]> {
  const safeName = validateUniversalExcelFilename(fileName);
  // Saved branding is applied to reports only; strict import templates retain
  // their current first-row/absolute-cell contracts and need no settings call.
  const saved = spec.mode === "report" && !spec.appearance ? await fetchExcelAppearance() : null;
  const resolvedSpec: UniversalExcelWorkbookSpec = saved
    ? {
        ...spec,
        appearance: saved.appearance,
        companyName: spec.companyName ?? saved.companyName,
        dateFormat: spec.dateFormat ?? saved.appearance.dateFormat,
      }
    : spec;
  const [{ buildUniversalExcelWorkbook }, { writeFile }] = await Promise.all([
    import("@shared/universal-excel/engine"),
    import("@/lib/excelHelper"),
  ]);
  const { workbook, results } = buildUniversalExcelWorkbook(resolvedSpec);
  await writeFile(workbook, safeName);
  return results;
}
