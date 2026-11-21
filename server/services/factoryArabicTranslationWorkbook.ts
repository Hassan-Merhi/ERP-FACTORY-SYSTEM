import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { normalizeFactoryArticleCode } from "@shared/factoryBilingualContract";
import {
  ARABIC_TRANSLATION_TEMPLATE_HEADERS,
  CONTROL_CHARACTER_PATTERN,
  RTL_FROZEN_VIEW,
  clean,
  cellText,
  selectedValue,
  uniqueSorted,
  previewFingerprintPayload,
  type TranslationImportMode,
  type TranslationCatalogProduct,
  type TranslationWorkbookRow,
  type TranslationPreviewStatus,
  type TranslationPreviewRow,
  type TranslationPreview,
  type TranslationPreviewEnvelope,
} from "./factoryArabicTranslationWorkbookHelpers";
export {
  ARABIC_TRANSLATION_TEMPLATE_HEADERS,
  createArabicTranslationTemplate,
  type TranslationImportMode,
  type TranslationCatalogProduct,
  type TranslationWorkbookRow,
  type TranslationPreviewStatus,
  type TranslationPreviewRow,
  type TranslationPreview,
  type TranslationPreviewEnvelope,
} from "./factoryArabicTranslationWorkbookHelpers";

const MAX_WORKBOOK_ROWS = 50_000;
const MAX_TRANSLATION_LENGTH = 2_000;

function validateTranslation(value: string, label: string, reasons: string[]): void {
  if (!value) return;
  if (value.length > MAX_TRANSLATION_LENGTH) reasons.push(`${label} exceeds ${MAX_TRANSLATION_LENGTH} characters`);
  if (CONTROL_CHARACTER_PATTERN.test(value)) reasons.push(`${label} contains unsupported control characters`);
}

export function createWorkbookSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function createArabicTranslationPreviewToken(input: {
  companyId: number;
  mode: TranslationImportMode;
  workbookSha256: string;
  preview: TranslationPreview;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(previewFingerprintPayload(input)))
    .digest("hex");
}

export function createArabicTranslationPreviewEnvelope(input: {
  companyId: number;
  mode: TranslationImportMode;
  workbookSha256: string;
  preview: TranslationPreview;
}): TranslationPreviewEnvelope {
  return {
    ...input.preview,
    mode: input.mode,
    workbookSha256: input.workbookSha256,
    previewToken: createArabicTranslationPreviewToken(input),
  };
}

export async function parseArabicTranslationWorkbook(buffer: Buffer): Promise<TranslationWorkbookRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Workbook does not contain a worksheet");
  if (sheet.actualRowCount > MAX_WORKBOOK_ROWS + 1) {
    throw new Error(`Workbook exceeds the ${MAX_WORKBOOK_ROWS.toLocaleString()} row limit`);
  }

  const actualHeaders = ARABIC_TRANSLATION_TEMPLATE_HEADERS.map((_, index) =>
    cellText(sheet.getRow(1).getCell(index + 1))
  );
  if (actualHeaders.some((value, index) => value !== ARABIC_TRANSLATION_TEMPLATE_HEADERS[index])) {
    throw new Error("Workbook columns do not match the Arabic translation template");
  }

  const rows: TranslationWorkbookRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const articleCode = normalizeFactoryArticleCode(cellText(row.getCell(1)));
    const productNameAr = cellText(row.getCell(3));
    const categoryNameAr = cellText(row.getCell(5));
    const descriptionAr = cellText(row.getCell(6));
    if (!articleCode && !productNameAr && !categoryNameAr && !descriptionAr) return;
    rows.push({ rowNumber, articleCode, productNameAr, categoryNameAr, descriptionAr });
  });
  return rows;
}

export function previewArabicTranslationImport(
  rows: TranslationWorkbookRow[],
  products: TranslationCatalogProduct[],
  mode: TranslationImportMode
): TranslationPreview {
  const catalogByCode = new Map<string, TranslationCatalogProduct[]>();
  for (const product of products) {
    const code = normalizeFactoryArticleCode(product.articleCode);
    if (!code) continue;
    const matches = catalogByCode.get(code) ?? [];
    matches.push(product);
    catalogByCode.set(code, matches);
  }

  const codeCounts = new Map<string, number>();
  for (const sourceRow of rows) {
    const code = normalizeFactoryArticleCode(sourceRow.articleCode);
    if (code) codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
  }

  const categoryTargets = new Map<number, Set<string>>();
  for (const sourceRow of rows) {
    const code = normalizeFactoryArticleCode(sourceRow.articleCode);
    const matches = catalogByCode.get(code) ?? [];
    if (matches.length !== 1) continue;
    const product = matches[0];
    const categoryId = product.categoryId;
    if (!categoryId) continue;
    const target = selectedValue(product.categoryNameAr, sourceRow.categoryNameAr, mode);
    if (!target) continue;
    const targets = categoryTargets.get(categoryId) ?? new Set<string>();
    targets.add(target);
    categoryTargets.set(categoryId, targets);
  }
  const conflictingCategoryIds = new Set(
    [...categoryTargets].filter(([, targets]) => targets.size > 1).map(([categoryId]) => categoryId)
  );

  const previewRows: TranslationPreviewRow[] = rows.map((sourceRow) => {
    const row: TranslationWorkbookRow = {
      rowNumber: sourceRow.rowNumber,
      articleCode: normalizeFactoryArticleCode(sourceRow.articleCode),
      productNameAr: clean(sourceRow.productNameAr),
      categoryNameAr: clean(sourceRow.categoryNameAr),
      descriptionAr: clean(sourceRow.descriptionAr),
    };
    const reasons: string[] = [];
    const matches = row.articleCode ? (catalogByCode.get(row.articleCode) ?? []) : [];
    const duplicateInFile = Boolean(row.articleCode) && (codeCounts.get(row.articleCode) ?? 0) > 1;

    if (!row.articleCode) reasons.push("Missing article code");
    if (duplicateInFile) reasons.push("Duplicate article code in workbook");
    if (row.articleCode && matches.length === 0) reasons.push("Unknown article code");
    if (matches.length > 1) reasons.push("Article code matches multiple products in this company");

    const product = matches.length === 1 ? matches[0] : undefined;
    if (product?.categoryId && conflictingCategoryIds.has(product.categoryId)) {
      reasons.push("Conflicting Arabic category translations");
    }
    if (!row.productNameAr && !row.categoryNameAr && !row.descriptionAr) reasons.push("No Arabic translation supplied");
    validateTranslation(row.productNameAr, "Arabic product name", reasons);
    validateTranslation(row.categoryNameAr, "Arabic category name", reasons);
    validateTranslation(row.descriptionAr, "Arabic description", reasons);

    const currentProductNameAr = clean(product?.nameAr) || null;
    const currentCategoryNameAr = clean(product?.categoryNameAr) || null;
    const currentDescriptionAr = clean(product?.descriptionAr) || null;
    const targetProductNameAr = product ? selectedValue(product.nameAr, row.productNameAr, mode) : null;
    const targetCategoryNameAr = product ? selectedValue(product.categoryNameAr, row.categoryNameAr, mode) : null;
    const targetDescriptionAr = product ? selectedValue(product.descriptionAr, row.descriptionAr, mode) : null;
    const changes = {
      productNameAr: Boolean(product) && targetProductNameAr !== currentProductNameAr,
      categoryNameAr: Boolean(product?.categoryId) && targetCategoryNameAr !== currentCategoryNameAr,
      descriptionAr: Boolean(product) && targetDescriptionAr !== currentDescriptionAr,
    };

    let status: TranslationPreviewStatus;
    if (duplicateInFile) status = "duplicate";
    else if (matches.length > 1) status = "ambiguous";
    else if (row.articleCode && matches.length === 0) status = "unknown";
    else if (product?.categoryId && conflictingCategoryIds.has(product.categoryId)) status = "category-conflict";
    else if (reasons.length > 0) status = "invalid";
    else if (changes.productNameAr || changes.categoryNameAr || changes.descriptionAr) status = "update";
    else status = "unchanged";

    return {
      ...row,
      productId: product?.id,
      categoryId: product?.categoryId,
      status,
      reasons,
      currentProductNameAr,
      currentCategoryNameAr,
      currentDescriptionAr,
      targetProductNameAr,
      targetCategoryNameAr,
      targetDescriptionAr,
      changes,
    };
  });

  const updateRows = previewRows.filter((row) => row.status === "update");
  const matchedProductIds = new Set(previewRows.flatMap((row) => (row.productId ? [row.productId] : [])));
  const productIdsToUpdate = new Set(
    updateRows.flatMap((row) =>
      row.productId && (row.changes.productNameAr || row.changes.descriptionAr) ? [row.productId] : []
    )
  );
  const categoryIdsToUpdate = new Set(
    updateRows.flatMap((row) => (row.categoryId && row.changes.categoryNameAr ? [row.categoryId] : []))
  );
  const duplicateArticleCodes = uniqueSorted([...codeCounts].filter(([, count]) => count > 1).map(([code]) => code));
  const unknownArticleCodes = uniqueSorted(
    previewRows.filter((row) => row.status === "unknown").map((row) => row.articleCode)
  );
  const ambiguousArticleCodes = uniqueSorted(
    previewRows.filter((row) => row.status === "ambiguous").map((row) => row.articleCode)
  );

  return {
    totalRows: rows.length,
    matchedProducts: matchedProductIds.size,
    unchangedRows: previewRows.filter((row) => row.status === "unchanged").length,
    rowsToApply: updateRows.length,
    productsToUpdate: productIdsToUpdate.size,
    categoriesToUpdate: categoryIdsToUpdate.size,
    unknownArticleCodes,
    duplicateArticleCodes,
    ambiguousArticleCodes,
    blankOrInvalidArabicNames: previewRows.filter((row) => row.status === "invalid").length,
    categoryConflicts: conflictingCategoryIds.size,
    blocked: duplicateArticleCodes.length > 0 || conflictingCategoryIds.size > 0 || ambiguousArticleCodes.length > 0,
    rows: previewRows,
  };
}

export async function createArabicTranslationErrorWorkbook(preview: TranslationPreview): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Rejected Rows", { views: [{ ...RTL_FROZEN_VIEW }] });
  sheet.columns = [
    { header: "Row", key: "rowNumber", width: 10 },
    { header: "Article Code / Barcode", key: "articleCode", width: 24 },
    { header: "Arabic Product Name", key: "productNameAr", width: 36 },
    { header: "Arabic Category", key: "categoryNameAr", width: 30 },
    { header: "Arabic Description", key: "descriptionAr", width: 42 },
    { header: "Status", key: "status", width: 22 },
    { header: "Reasons", key: "reasons", width: 60 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle", wrapText: true };

  for (const row of preview.rows.filter((item) => !["update", "unchanged"].includes(item.status))) {
    const excelRow = sheet.addRow({ ...row, reasons: row.reasons.join("; ") });
    excelRow.getCell(2).numFmt = "@";
    for (const column of [3, 4, 5, 7]) {
      excelRow.getCell(column).alignment = { horizontal: "right", readingOrder: "rtl", wrapText: true };
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
