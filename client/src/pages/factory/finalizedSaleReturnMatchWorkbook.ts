import type ExcelJS from "exceljs";

export type FinalizedReturnMatchExportRow = {
  reference: string;
  status: "matched" | "duplicate" | "missing" | "ambiguous" | "blocked";
  message: string | null;
  invoiceNumber?: string;
  containerNumber?: string | null;
  articleCode?: string | null;
  productName?: string | null;
};

export type FinalizedReturnMatchExport = {
  customerName: string;
  uploadedFile: string;
  rows: FinalizedReturnMatchExportRow[];
};

// Explicit strings prevent leading zeros in reference/article codes from being lost.
// Also prevent uploaded/user-owned text from being interpreted as spreadsheet formulas.
// Leading whitespace and control characters (U+0000 to U+001F) are skipped before looking for the
// formula character, because a spreadsheet skips them too.
const isSkippedBeforeFormula = (character: string) => /\s/.test(character) || character.charCodeAt(0) <= 0x1f;
const spreadsheetText = (text: string | null | undefined) => {
  const value = String(text ?? "");
  const first = [...value].find((character) => !isSkippedBeforeFormula(character));
  return first !== undefined && "=+-@".includes(first) ? "'" + value : value;
};

export function buildFinalizedReturnMatchWorkbook(workbook: ExcelJS.Workbook, input: FinalizedReturnMatchExport): void {
  const matched = input.rows.filter((row) => row.status === "matched");
  const issues = input.rows.filter((row) => row.status !== "matched");
  const headers: Array<{ header: string; key: string; width: number }> = [
    { header: "Ref Number", key: "reference", width: 26 },
    { header: "Article Number", key: "articleCode", width: 24 },
    { header: "Bale Name", key: "productName", width: 36 },
    { header: "Qty", key: "qty", width: 12 },
    { header: "Match Status", key: "status", width: 20 },
    { header: "Invoice Number", key: "invoiceNumber", width: 24 },
    { header: "Container Number", key: "containerNumber", width: 28 },
    { header: "Customer", key: "customerName", width: 34 },
    { header: "Details", key: "details", width: 65 },
  ];
  const populate = (name: string, rows: FinalizedReturnMatchExportRow[]) => {
    const sheet = workbook.addWorksheet(name);
    sheet.columns = headers;
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = { from: "A1", to: "I1" };
    sheet.getRow(1).font = { bold: true };
    for (const row of rows) {
      sheet.addRow({
        reference: spreadsheetText(row.reference),
        articleCode: spreadsheetText(row.articleCode),
        productName: spreadsheetText(row.productName),
        // Each physical reference represents one bale; unresolved rows have no matched quantity.
        qty: row.status === "matched" ? 1 : 0,
        status: row.status,
        invoiceNumber: spreadsheetText(row.invoiceNumber),
        containerNumber: spreadsheetText(row.containerNumber),
        customerName: spreadsheetText(input.customerName),
        details: spreadsheetText(row.message),
      });
    }
  };

  populate("Matched Bales", matched);
  populate("Unmatched - Review", issues);

  const summary = workbook.addWorksheet("Quantity Summary");
  summary.getColumn(1).width = 26;
  summary.getColumn(2).width = 40;
  summary.getColumn(3).width = 28;
  summary.getColumn(4).width = 18;
  summary.addRow(["Customer", spreadsheetText(input.customerName)]);
  summary.addRow(["Source file", spreadsheetText(input.uploadedFile)]);
  summary.addRow(["Matched references", matched.length]);
  summary.addRow(["Unmatched / blocked", issues.length]);
  summary.addRow(["Status", "PREVIEW ONLY — no stock, invoice or voucher changes"]);
  summary.addRow([]);
  summary.addRow(["Article Number", "Bale Name", "Invoice Number", "Qty Matched"]);
  summary.getRow(7).font = { bold: true };
  summary.views = [{ state: "frozen", ySplit: 7 }];
  const aggregate = new Map<string, { article: string; name: string; invoice: string; quantity: number }>();
  for (const row of matched) {
    const article = spreadsheetText(row.articleCode);
    const name = spreadsheetText(row.productName);
    const invoice = spreadsheetText(row.invoiceNumber);
    const key = JSON.stringify([article, name, invoice]);
    const entry = aggregate.get(key) ?? { article, name, invoice, quantity: 0 };
    entry.quantity += 1;
    aggregate.set(key, entry);
  }
  for (const entry of [...aggregate.values()].sort(
    (a, b) => a.article.localeCompare(b.article) || a.invoice.localeCompare(b.invoice) || a.name.localeCompare(b.name)
  )) {
    summary.addRow([entry.article, entry.name, entry.invoice, entry.quantity]);
  }
  summary.addRow(["TOTAL", "", "", matched.length]).font = { bold: true };
}
