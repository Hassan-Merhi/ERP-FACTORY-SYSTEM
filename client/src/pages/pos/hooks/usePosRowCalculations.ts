import type { AuthMe } from "@shared/apiTypes";
import type { InventoryItem, SaleRow } from "../pos-components/posTypes";

interface PosRowCalculationsParams {
  rows: SaleRow[];
  activeRow: number | null;
  setRows: React.Dispatch<React.SetStateAction<SaleRow[]>>;
  setSearchTerm: React.Dispatch<React.SetStateAction<string>>;
  setZeroStockItem: React.Dispatch<React.SetStateAction<string>>;
  setZeroStockAlert: React.Dispatch<React.SetStateAction<boolean>>;
  lastSoldPrices: Record<number, string>;
  activeCurrency: string;
  exchangeRate: number | null;
  authUser?: AuthMe | null;
  posUser?: AuthMe | null;
  focusCell: (row: number, col: number) => void;
}

/**
 * Row-level item selection and cell-edit calculations for the POS grid.
 * Extracted from usePosHandlers.ts (Phase 18 structural split) — logic unchanged.
 */
export function usePosRowCalculations({
  rows,
  activeRow,
  setRows,
  setSearchTerm,
  setZeroStockItem,
  setZeroStockAlert,
  lastSoldPrices,
  activeCurrency,
  exchangeRate,
  authUser,
  posUser,
  focusCell,
}: PosRowCalculationsParams) {
  const selectItem = (item: InventoryItem, targetRowOverride?: number) => {
    // authUser is refreshed for the active company and must win over the route
    // prop if the company changed after the app first authenticated.
    const canSellNegativeStock = authUser?.canSellNegativeStock ?? posUser?.canSellNegativeStock ?? false;
    const availableStock = Number(item.stock);
    if (Number.isFinite(availableStock) && availableStock <= 0 && !canSellNegativeStock) {
      setZeroStockItem(item.name);
      setZeroStockAlert(true);
      return;
    }
    // Prefer the active row, then the first draft row (typed text but no item
    // selected yet), then the first truly empty row.  Using only !r.itemName
    // would skip a draft row whose itemName is already "eg", causing the item
    // to land in a brand-new appended row instead of the row being edited.
    const draftIdx = rows.findIndex((r) => !r.stockItemId && (r.itemName?.trim() ?? "") !== "");
    const emptyIdx = rows.findIndex((r) => !r.itemName);
    let targetRow = targetRowOverride ?? activeRow ?? (draftIdx !== -1 ? draftIdx : emptyIdx);
    const newRows = [...rows];
    // If no suitable row found, append one
    if (targetRow === -1 || targetRow == null) {
      targetRow = newRows.length;
      newRows.push({
        id: Date.now().toString(),
        itemName: "",
        quantity: 0,
        rate: 0,
        rateUSD: 0,
        amount: 0,
      });
    }
    const rateUSD = lastSoldPrices[item.stockItemId] ? parseFloat(lastSoldPrices[item.stockItemId]) : item.price;
    const displayRate = activeCurrency === "CFA" ? Math.round(rateUSD * (exchangeRate ?? 0)) : rateUSD;

    newRows[targetRow] = {
      ...newRows[targetRow],
      itemName: item.name,
      stockItemCode: item.code,
      stockItemId: item.stockItemId,
      rate: displayRate,
      rateUSD,
      quantity: 1,
      amount: displayRate,
      configuredPrice: item.configuredPrice,
    };

    if (targetRow === rows.length - 1) {
      newRows.push({
        id: Date.now().toString(),
        itemName: "",
        quantity: 0,
        rate: 0,
        rateUSD: 0,
        amount: 0,
      });
    }
    setRows(newRows);
    setSearchTerm("");
    setTimeout(() => focusCell(targetRow, 1), 0);
  };

  const updateRow = (index: number, field: keyof SaleRow, value: string | number) => {
    const newRows = [...rows];
    newRows[index] = { ...newRows[index], [field]: value };
    if (field === "quantity" || field === "rate") {
      const numValue = value === "" ? 0 : parseFloat(String(value)) || 0;
      newRows[index][field] = numValue;
      if (field === "rate") {
        newRows[index].rateUSD = activeCurrency === "CFA" && exchangeRate ? numValue / exchangeRate : numValue;
      }
      newRows[index].amount = (newRows[index].quantity || 0) * (newRows[index].rate || 0);
    }
    setRows(newRows);
  };

  return { selectItem, updateRow };
}
