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

export async function sendUniversalExcelWorkbook(
  response: ServerResponse,
  filename: string,
  spec: UniversalExcelWorkbookSpec
): Promise<UniversalExcelSheetResult[]> {
  const safeName = validateUniversalExcelFilename(filename);
  const { workbook, results } = buildUniversalExcelWorkbook(spec);
  await writeWorkbookToResponse(workbook, response, safeName);
  return results;
}

/** For workflows that explicitly require XLSX bytes (e.g., attachments). */
export async function buildUniversalExcelAttachment(
  spec: UniversalExcelWorkbookSpec
): Promise<{ buffer: Buffer; results: UniversalExcelSheetResult[] }> {
  const { workbook, results } = buildUniversalExcelWorkbook(spec);
  return { buffer: await writeWorkbook(workbook), results };
}
