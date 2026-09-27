/**
 * Stock OTW row model and the dictionary-compressed wire payload the
 * /api/containers/otw-items endpoint returns for profile=stock-otw.
 */
export interface StockItem {
  stockItemCode: string;
  stockItemName: string;
  quantity: string;
  totalCost: string;
  rate: string;
  containerNumber: string;
  supplierName: string;
  importDate: string;
  gradeId: number | null;
  gradeName: string | null;
  categoryId: number | null;
  categoryName: string | null;
}

export type StockOtwWireContainer = [containerNumber: string, supplierName: string];
export type StockOtwWireRow = [containerIndex: number, quantity: number, totalCost: number];

export interface StockOtwWirePayload {
  c: StockOtwWireContainer[];
  i: Array<{
    n: string;
    g: string | null;
    c: string | null;
    r: StockOtwWireRow[];
  }>;
}

export function expandStockOtwWirePayload(payload: StockOtwWirePayload): StockItem[] {
  const containers = Array.isArray(payload?.c) ? payload.c : [];
  const items = Array.isArray(payload?.i) ? payload.i : [];
  const rows: StockItem[] = [];

  for (const item of items) {
    for (const [containerIndex, quantity, totalCost] of item.r || []) {
      const [containerNumber = "", supplierName = "Unknown"] = containers[containerIndex] || [];
      rows.push({
        stockItemCode: "",
        stockItemName: item.n || "",
        quantity: String(quantity || 0),
        totalCost: String(totalCost || 0),
        rate: String(quantity ? totalCost / quantity : 0),
        containerNumber,
        supplierName,
        importDate: "",
        gradeId: null,
        gradeName: item.g ?? null,
        categoryId: null,
        categoryName: item.c ?? null,
      });
    }
  }

  return rows;
}

export interface GroupedStockItem {
  stockItemName: string;
  totalQuantity: number;
  totalCost: number;
  containerCount: number;
  gradeName: string | null;
  categoryName: string | null;
  containers: {
    containerNumber: string;
    quantity: number;
    cost: number;
    rate: number;
    supplierName: string;
  }[];
}
