/**
 * Arabic translation workbook edge cases (server/services/factoryArabicTranslationWorkbook.ts):
 * every cell value shape the parser reads (rich text, formula results,
 * hyperlinks, dates, booleans, numbers, empty objects), missing worksheets and
 * mismatched headers, blank rows, templates for products with missing fields,
 * and preview rules for code-less catalog rows, both import modes, category
 * conflicts and products without a category.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  ARABIC_TRANSLATION_TEMPLATE_HEADERS,
  createArabicTranslationTemplate,
  parseArabicTranslationWorkbook,
  previewArabicTranslationImport,
  type TranslationCatalogProduct,
} from "../server/services/factoryArabicTranslationWorkbook";

async function bookWith(rows: ExcelJS.CellValue[][], headers: readonly string[] = ARABIC_TRANSLATION_TEMPLATE_HEADERS) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Translations");
  sheet.addRow([...headers]);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

const product = (patch: Partial<TranslationCatalogProduct>): TranslationCatalogProduct => ({
  id: 1,
  categoryId: 10,
  articleCode: "A1",
  name: "Shirt",
  nameAr: null,
  descriptionAr: null,
  categoryName: "Tops",
  categoryNameAr: null,
  ...patch,
});

describe("parseArabicTranslationWorkbook", () => {
  it("reads every cell value shape and skips blank rows", async () => {
    const buffer = await bookWith([
      [
        { richText: [{ text: "A" }, { text: "1 " }] } as ExcelJS.CellValue,
        "",
        { formula: "1+1", result: "قميص" } as ExcelJS.CellValue,
        "",
        { text: "ملابس", hyperlink: "https://example.test" } as ExcelJS.CellValue,
        true,
      ],
      ["", "", "", "", "", ""],
      [
        12345,
        "",
        new Date("2026-01-02T00:00:00Z"),
        "",
        { formula: "X", result: null } as unknown as ExcelJS.CellValue,
        7,
      ],
    ]);
    const rows = await parseArabicTranslationWorkbook(buffer);
    expect(rows).toEqual([
      { rowNumber: 2, articleCode: "A1", productNameAr: "قميص", categoryNameAr: "ملابس", descriptionAr: "true" },
      {
        rowNumber: 4,
        articleCode: "12345",
        productNameAr: "2026-01-02T00:00:00.000Z",
        categoryNameAr: "",
        descriptionAr: "7",
      },
    ]);
  });

  it("refuses workbooks without a sheet or with different columns", async () => {
    const empty = new ExcelJS.Workbook();
    await expect(parseArabicTranslationWorkbook(Buffer.from(await empty.xlsx.writeBuffer()))).rejects.toThrow(
      "Workbook does not contain a worksheet"
    );
    const wrong = await bookWith([["A1"]], ["Code", ...ARABIC_TRANSLATION_TEMPLATE_HEADERS.slice(1)]);
    await expect(parseArabicTranslationWorkbook(wrong)).rejects.toThrow(
      "Workbook columns do not match the Arabic translation template"
    );
  });
});

describe("createArabicTranslationTemplate", () => {
  it("writes blank cells for missing product fields and reports each translation status", async () => {
    const buffer = await createArabicTranslationTemplate([
      product({ articleCode: null, name: null, categoryName: null }),
      product({ id: 2, articleCode: "B2", nameAr: "بنطال" }),
      product({ id: 3, articleCode: "C3", nameAr: "حذاء", categoryNameAr: "أحذية", descriptionAr: "جلد" }),
      product({ id: 4, articleCode: "D4", nameAr: "قبعة", categoryId: null }),
    ]);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = book.worksheets[0];
    expect(sheet.getRow(2).getCell(1).value).toBe("");
    expect([2, 3, 4, 5].map((n) => sheet.getRow(n).getCell(7).value)).toEqual([
      "Missing Arabic Product Name",
      "Missing Arabic Category",
      "Complete",
      "Complete",
    ]);
  });
});

describe("previewArabicTranslationImport", () => {
  it("ignores catalog rows without a code and applies the fill-missing and replace modes", () => {
    const catalog = [
      product({ id: 9, articleCode: null }),
      product({ id: 1, articleCode: "A1", nameAr: "قديم", categoryId: null }),
    ];
    const row = { rowNumber: 2, articleCode: "a1", productNameAr: "جديد", categoryNameAr: "", descriptionAr: "" };
    const fill = previewArabicTranslationImport([row], catalog, "fill-missing");
    expect(fill.rows[0]).toMatchObject({ status: "unchanged", targetProductNameAr: "قديم", categoryId: null });
    const replace = previewArabicTranslationImport([row], catalog, "replace-existing");
    expect(replace.rows[0]).toMatchObject({ status: "update", targetProductNameAr: "جديد" });
    expect(replace.rows[0].changes).toEqual({ productNameAr: true, categoryNameAr: false, descriptionAr: false });
  });

  it("flags conflicting category translations and rows without any translation", () => {
    const catalog = [
      product({ id: 1, articleCode: "A1" }),
      product({ id: 2, articleCode: "B2" }),
      product({ id: 3, articleCode: "C3", categoryId: 11 }),
    ];
    const preview = previewArabicTranslationImport(
      [
        { rowNumber: 2, articleCode: "A1", productNameAr: "", categoryNameAr: "ملابس", descriptionAr: "" },
        { rowNumber: 3, articleCode: "B2", productNameAr: "", categoryNameAr: "أزياء", descriptionAr: "" },
        { rowNumber: 4, articleCode: "C3", productNameAr: "", categoryNameAr: "", descriptionAr: "" },
        { rowNumber: 5, articleCode: "ZZ9", productNameAr: "x", categoryNameAr: "", descriptionAr: "" },
      ],
      catalog,
      "replace-existing"
    );
    expect(preview.rows.map((r) => r.status)).toEqual(["category-conflict", "category-conflict", "invalid", "unknown"]);
    expect(preview.rows[2].reasons).toContain("No Arabic translation supplied");
    expect(preview.blocked).toBe(true);
  });
});
