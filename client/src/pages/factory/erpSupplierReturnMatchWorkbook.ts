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
  averageCost?: string;
  offloadItemId: number;
};
export type ReturnMatchEntry = {
  row: number;
  code: string;
  quantity: string;
  requestedQuantity?: string;
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
  return /^[\s\p{Cc}]*[=+\-@]/u.test(text) ? "'" + text : text;
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
    { header: "Requested Qty (Row)", key: "requested", width: 22 },
    { header: "Allocated Qty", key: "allocated", width: 18 },
    { header: "Unallocated Qty (Row)", key: "unallocated", width: 23 },
    { header: "Stock Average / Unit USD", key: "average", width: 27 },
    { header: "Estimated Inventory Relief USD", key: "inventoryEstimate", width: 34 },
    { header: "Estimated Variance USD", key: "varianceEstimate", width: 27 },
    { header: "Offload Item ID", key: "offloadItem", width: 18 },
  ];
  const addSheet = (name: string, rows: ReturnMatchEntry[]) => {
    const sheet = wb.addWorksheet(name);
    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = { from: "A1", to: "W1" };
    for (const line of rows) {
      const item = line.candidate;
      const qty = line.valid ? new Decimal(line.quantity) : new Decimal(0);
      const requestedQty = new Decimal(line.requestedQuantity ?? line.quantity);
      const estInventory = item?.averageCost != null && line.valid
        ? qty.mul(item.averageCost).toDecimalPlaces(2) : null;
      const estCredit = item && line.valid ? qty.mul(item.unitPurchaseCost).toDecimalPlaces(2) : null;
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
        credit: estCredit?.toNumber() ?? 0,
        status: line.valid ? "matched" : line.status,
        inputRow: line.row,
        requested: requestedQty.toNumber(),
        allocated: qty.toNumber(),
        unallocated: "", // See row summary: a request may span several containers.
        average: item?.averageCost == null ? "" : Number(item.averageCost),
        inventoryEstimate: estInventory?.toNumber() ?? "",
        varianceEstimate: estInventory && estCredit ? estInventory.minus(estCredit).toNumber() : "",
        offloadItem: item?.offloadItemId ?? "",
      });
    }
  };

  const requests = wb.addWorksheet("Input Row Allocations");
  requests.columns = [
    { header: "Excel Row", key: "row", width: 16 },
    { header: "Requested Article", key: "code", width: 26 },
    { header: "Requested Qty", key: "requested", width: 19 },
    { header: "Allocated Qty", key: "allocated", width: 19 },
    { header: "Unallocated Qty", key: "unallocated", width: 22 },
    { header: "Status", key: "status", width: 24 },
  ];
  requests.getRow(1).font = { bold: true };
  requests.views = [{ state: "frozen", ySplit: 1 }];
  const inputRows = new Map<number, { code: string; requested: Decimal; allocated: Decimal; status: string }>();
  for (const entry of data.entries) {
    const existing = inputRows.get(entry.row);
    const requested = new Decimal(entry.requestedQuantity ?? entry.quantity);
    const allocated = entry.valid ? new Decimal(entry.quantity) : new Decimal(0);
    if (existing) {
      existing.allocated = existing.allocated.plus(allocated);
      if (!entry.valid) existing.status = "review";
    } else {
      inputRows.set(entry.row, {
        code: excelText(entry.code),
        requested, allocated, status: entry.valid ? "matched" : "review",
      });
    }
  }
  for (const [row, item] of [...inputRows].sort(([a], [b]) => a - b)) {
    const remaining = Decimal.max(item.requested.minus(item.allocated), 0);
    requests.addRow({
      row, code: item.code, requested: item.requested.toNumber(),
      allocated: item.allocated.toNumber(), unallocated: remaining.toNumber(),
      status: item.status === "matched" && remaining.eq(0) &&
        item.allocated.eq(item.requested) ? "matched" : "review",
    });
  }

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
  summary.addRow(["Matched input rows", new Set(matched.map((row) => row.row)).size]);
  summary.addRow(["Unmatched / blocked input rows", new Set(review.map((row) => row.row)).size]);
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
