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

/** Quantity and price a cashier set before adding an item (the phone item sheet). */
export interface PosItemSelectionOverrides {
  quantity?: number;
  /** Price in the active display currency, as typed. */
  rate?: number;
}

/**
 * The price a new sale line starts with: the last price this item sold at, else its configured
 * price, converted to the active display currency. Shared by the grid and the phone item sheet so
 * the default is never computed twice.
 */
export function resolvePosItemRate(
  item: InventoryItem,
  lastSoldPrices: Record<number, string>,
  activeCurrency: string,
  exchangeRate: number | null
): {
  rateUSD: number;
  displayRate: number;
  /** The item's configured selling price in the display currency. */
  normalDisplayRate: number;
  /** The last price it sold at in the display currency, when there is one. */
  lastSoldDisplayRate: number | null;
} {
  const toDisplay = (usd: number) => (activeCurrency === "CFA" ? Math.round(usd * (exchangeRate ?? 0)) : usd);
  const lastSoldUSD = lastSoldPrices[item.stockItemId] ? parseFloat(lastSoldPrices[item.stockItemId]) : null;
  const rateUSD = lastSoldUSD ?? item.price;
  return {
    rateUSD,
    displayRate: toDisplay(rateUSD),
    normalDisplayRate: toDisplay(item.price),
    lastSoldDisplayRate: lastSoldUSD === null ? null : toDisplay(lastSoldUSD),
  };
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
  /**
   * Whether the item may be added under the stock rules; shows the zero-stock alert when not.
   * authUser is refreshed for the active company and must win over the route prop if the
   * company changed after the app first authenticated.
   */
  const ensureItemSellable = (item: InventoryItem): boolean => {
    const canSellNegativeStock = authUser?.canSellNegativeStock ?? posUser?.canSellNegativeStock ?? false;
    const availableStock = Number(item.stock);
    if (Number.isFinite(availableStock) && availableStock <= 0 && !canSellNegativeStock) {
      setZeroStockItem(item.name);
      setZeroStockAlert(true);
      return false;
    }
    return true;
  };

  const resolveItemRate = (item: InventoryItem) =>
    resolvePosItemRate(item, lastSoldPrices, activeCurrency, exchangeRate);

  const selectItem = (item: InventoryItem, targetRowOverride?: number, overrides?: PosItemSelectionOverrides) => {
    if (!ensureItemSellable(item)) return;
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
    const resolved = resolveItemRate(item);
    // A typed price converts back to USD exactly as editing the Rate cell does (updateRow).
    const displayRate = overrides?.rate ?? resolved.displayRate;
    const rateUSD =
      overrides?.rate === undefined
        ? resolved.rateUSD
        : activeCurrency === "CFA" && exchangeRate
          ? overrides.rate / exchangeRate
          : overrides.rate;
    const quantity = overrides?.quantity ?? 1;

    newRows[targetRow] = {
      ...newRows[targetRow],
      itemName: item.name,
      stockItemCode: item.code,
      stockItemId: item.stockItemId,
      rate: displayRate,
      rateUSD,
      quantity,
      amount: quantity * displayRate,
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

  return { selectItem, updateRow, ensureItemSellable, resolveItemRate };
}
