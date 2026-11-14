import Decimal from "decimal.js";
import type ExcelJS from "exceljs";
import { getSupplierReturnPostedExportCopy } from "@/i18n/supplierReturnPostedExportTranslations";
import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

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
  language: ApplicationLanguage = "en"
) {
  const copy = getSupplierReturnPostedExportCopy(language);
  const source = wb.addWorksheet(copy.sourceSheet);
  source.columns = [
    { header: copy.lineId, key: "line", width: 18 },
    { header: copy.article, key: "code", width: 24 },
    { header: copy.item, key: "name", width: 38 },
    { header: copy.offloadItem, key: "offloadItem", width: 19 },
    { header: copy.offload, key: "offload", width: 16 },
    { header: copy.container, key: "container", width: 28 },
    { header: copy.supplier, key: "supplier", width: 32 },
    { header: copy.quantity, key: "quantity", width: 19 },
    { header: copy.purchase, key: "purchase", width: 23 },
    { header: copy.effective, key: "effective", width: 38 },
    { header: copy.credit, key: "credit", width: 25 },
    { header: copy.inventory, key: "inventory", width: 26 },
    { header: copy.variance, key: "variance", width: 26 },
    { header: copy.voucher, key: "voucher", width: 32 },
    { header: copy.voucherId, key: "voucherId", width: 18 },
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
    if ((item.requestedRows?.length ?? 0) > 0) {
      const mapped = (item.requestedRows ?? []).reduce((sum, row) => sum.plus(row.allocatedQuantity), new Decimal(0));
      if (!mapped.eq(qty)) throw new Error("Source return quantity differs from its recorded Excel row allocations");
    }
    totalQuantity = totalQuantity.plus(qty);
    totalSupplier = totalSupplier.plus(supplier);
    totalInventory = totalInventory.plus(inventory);
    source.addRow({
      line: item.id,
      code: safeText(item.articleCode),
      name: safeText(item.itemName),
      offloadItem: item.offloadItemId,
      offload: item.offloadId,
      container: safeText(item.containerNumber),
      supplier: safeText(item.supplier),
      quantity: qty.toNumber(),
      purchase: item.sourcePurchaseRate == null ? "" : toNumber(item.sourcePurchaseRate),
      effective: qty.gt(0) ? inventory.div(qty).toDecimalPlaces(7).toNumber() : "",
      credit: supplier.toNumber(),
      inventory: inventory.toNumber(),
      variance: inventory.minus(supplier).toNumber(),
      voucher: safeText(item.voucherNumber),
      voucherId: item.voucherId ?? "",
    });
  }
  source.addRow({
    code: copy.total,
    quantity: totalQuantity.toNumber(),
    credit: totalSupplier.toNumber(),
    inventory: totalInventory.toNumber(),
    variance: totalInventory.minus(totalSupplier).toNumber(),
  }).font = { bold: true };

  const allocations = wb.addWorksheet(copy.allocationsSheet);
  allocations.columns = [
    { header: copy.inputRow, key: "row", width: 16 },
    { header: copy.requestedArticle, key: "code", width: 25 },
    { header: copy.requestedQty, key: "requested", width: 25 },
    { header: copy.sourceContainer, key: "container", width: 29 },
    { header: copy.offloadItem, key: "offloadItem", width: 19 },
    { header: copy.allocatedQty, key: "allocated", width: 19 },
    { header: copy.returnLineId, key: "returnLine", width: 25 },
  ];
  allocations.getRow(1).font = { bold: true };
  allocations.views = [{ state: "frozen", ySplit: 1 }];
  const requested = new Map<number, { quantity: Decimal; allocated: Decimal; article: string }>();
  for (const item of sources) {
    for (const allocation of item.requestedRows ?? []) {
      const existing = requested.get(allocation.inputRow);
      const assigned = new Decimal(allocation.allocatedQuantity);
      if (existing) {
        if (!existing.quantity.eq(allocation.requestedQuantity) || existing.article !== allocation.requestedArticleCode)
          throw new Error("Posted input-row audit records do not agree");
        existing.allocated = existing.allocated.plus(assigned);
      } else {
        requested.set(allocation.inputRow, {
          quantity: new Decimal(allocation.requestedQuantity),
          allocated: assigned,
          article: allocation.requestedArticleCode,
        });
      }
      allocations.addRow({
        row: allocation.inputRow,
        code: safeText(allocation.requestedArticleCode),
        requested: toNumber(allocation.requestedQuantity),
        container: safeText(item.containerNumber),
        offloadItem: item.offloadItemId,
        allocated: assigned.toNumber(),
        returnLine: item.id,
      });
    }
  }
  for (const [row, value] of requested) {
    if (!value.allocated.eq(value.quantity)) {
      throw new Error(`Posted allocation audit differs from original requested quantity at input row ${row}`);
    }
  }
  if (requested.size === 0) allocations.addRow({ code: copy.legacy });

  if (
    !totalQuantity.eq(receipt.totalQty) ||
    !totalSupplier.eq(receipt.supplierCreditUsd) ||
    !totalInventory.eq(receipt.inventoryReductionUsd)
  ) {
    throw new Error("Posted return source lines do not reconcile with batch totals");
  }

  const summary = wb.addWorksheet(copy.summarySheet);
  summary.columns = [
    { header: copy.field, key: "label", width: 34 },
    { header: copy.value, key: "value", width: 44 },
  ];
  summary.addRow({ label: copy.batch, value: receipt.id });
  summary.addRow({ label: copy.returnDate, value: safeText(receipt.returnDate) });
  summary.addRow({ label: copy.file, value: safeText(receipt.fileName || copy.manual) });
  summary.addRow({ label: copy.reason, value: safeText(receipt.reason) });
  summary.addRow({ label: copy.sourceLines, value: sources.length });
  summary.addRow({ label: copy.removed, value: totalQuantity.toNumber() });
  summary.addRow({ label: "Supplier debit USD", value: totalSupplier.toNumber() });
  summary.addRow({ label: "Inventory credit USD", value: totalInventory.toNumber() });
  summary.addRow({ label: "Signed variance USD", value: totalInventory.minus(totalSupplier).toNumber() });
  summary.addRow({ label: copy.note, value: copy.exactNote });
}
