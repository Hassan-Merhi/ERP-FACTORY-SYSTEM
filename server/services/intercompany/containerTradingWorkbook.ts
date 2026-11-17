/**
 * Phase 2 intercompany trading: workbook input contract, validation helpers and
 * the Excel parser shared by the preview and the atomic import.
 */
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { stockItemCodeAliases, stockItems } from "@shared/schema";
import { db } from "../../db";
import { readExcel, sheetToJson } from "../../excelHelper";
import { toMoney } from "../../lib/money";
import { parsePoImportSheetRows, type ParsedContainerPreview } from "../../routes/import/poImportExcelParser";
import { createContainerImportPlan } from "./containerImportPlan";

const positive = z.number().int().positive();
export const importInputSchema = z.object({
  externalSupplierId: positive,
  importDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  selections: z
    .array(
      z.object({
        containerNumber: z.string().trim().min(1).max(100),
        relationshipId: positive,
        chargesConfirmed: z.boolean(),
        chargeEvidenceReference: z.string().trim().max(250).optional(),
      })
    )
    .min(1)
    .max(100),
});
export type IntercompanyImportInput = z.infer<typeof importInputSchema>;

export interface WorkbookPreview {
  fileName: string;
  sha256: string;
  md5: string;
  rowCount: number;
  containers: ParsedContainerPreview[];
}

export class TradingImportError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "INTERCOMPANY_IMPORT_INVALID"
  ) {
    super(message);
    this.name = "TradingImportError";
  }
}

export function assert(condition: unknown, message: string, code?: string): asserts condition {
  if (!condition) throw new TradingImportError(400, message, code);
}

export const money = (v: string | number) => toMoney(v).toDecimalPlaces(2);
export const normalizedName = (v: string) =>
  v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
export function generatedPoNumber(prefix: string, physical: string, key: string) {
  return (
    prefix +
    physical.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 42) +
    "-" +
    createHash("sha256").update(key).digest("hex").slice(0, 10)
  );
}

export function validateWorkbookSelections(preview: WorkbookPreview, input: IntercompanyImportInput) {
  const byName = new Map(preview.containers.map((p) => [p.containerNumber, p]));
  assert(byName.size === preview.containers.length, "Duplicate physical container number in workbook");
  assert(
    new Set(preview.containers.map((p) => p.containerNumber.trim().toUpperCase())).size === preview.containers.length,
    "Duplicate physical container number ignoring case in workbook"
  );
  assert(input.selections.length === preview.containers.length, "Select exactly one destination for every container");
  const unique = new Set<string>();
  return input.selections.map((selection) => {
    assert(!unique.has(selection.containerNumber), "Duplicate destination selection: " + selection.containerNumber);
    unique.add(selection.containerNumber);
    const original = byName.get(selection.containerNumber);
    assert(original, "Selected container is not in the uploaded workbook: " + selection.containerNumber);
    try {
      return createContainerImportPlan(original, selection);
    } catch (error) {
      throw new TradingImportError(400, error instanceof Error ? error.message : "Invalid workbook container");
    }
  });
}

/** Always re-read the actual uploaded bytes, including at confirmation. */
export async function parseIntercompanyWorkbook(
  file: Buffer,
  name: string,
  companyId: number
): Promise<WorkbookPreview> {
  assert(file.length > 0 && file.length <= 10 * 1024 * 1024, "Upload an Excel file under 10 MB");
  assert(/\.xlsx$/i.test(name), "Only .xlsx workbooks are supported by this Excel parser");
  const workbook = await readExcel(file);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  assert(sheet, "Excel file has no worksheet");
  const rows = sheetToJson(sheet);
  assert(rows.length > 0 && rows.length <= 100_000, "Excel file is empty or too large");
  const items = await db
    .select()
    .from(stockItems)
    .where(and(eq(stockItems.companyId, companyId), eq(stockItems.active, true), isNull(stockItems.deletedAt)));
  const aliases = await db.select().from(stockItemCodeAliases).where(eq(stockItemCodeAliases.companyId, companyId));
  const codes = new Map(items.map((item) => [item.code.toLowerCase(), item]));
  for (const alias of aliases) {
    const item = items.find((row) => row.id === alias.stockItemId);
    if (item) codes.set(alias.aliasCode.toLowerCase(), item);
  }
  const parsed = await parsePoImportSheetRows(rows, {
    getStockItemByCodeOrAlias: async (code) => codes.get(code.toLowerCase()),
    allStockItems: items,
  });
  if (!parsed.ok)
    throw new TradingImportError(
      400,
      parsed.kind === "row-errors" ? parsed.errors.join("; ") : "Excel file has no purchase items"
    );
  assert(parsed.preview.length > 0 && parsed.preview.length <= 100, "A workbook must contain 1–100 containers");
  return {
    fileName: name.slice(0, 255),
    sha256: createHash("sha256").update(file).digest("hex"),
    md5: createHash("md5").update(file).digest("hex"),
    rowCount: rows.length,
    containers: parsed.preview,
  };
}
