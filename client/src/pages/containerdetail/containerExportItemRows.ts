// Extracted from ./useContainerDetailModel.tsx to keep that module under the source-size cap.

interface ContainerExportLineItem {
  stockItemCode?: string | null;
  stockItemName?: string | null;
  quantity?: string | null;
  rate?: string | null;
  lineTotal?: string | null;
}

interface ContainerExportPayload {
  purchaseOrders?: { lineItems?: ContainerExportLineItem[] | null }[] | null;
}

/** "Container Items" sheet rows: one per PO line item, in PO order. */
export function containerExportItemRows(data: ContainerExportPayload) {
  const rows: { Code: string; Name: string; Qty: string; Rate: string; Value: string }[] = [];
  for (const po of data.purchaseOrders || []) {
    for (const item of po.lineItems || []) {
      rows.push({
        Code: item.stockItemCode || "",
        Name: item.stockItemName || "",
        Qty: item.quantity || "0",
        Rate: item.rate || "0",
        Value: item.lineTotal || "0",
      });
    }
  }
  return rows;
}
