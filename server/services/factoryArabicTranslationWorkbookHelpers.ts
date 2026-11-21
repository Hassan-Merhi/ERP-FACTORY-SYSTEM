// Extracted from ./factoryArabicTranslationWorkbook.ts
import ExcelJS from "exceljs";
import { type FactoryArabicImportMode } from "@shared/factoryBilingualContract";

export type TranslationImportMode = FactoryArabicImportMode;

export interface TranslationCatalogProduct {
  id: number;
  categoryId: number | null;
  articleCode: string | null;
  name: string | null;
  nameAr: string | null;
  descriptionAr: string | null;
  categoryName: string | null;
  categoryNameAr: string | null;
}

export interface TranslationWorkbookRow {
  rowNumber: number;
  articleCode: string;
  productNameAr: string;
  categoryNameAr: string;
  descriptionAr: string;
}

export type TranslationPreviewStatus =
  "update" | "unchanged" | "unknown" | "duplicate" | "invalid" | "category-conflict" | "ambiguous";

export interface TranslationPreviewRow extends TranslationWorkbookRow {
  productId?: number;
  categoryId?: number | null;
  status: TranslationPreviewStatus;
  reasons: string[];
  currentProductNameAr: string | null;
  currentCategoryNameAr: string | null;
  currentDescriptionAr: string | null;
  targetProductNameAr: string | null;
  targetCategoryNameAr: string | null;
  targetDescriptionAr: string | null;
  changes: {
    productNameAr: boolean;
    categoryNameAr: boolean;
    descriptionAr: boolean;
  };
}

export interface TranslationPreview {
  totalRows: number;
  matchedProducts: number;
  unchangedRows: number;
  rowsToApply: number;
  productsToUpdate: number;
  categoriesToUpdate: number;
  unknownArticleCodes: string[];
  duplicateArticleCodes: string[];
  ambiguousArticleCodes: string[];
  blankOrInvalidArabicNames: number;
  categoryConflicts: number;
  blocked: boolean;
  rows: TranslationPreviewRow[];
}

export interface TranslationPreviewEnvelope extends TranslationPreview {
  mode: TranslationImportMode;
  workbookSha256: string;
  previewToken: string;
}

export const ARABIC_TRANSLATION_TEMPLATE_HEADERS = [
  "Article Code / Barcode",
  "English Product Name",
  "Arabic Product Name",
  "English Category",
  "Arabic Category",
  "Arabic Description",
  "Current Translation Status",
] as const;

export const CONTROL_CHARACTER_PATTERN = {
  test(value: string): boolean {
    return Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
    });
  },
};

export const RTL_FROZEN_VIEW: ExcelJS.WorksheetView = {
  state: "frozen",
  xSplit: 0,
  ySplit: 1,
  topLeftCell: "A2",
  rightToLeft: true,
  activeCell: "A2",
  showRuler: true,
  showRowColHeaders: true,
  showGridLines: true,
  zoomScale: 100,
  zoomScaleNormal: 100,
};

export function clean(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return clean(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return clean(value);

  const objectValue = value as unknown as Record<string, unknown>;
  if (Array.isArray(objectValue.richText)) {
    return objectValue.richText
      .map((part) => (typeof part === "object" && part ? clean((part as Record<string, unknown>).text) : ""))
      .join("")
      .trim();
  }
  if (objectValue.result !== undefined && objectValue.result !== null) return clean(objectValue.result);
  if (objectValue.text !== undefined && objectValue.text !== null) return clean(objectValue.text);
  return "";
}

function setCellLocked(cell: ExcelJS.Cell, locked: boolean): void {
  cell.style = {
    ...cell.style,
    protection: {
      locked,
      hidden: false,
    },
  };
}

function translationStatus(product: TranslationCatalogProduct): string {
  if (!clean(product.nameAr)) return "Missing Arabic Product Name";
  if (product.categoryId && !clean(product.categoryNameAr)) return "Missing Arabic Category";
  return "Complete";
}

export function selectedValue(
  currentValue: string | null,
  workbookValue: string,
  mode: TranslationImportMode
): string | null {
  const current = clean(currentValue);
  const supplied = clean(workbookValue);
  return mode === "fill-missing" ? current || supplied || null : supplied || current || null;
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].filter(Boolean).sort((left, right) => left.localeCompare(right));
}

export function previewFingerprintPayload(input: {
  companyId: number;
  mode: TranslationImportMode;
  workbookSha256: string;
  preview: TranslationPreview;
}) {
  return {
    companyId: input.companyId,
    mode: input.mode,
    workbookSha256: input.workbookSha256,
    blocked: input.preview.blocked,
    rows: input.preview.rows.map((row) => ({
      rowNumber: row.rowNumber,
      articleCode: row.articleCode,
      productId: row.productId ?? null,
      categoryId: row.categoryId ?? null,
      status: row.status,
      currentProductNameAr: row.currentProductNameAr,
      currentCategoryNameAr: row.currentCategoryNameAr,
      currentDescriptionAr: row.currentDescriptionAr,
      targetProductNameAr: row.targetProductNameAr,
      targetCategoryNameAr: row.targetCategoryNameAr,
      targetDescriptionAr: row.targetDescriptionAr,
      changes: row.changes,
      reasons: row.reasons,
    })),
  };
}

export async function createArabicTranslationTemplate(products: TranslationCatalogProduct[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "HMD ERP";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Arabic Names", { views: [{ ...RTL_FROZEN_VIEW }] });

  sheet.columns = [
    { header: ARABIC_TRANSLATION_TEMPLATE_HEADERS[0], key: "articleCode", width: 24 },
    { header: ARABIC_TRANSLATION_TEMPLATE_HEADERS[1], key: "name", width: 36 },
    { header: ARABIC_TRANSLATION_TEMPLATE_HEADERS[2], key: "nameAr", width: 36 },
    { header: ARABIC_TRANSLATION_TEMPLATE_HEADERS[3], key: "categoryName", width: 28 },
    { header: ARABIC_TRANSLATION_TEMPLATE_HEADERS[4], key: "categoryNameAr", width: 28 },
    { header: ARABIC_TRANSLATION_TEMPLATE_HEADERS[5], key: "descriptionAr", width: 42 },
    { header: ARABIC_TRANSLATION_TEMPLATE_HEADERS[6], key: "status", width: 30 },
  ];
  for (const column of [1, 2, 4, 7]) {
    sheet.getColumn(column).protection = { locked: true, hidden: false };
  }
  for (const column of [3, 5, 6]) {
    sheet.getColumn(column).protection = { locked: false, hidden: false };
  }
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: ARABIC_TRANSLATION_TEMPLATE_HEADERS.length },
  };
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle", wrapText: true };
  sheet.getRow(1).height = 32;

  for (const product of products) {
    const row = sheet.addRow({
      articleCode: product.articleCode ?? "",
      name: product.name ?? "",
      nameAr: product.nameAr ?? "",
      categoryName: product.categoryName ?? "",
      categoryNameAr: product.categoryNameAr ?? "",
      descriptionAr: product.descriptionAr ?? "",
      status: translationStatus(product),
    });
    row.getCell(1).numFmt = "@";
    row.getCell(1).value = String(product.articleCode ?? "");
    for (const column of [3, 5, 6]) {
      row.getCell(column).alignment = { horizontal: "right", readingOrder: "rtl", wrapText: true };
    }
  }

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    for (const column of [3, 5, 6]) setCellLocked(row.getCell(column), false);
    for (const column of [1, 2, 4, 7]) setCellLocked(row.getCell(column), true);
  }

  await sheet.protect("factory-arabic-template", {
    selectLockedCells: true,
    selectUnlockedCells: true,
    autoFilter: true,
    sort: true,
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
