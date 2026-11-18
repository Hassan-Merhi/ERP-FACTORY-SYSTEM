import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import type { PosToast, SaleRow } from "./posTypes";
import { PosCartCell, PosCartGrid, PosCartRow, PosCartSummary } from "./PosCartGrid";
import type { POSColumn } from "../utils/posCalculations";

export interface SaleGridProps {
  rows: SaleRow[];
  columns: POSColumn[];
  selectedCell: { row: number; col: number };
  highlightedIndex: number;
  matchingItemCount: number;
  pickerListId: string;
  setSelectedCell: (cell: { row: number; col: number }) => void;
  updateRow: (index: number, field: keyof SaleRow, value: string | number) => void;
  handleDeleteRow: (index: number) => void;
  handleKeyDown: (e: React.KeyboardEvent, rowIndex: number, colIndex: number) => void;
  setActiveRow: (row: number | null) => void;
  setSearchTerm: (term: string) => void;
  setHighlightedIndex: (index: number) => void;
  getStockWarning: (row: SaleRow) => string | null;
  formatDisplayAmount: (amount: number) => string;
  activeCurrency: string;
  exchangeRate: number | null;
  inputRefs: React.MutableRefObject<{ [key: string]: HTMLInputElement }>;
  clearActiveRowTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  focusCell: (rowIndex: number, colIndex: number) => void;
  toast: PosToast;
  /** When true (edit mode), skip the "incomplete item" mousedown guard so
   *  items loaded from the DB don't lock the entire grid. */
  isEditMode?: boolean;
}

export function SaleGrid({
  rows,
  columns,
  highlightedIndex,
  matchingItemCount,
  pickerListId,
  setSelectedCell,
  updateRow,
  handleDeleteRow,
  handleKeyDown,
  setActiveRow,
  setSearchTerm,
  setHighlightedIndex,
  getStockWarning,
  formatDisplayAmount,
  activeCurrency,
  exchangeRate,
  inputRefs,
  clearActiveRowTimerRef,
  focusCell,
  toast,
  isEditMode = false,
}: SaleGridProps) {
  const validCount = rows.filter((r) => r.amount > 0).length;
  const qty = rows.reduce((s, r) => s + (r.quantity || 0), 0);
  const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
  return (
    <PosCartGrid
      columns={columns}
      className="flex-1"
      minWidthClassName="min-w-[340px] sm:min-w-[500px]"
      bodyMaxHeight="calc(100dvh - 22rem)"
      summary={<PosCartSummary itemCount={validCount} quantity={qty} total={formatDisplayAmount(total)} />}
    >
      {rows.map((row, rowIndex) => (
        <PosCartRow key={row.id} index={rowIndex}>
          {columns.map((col, colIndex) => (
            <PosCartCell
              key={col.key}
              width={col.width}
              className={`h-9 ${col.key === "amount" ? "bg-muted/30" : ""}`}
              onMouseDown={(_e) => {
                // In edit mode all rows are loaded from the DB and already
                // have valid stockItemIds, so the incomplete-item guard is
                // irrelevant and would incorrectly lock the grid.
                if (isEditMode) return;
                const invalidIdx = rows.findIndex((r) => r.itemName?.trim() && !r.stockItemId);
                if (invalidIdx !== -1 && !(rowIndex === invalidIdx && col.key === "itemName")) {
                  // Show warning but do NOT call e.preventDefault() — that
                  // would block focus on every input and lock the entire grid.
                  toast({
                    title: "Select an item first",
                    description: `Row ${invalidIdx + 1} has an incomplete item. Please choose an item from the list.`,
                    variant: "destructive",
                  });
                  focusCell(invalidIdx, 0);
                }
              }}
            >
              {col.key === "delete" ? (
                <div className="flex items-center justify-center h-full opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity duration-150">
                  {rows.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDeleteRow(rowIndex)}
                      className="h-8 w-8"
                      data-testid={`button-delete-row-${rowIndex}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              ) : col.key === "plBale" || col.key === "totalPL" ? (
                (() => {
                  const cfgUSD = row.configuredPrice ?? 0;
                  const plBaleUSD = row.rateUSD - cfgUSD;
                  const plBaleDisplay = activeCurrency === "CFA" && exchangeRate ? plBaleUSD * exchangeRate : plBaleUSD;
                  const val = col.key === "plBale" ? plBaleDisplay : plBaleDisplay * row.quantity;
                  const hasConfig = row.stockItemId && cfgUSD > 0;
                  const color = !hasConfig
                    ? undefined
                    : val > 0
                      ? "text-green-700 dark:text-green-400"
                      : val < 0
                        ? "text-red-600 dark:text-red-400"
                        : "text-muted-foreground";
                  return (
                    <div
                      className={`flex items-center justify-end h-full px-1.5 sm:px-2 font-mono text-xs sm:text-sm ${color ?? "text-muted-foreground"}`}
                    >
                      {hasConfig ? formatDisplayAmount(Math.abs(val)) : "—"}
                    </div>
                  );
                })()
              ) : (
                <input
                  ref={(el) => {
                    if (el) inputRefs.current[`${rowIndex}-${colIndex}`] = el;
                  }}
                  role={col.key === "itemName" ? "combobox" : undefined}
                  aria-autocomplete={col.key === "itemName" ? "list" : undefined}
                  aria-expanded={col.key === "itemName" ? matchingItemCount > 0 : undefined}
                  aria-controls={col.key === "itemName" ? pickerListId : undefined}
                  aria-activedescendant={
                    col.key === "itemName" && matchingItemCount > 0 && highlightedIndex >= 0
                      ? `${pickerListId}-item-${Math.min(highlightedIndex, matchingItemCount - 1)}`
                      : undefined
                  }
                  type={col.key === "quantity" || col.key === "rate" ? "number" : "text"}
                  inputMode={col.key === "quantity" || col.key === "rate" ? "decimal" : undefined}
                  value={
                    col.key === "amount"
                      ? formatDisplayAmount(row.amount)
                      : col.key === "quantity" || col.key === "rate"
                        ? row[col.key as keyof SaleRow] === 0
                          ? ""
                          : row[col.key as keyof SaleRow]
                        : row[col.key as keyof SaleRow]
                  }
                  onChange={(e) => {
                    if (col.key !== "amount") {
                      updateRow(rowIndex, col.key as keyof SaleRow, e.target.value);
                      if (col.key === "itemName") {
                        setSearchTerm(e.target.value);
                        setHighlightedIndex(0);
                      }
                    }
                  }}
                  onKeyDown={(e) => handleKeyDown(e, rowIndex, colIndex)}
                  onFocus={() => {
                    if (clearActiveRowTimerRef.current) clearTimeout(clearActiveRowTimerRef.current);
                    setSelectedCell({ row: rowIndex, col: colIndex });
                    if (col.key === "itemName") {
                      setActiveRow(rowIndex);
                      setSearchTerm(row.itemName);
                      setHighlightedIndex(0);
                    } else if (
                      (col.key === "quantity" || col.key === "rate") &&
                      row.itemName?.trim() &&
                      !row.stockItemId
                    ) {
                      toast({
                        title: "Invalid item",
                        description: "Please select an item from the list.",
                        variant: "destructive",
                      });
                      setTimeout(() => {
                        setSelectedCell({ row: rowIndex, col: 0 });
                        focusCell(rowIndex, 0);
                        setActiveRow(rowIndex);
                        setSearchTerm(row.itemName);
                        setHighlightedIndex(0);
                      }, 0);
                      return;
                    }
                  }}
                  onBlur={() => {
                    if (col.key === "itemName") {
                      clearActiveRowTimerRef.current = setTimeout(() => {
                        setActiveRow(null);
                      }, 200);
                    }
                  }}
                  readOnly={col.key === "amount"}
                  className={`w-full h-full px-1.5 sm:px-3 bg-transparent outline-hidden focus:bg-accent/20 text-xs sm:text-sm ${
                    col.key === "quantity" || col.key === "rate" || col.key === "amount" ? "font-mono text-right" : ""
                  } ${col.key === "amount" ? "cursor-not-allowed" : ""} ${
                    col.key === "quantity" && getStockWarning(row) ? "text-destructive font-bold" : ""
                  }`}
                  placeholder={col.key === "itemName" ? "Type to search..." : ""}
                  data-testid={`input-${col.key}-${rowIndex}`}
                />
              )}
            </PosCartCell>
          ))}
        </PosCartRow>
      ))}
    </PosCartGrid>
  );
}
