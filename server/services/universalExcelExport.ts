/**
 * HTTP and attachment adapters for the opt-in shared workbook engine.
 * Retain the existing heavy-export queue and safe ExcelJS 3.x writeBuffer
 * pipeline; do not use workbook.xlsx.write(response).
 *
 * Callers must enforce authentication, tenant scoping and hidden-cost
 * permissions BEFORE preparing the report data.
 */
import type { ServerResponse } from "node:http";
import type { UniversalExcelWorkbookSpec, UniversalExcelSheetResult } from "../../shared/universal-excel/engine";
import { buildUniversalExcelWorkbook } from "../../shared/universal-excel/engine";
import { validateUniversalExcelFilename } from "../../shared/universal-excel/filename";
import { writeWorkbook, writeWorkbookToResponse } from "../excelHelper";
import { loadCompanyExcelAppearance } from "./excelAppearanceSettings";

export async function sendUniversalExcelWorkbook(
  response: ServerResponse,
  filename: string,
  spec: UniversalExcelWorkbookSpec,
  companyId?: number
): Promise<UniversalExcelSheetResult[]> {
  const safeName = validateUniversalExcelFilename(filename);
  const appearance = companyId && spec.mode === "report" && !spec.appearance
    ? await loadCompanyExcelAppearance(companyId) : null;
  const { workbook, results } = buildUniversalExcelWorkbook(
    appearance ? { ...spec, appearance, dateFormat: spec.dateFormat ?? appearance.dateFormat } : spec
  );
  await writeWorkbookToResponse(workbook, response, safeName);
  return results;
}

/** For workflows that explicitly require XLSX bytes (e.g., attachments). */
export async function buildUniversalExcelAttachment(
  spec: UniversalExcelWorkbookSpec,
  companyId?: number
): Promise<{ buffer: Buffer; results: UniversalExcelSheetResult[] }> {
  const appearance = companyId && spec.mode === "report" && !spec.appearance
    ? await loadCompanyExcelAppearance(companyId) : null;
  const { workbook, results } = buildUniversalExcelWorkbook(
    appearance ? { ...spec, appearance, dateFormat: spec.dateFormat ?? appearance.dateFormat } : spec
  );
  return { buffer: await writeWorkbook(workbook), results };
}
