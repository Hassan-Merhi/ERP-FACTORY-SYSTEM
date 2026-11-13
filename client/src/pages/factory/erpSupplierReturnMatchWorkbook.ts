import Decimal from "decimal.js";
import type ExcelJS from "exceljs";

export type ReturnMatchCandidate = {
  offloadItemId: number;
  offloadId: number;
  containerNumber: string;
  supplierName: string | null;
  code: string;
  name: string;
  originalQty: string;
  returnedQty: string;
  remainingQty: string;
  availableQty: string;
  unitPurchaseCost: string;
  unitLandedCost: string;
};
export type ReturnMatchEntry = {
  row: number;
  code: string;
  quantity: string;
  status: string;
  candidate?: ReturnMatchCandidate;
  valid: boolean;
};
export type ReturnMatchReportInput = {
  supplierName?: string | null;
  fileName?: string;
  entries: ReturnMatchEntry[];
};
const excelText = (value: unknown): string => {
  const text = String(value ?? "");
  // Excel formula-safe strings: codes, names and imported references are user-owned.
  return /^[\s\u0000-\u001f]*[=+\-@]/.test(text) ? "'" + text : text;
};
export function buildErpSupplierReturnMatchWorkbook(wb: ExcelJS.Workbook, data: ReturnMatchReportInput) {
  const columns = [
    { header: "Ref Number", key: "ref", width: 22 },
    { header: "Article Number", key: "article", width: 24 },
    { header: "Bale Name", key: "name", width: 38 },
    { header: "Qty", key: "qty", width: 14 },
    { header: "Container", key: "container", width: 27 },
    { header: "Supplier", key: "supplier", width: 35 },
    { header: "Offload ID", key: "offload", width: 15 },
    { header: "Original Qty", key: "original", width: 18 },
    { header: "Already Returned", key: "returned", width: 21 },
    { header: "Remaining", key: "remaining", width: 18 },
    { header: "Stock Available", key: "stock", width: 19 },
    { header: "Purchase / Unit USD", key: "purchase", width: 24 },
    { header: "Landed / Unit USD", key: "landed", width: 22 },
    { header: "Estimated Supplier Credit USD", key: "credit", width: 30 },
    { header: "Match Status", key: "status", width: 26 },
    { header: "Input Row", key: "inputRow", width: 16 },
  ];
  const addSheet = (name: string, rows: ReturnMatchEntry[]) => {
    const sheet = wb.addWorksheet(name);
    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = { from: "A1", to: "P1" };
    for (const line of rows) {
      const item = line.candidate;
      const qty = line.valid ? new Decimal(line.quantity) : new Decimal(0);
      sheet.addRow({
        // ERP tracks bulk article quantities rather than unique physical bale references.
        // Use the real offload record identifier as the reference, never invent a bale number.
        ref: item ? "OFFLOAD-" + item.offloadId : "",
        article: excelText(item?.code || line.code),
        name: excelText(item?.name),
        qty: qty.toNumber(),
        container: excelText(item?.containerNumber),
        supplier: excelText(item?.supplierName),
        offload: item?.offloadId || "",
        original: item ? Number(item.originalQty) : "",
        returned: item ? Number(item.returnedQty) : "",
        remaining: item ? Number(item.remainingQty) : "",
        stock: item ? Number(item.availableQty) : "",
        purchase: item ? Number(item.unitPurchaseCost) : "",
        landed: item ? Number(item.unitLandedCost) : "",
        credit: item && line.valid ? qty.mul(item.unitPurchaseCost).toDecimalPlaces(2).toNumber() : 0,
        status: line.valid ? "matched" : line.status,
        inputRow: line.row,
      });
    }
  };

  const matched = data.entries.filter((row) => row.valid);
  const review = data.entries.filter((row) => !row.valid);
  addSheet("Matched Containers", matched);
  addSheet("Unmatched - Review", review);

  const summary = wb.addWorksheet("Quantity Summary");
  summary.getColumn(1).width = 28;
  summary.getColumn(2).width = 40;
  summary.getColumn(3).width = 26;
  summary.getColumn(4).width = 16;
  summary.getColumn(5).width = 28;
  summary.addRow(["Supplier filter", excelText(data.supplierName || "All suppliers")]);
  summary.addRow(["Input file", excelText(data.fileName || "Manual article entry")]);
  summary.addRow(["Matched rows", matched.length]);
  summary.addRow(["Unmatched / blocked rows", review.length]);
  summary.addRow(["IMPORTANT", "PREVIEW ONLY: no inventory, vouchers or supplier balances changed"]);
  summary.addRow(["NOTE", "Credit is an estimate. Live stock/cost and supplier are rechecked when posting."]);
  summary.addRow([]);
  summary.addRow(["Article Number", "Bale Name", "Container", "Qty", "Est. Supplier Credit USD"]);
  summary.getRow(8).font = { bold: true };
  summary.views = [{ state: "frozen", ySplit: 8 }];
  const totals = new Map<string, { article: string; name: string; container: string; qty: Decimal; credit: Decimal }>();
  for (const line of matched) {
    const item = line.candidate!;
    const key = JSON.stringify([item.code, item.name, item.containerNumber, item.offloadId]);
    const total = totals.get(key) || {
      article: excelText(item.code),
      name: excelText(item.name),
      container: excelText(item.containerNumber),
      qty: new Decimal(0),
      credit: new Decimal(0),
    };
    total.qty = total.qty.add(line.quantity);
    total.credit = total.credit.add(new Decimal(line.quantity).mul(item.unitPurchaseCost));
    totals.set(key, total);
  }
  const ordered = [...totals.values()].sort(
    (a, b) => a.article.localeCompare(b.article) || a.container.localeCompare(b.container)
  );
  for (const row of ordered)
    summary.addRow([
      row.article,
      row.name,
      row.container,
      row.qty.toNumber(),
      row.credit.toDecimalPlaces(2).toNumber(),
    ]);
  const sumQty = ordered.reduce((amount, row) => amount.add(row.qty), new Decimal(0));
  const sumCredit = ordered.reduce((amount, row) => amount.add(row.credit), new Decimal(0));
  summary.addRow(["TOTAL", "", "", sumQty.toNumber(), sumCredit.toDecimalPlaces(2).toNumber()]).font = { bold: true };
}
