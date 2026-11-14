import Decimal from "decimal.js";
import type ExcelJS from "exceljs";

export interface PostedSupplierReturnRow {
  id: number;
  articleCode: string;
  itemName: string;
  quantity: string;
  containerNumber: string;
  offloadId: number;
  offloadItemId: number;
  supplier: string;
  supplierCreditUsd: string;
  inventoryReductionUsd: string;
  sourcePurchaseRate: string | null;
  voucherNumber: string | null;
  voucherId?: number | null;
  requestedRows?: Array<{
    inputRow: number;
    requestedArticleCode: string;
    requestedQuantity: string;
    allocatedQuantity: string;
  }>;
}
export interface SupplierReturnReceipt {
  id: number;
  returnDate: string;
  fileName: string | null;
  reason: string | null;
  totalQty: string;
  supplierCreditUsd: string;
  inventoryReductionUsd: string;
}
const safeText = (value: unknown) => {
  const text = String(value ?? "");
  return /^[\s\p{Cc}]*[=+\-@]/u.test(text) ? "'" + text : text;
};
const toNumber = (value: Decimal.Value) => new Decimal(value).toNumber();

export function buildPostedSupplierReturnWorkbook(
  wb: ExcelJS.Workbook,
  receipt: SupplierReturnReceipt,
  sources: PostedSupplierReturnRow[],
) {
  const source = wb.addWorksheet("Posted Source Lines");
  source.columns = [
    { header: "Return Line ID", key: "line", width: 18 },
    { header: "Article Code", key: "code", width: 24 },
    { header: "Item Name", key: "name", width: 38 },
    { header: "Offload Item ID", key: "offloadItem", width: 19 },
    { header: "Offload ID", key: "offload", width: 16 },
    { header: "Container", key: "container", width: 28 },
    { header: "Supplier", key: "supplier", width: 32 },
    { header: "Posted Quantity", key: "quantity", width: 19 },
    { header: "Purchase Rate USD", key: "purchase", width: 23 },
    { header: "Effective Inventory Cost / Bale USD", key: "effective", width: 38 },
    { header: "Supplier Debit USD", key: "credit", width: 25 },
    { header: "Inventory Credit USD", key: "inventory", width: 26 },
    { header: "Signed Variance USD", key: "variance", width: 26 },
    { header: "Voucher Number", key: "voucher", width: 32 },
    { header: "Voucher ID", key: "voucherId", width: 18 },
  ];
  source.getRow(1).font = { bold: true };
  source.views = [{ state: "frozen", ySplit: 1 }];
  source.autoFilter = { from: "A1", to: "O1" };

  let totalQuantity = new Decimal(0);
  let totalSupplier = new Decimal(0);
  let totalInventory = new Decimal(0);
  for (const item of sources) {
    const qty = new Decimal(item.quantity);
    const supplier = new Decimal(item.supplierCreditUsd);
    const inventory = new Decimal(item.inventoryReductionUsd);
    totalQuantity = totalQuantity.plus(qty);
    totalSupplier = totalSupplier.plus(supplier);
    totalInventory = totalInventory.plus(inventory);
    source.addRow({
      line: item.id, code: safeText(item.articleCode),
      name: safeText(item.itemName), offloadItem: item.offloadItemId,
      offload: item.offloadId, container: safeText(item.containerNumber),
      supplier: safeText(item.supplier), quantity: qty.toNumber(),
      purchase: item.sourcePurchaseRate == null ? "" : toNumber(item.sourcePurchaseRate),
      effective: qty.gt(0) ? inventory.div(qty).toDecimalPlaces(7).toNumber() : "",
      credit: supplier.toNumber(), inventory: inventory.toNumber(),
      variance: inventory.minus(supplier).toNumber(),
      voucher: safeText(item.voucherNumber), voucherId: item.voucherId ?? "",
    });
  }
  source.addRow({
    code: "TOTAL", quantity: totalQuantity.toNumber(),
    credit: totalSupplier.toNumber(), inventory: totalInventory.toNumber(),
    variance: totalInventory.minus(totalSupplier).toNumber(),
  }).font = { bold: true };

  const allocations = wb.addWorksheet("Original Input Allocations");
  allocations.columns = [
    { header: "Input Row", key: "row", width: 16 },
    { header: "Requested Article", key: "code", width: 25 },
    { header: "Original Requested Qty", key: "requested", width: 25 },
    { header: "Source Container", key: "container", width: 29 },
    { header: "Offload Item ID", key: "offloadItem", width: 19 },
    { header: "Allocated Qty", key: "allocated", width: 19 },
    { header: "Source Return Line ID", key: "returnLine", width: 25 },
  ];
  allocations.getRow(1).font = { bold: true };
  allocations.views = [{ state: "frozen", ySplit: 1 }];
  const requested = new Map<number, { quantity: Decimal; allocated: Decimal; article: string }>();
  for (const item of sources) {
    for (const allocation of item.requestedRows ?? []) {
      const existing = requested.get(allocation.inputRow);
      const assigned = new Decimal(allocation.allocatedQuantity);
      if (existing) {
        if (!existing.quantity.eq(allocation.requestedQuantity) ||
            existing.article !== allocation.requestedArticleCode)
          throw new Error("Posted input-row audit records do not agree");
        existing.allocated = existing.allocated.plus(assigned);
      } else {
        requested.set(allocation.inputRow, {
          quantity: new Decimal(allocation.requestedQuantity), allocated: assigned,
          article: allocation.requestedArticleCode,
        });
      }
      allocations.addRow({
        row: allocation.inputRow, code: safeText(allocation.requestedArticleCode),
        requested: toNumber(allocation.requestedQuantity),
        container: safeText(item.containerNumber), offloadItem: item.offloadItemId,
        allocated: assigned.toNumber(), returnLine: item.id,
      });
    }
  }
  for (const [row, value] of requested) {
    if (!value.allocated.eq(value.quantity)) {
      throw new Error(`Posted allocation audit differs from original requested quantity at input row ${row}`);
    }
  }
  if (requested.size === 0) allocations.addRow({ code: "Legacy return: input-row allocations were not recorded" });

  if (!totalQuantity.eq(receipt.totalQty) ||
      !totalSupplier.eq(receipt.supplierCreditUsd) ||
      !totalInventory.eq(receipt.inventoryReductionUsd)) {
    throw new Error("Posted return source lines do not reconcile with batch totals");
  }

  const summary = wb.addWorksheet("Posted Summary");
  summary.columns = [
    { header: "Field", key: "label", width: 34 },
    { header: "Value", key: "value", width: 44 },
  ];
  summary.addRow({ label: "Return batch", value: receipt.id });
  summary.addRow({ label: "Return date", value: safeText(receipt.returnDate) });
  summary.addRow({ label: "Source file", value: safeText(receipt.fileName || "Manual") });
  summary.addRow({ label: "Reason", value: safeText(receipt.reason) });
  summary.addRow({ label: "Posted source lines", value: sources.length });
  summary.addRow({ label: "Quantity removed", value: totalQuantity.toNumber() });
  summary.addRow({ label: "Supplier debit USD", value: totalSupplier.toNumber() });
  summary.addRow({ label: "Inventory credit USD", value: totalInventory.toNumber() });
  summary.addRow({ label: "Signed variance USD", value: totalInventory.minus(totalSupplier).toNumber() });
  summary.addRow({ label: "Note", value: "Posted amounts are exact audited ledger amounts, not preview estimates" });
}
