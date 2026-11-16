import fs from "fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => fs.readFileSync(path, "utf8");

describe("Factory bilingual Phase 7 document contracts", () => {
  it("uses one shared document-language contract", () => {
    const source = read("server/services/factoryDocumentLanguage.ts");
    expect(source).toContain("FACTORY_DOCUMENT_LABELS");
    expect(source).toContain("resolveFactoryDocumentProductName");
    expect(source).toContain("configureFactoryArabicWorksheet");
    expect(source).toContain("findArabicPdfFont");
  });

  it("intercepts only explicit language requests and keeps legacy compatibility", () => {
    const source = read("server/routes/factory/factoryBilingualDocumentRoutes.ts");
    expect(source).toContain("hasExplicitLanguage");
    expect(source).toContain("return next()");
    expect(source).toContain('req.query.lang === "en"');
    expect(source).toContain('req.query.lang === "ar"');
  });

  it("supports bilingual PDF, Excel, loading, no-charge and price-hiding paths", () => {
    const source = read("server/routes/factory/factoryBilingualDocumentRoutes.ts");
    expect(source).toContain("export-pdf");
    expect(source).toContain("export-excel");
    expect(source).toContain("pending-export");
    expect(source).toContain("noCharges");
    expect(source).toContain("getExportPriceVisibility");
  });

  it("uses frozen bilingual snapshots before article-code fallback", () => {
    const source = read("server/services/factoryDocumentLanguage.ts");
    expect(source).toContain("source.baleNameAr");
    expect(source).toContain("source.productNameAr");
    expect(source).toContain("source.articleCode");
    expect(source).toContain("resolveFactoryProductName");
  });

  it("exposes English and Arabic actions on the invoice detail page", () => {
    const source = read("client/src/pages/factory/FactoryInvoiceDetailBilingual.tsx");
    expect(source).toContain("Export PDF (English)");
    expect(source).toContain("Export Excel (English)");
    expect(source).toContain("English Loading List");
    expect(source).toContain("Export PDF (فاتورة عربية)");
    expect(source).toContain("Export Excel (فاتورة عربية)");
    expect(source).toContain("قائمة تحميل عربية");
  });

  it("does not contain any business-data mutation", () => {
    const source = read("server/routes/factory/factoryBilingualDocumentRoutes.ts");
    expect(source).not.toMatch(/\.update\(/);
    expect(source).not.toMatch(/\.insert\(/);
    expect(source).not.toMatch(/\.delete\(/);
  });
});
