/**
 * Browser adapter. Call from an export-button handler, not at initial page
 * load: ExcelJS and the existing compatibility helper must remain lazy.
 */
import type { UniversalExcelWorkbookSpec, UniversalExcelSheetResult } from "@shared/universal-excel/engine";
import { validateUniversalExcelFilename } from "@shared/universal-excel/filename";

export async function downloadUniversalExcelWorkbook(
  spec: UniversalExcelWorkbookSpec,
  fileName: string
): Promise<UniversalExcelSheetResult[]> {
  const safeName = validateUniversalExcelFilename(fileName);
  const [{ buildUniversalExcelWorkbook }, { writeFile }] = await Promise.all([
    import("@shared/universal-excel/engine"),
    import("@/lib/excelHelper"),
  ]);
  const { workbook, results } = buildUniversalExcelWorkbook(spec);
  await writeFile(workbook, safeName);
  return results;
}
