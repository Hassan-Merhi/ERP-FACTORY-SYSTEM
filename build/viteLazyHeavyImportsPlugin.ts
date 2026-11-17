import type { Plugin } from "vite";

const STOCK_IN_SALES_REPORT_SUFFIX = "/client/src/pages/StockInSalesReport.tsx";
const STOCK_IN_SALES_DETAIL_SUFFIX = "/client/src/pages/StockInSalesReportDetail.tsx";

const EXCEL_HELPER_IMPORT = `import { ExcelJS, writeFile } from "@/lib/excelHelper";`;
const EXPORT_START = `    try {\n      const workbook = new ExcelJS.Workbook();`;
const LAZY_EXPORT_START = `    try {\n      const { ExcelJS, writeFile } = await import("@/lib/excelHelper");\n      const workbook = new ExcelJS.Workbook();`;

function replaceExactly(source: string, before: string, after: string, label: string): string {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`[lazy-heavy-imports] Missing transform target: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`[lazy-heavy-imports] Ambiguous transform target: ${label}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function deferExcelHelper(source: string): string {
  let code = replaceExactly(
    source,
    `${EXCEL_HELPER_IMPORT}\n`,
    "",
    "Excel helper static import",
  );
  code = replaceExactly(
    code,
    EXPORT_START,
    LAZY_EXPORT_START,
    "Excel export dynamic import",
  );
  return code;
}

export function lazyHeavyImportsPlugin(): Plugin {
  return {
    name: "erp-lazy-heavy-imports",
    enforce: "pre",
    transform(source, id) {
      const normalizedId = id.replaceAll("\\", "/").split("?")[0];
      if (
        normalizedId.endsWith(STOCK_IN_SALES_REPORT_SUFFIX) ||
        normalizedId.endsWith(STOCK_IN_SALES_DETAIL_SUFFIX)
      ) {
        // Phase 5 migrated these exports to a click-time dynamic import.
        // The legacy rewrite still applies to older code, but does not require
        // a dead static import pattern once the page has been modernized.
        if (!source.includes(EXCEL_HELPER_IMPORT)) return null;
        return { code: deferExcelHelper(source), map: null };
      }
      return null;
    },
  };
}
