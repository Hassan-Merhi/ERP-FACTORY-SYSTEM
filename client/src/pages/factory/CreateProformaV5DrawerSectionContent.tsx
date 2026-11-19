// Extracted from ./CreateProformaV5DrawerSection.tsx
import { Input } from "@/components/ui/input";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCreateProformaV5DrawerState } from "./useCreateProformaV5DrawerState";

export function CreateProformaV5DrawerSectionContent({
  errors,
  handleQtyChange,
  handleQtyKeyDown,
  kgPrices,
  map,
  n,
  pricingModes,
  qtyRefs,
  quantities,
  sellingPrices,
  sendToLoading,
  setKgPrices,
  setPricingModes,
  setSellingPrices,
  visibleRows,
}: Pick<
  Pick<
    ReturnType<typeof useCreateProformaV5DrawerState>,
    | "errors"
    | "handleQtyChange"
    | "handleQtyKeyDown"
    | "kgPrices"
    | "map"
    | "n"
    | "pricingModes"
    | "qtyRefs"
    | "quantities"
    | "sellingPrices"
    | "sendToLoading"
    | "setKgPrices"
    | "setPricingModes"
    | "setSellingPrices"
    | "totalExpected"
    | "totalKg"
    | "totalQty"
    | "totalValue"
    | "visibleRows"
    | "visibleTotalBalance"
  >,
  | "errors"
  | "handleQtyChange"
  | "handleQtyKeyDown"
  | "kgPrices"
  | "map"
  | "n"
  | "pricingModes"
  | "qtyRefs"
  | "quantities"
  | "sellingPrices"
  | "sendToLoading"
  | "setKgPrices"
  | "setPricingModes"
  | "setSellingPrices"
  | "visibleRows"
>) {
  return (
    <tbody>
      {visibleRows.map((row, idx) => {
        const rawVal = quantities[row.articleCode] ?? "";
        const parsed = parseInt(rawVal);
        const qty = isNaN(parsed) ? 0 : parsed;
        const request = sendToLoading && n > 0 ? qty * n : qty;
        const balance = row.stockAvailable - row.totalLoaded - request;
        const shortage = request > 0 && balance < 0;
        const shortBy = Math.abs(balance);
        const hasError = !!errors[`qty_${row.articleCode}`];

        return (
          <tr
            key={row.articleCode}
            className={cn(
              "border-b transition-colors",
              idx % 2 === 0 ? "bg-card" : "bg-muted/25",
              qty > 0 && "bg-violet-500/[0.06]"
            )}
            data-testid={`row-v5-create-${row.articleCode}`}
          >
            <td className="sticky left-0 z-10 border-r bg-inherit px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                {row.freeToPromise < 0 && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-500" />}
                <span className="block truncate text-xs font-semibold sm:text-sm" title={row.productName}>
                  {row.productName}
                </span>
              </div>
            </td>
            <td className="border-r px-3 py-2.5 font-mono text-xs text-muted-foreground" title={row.articleCode}>
              {row.articleCode}
            </td>

            <td
              className={cn(
                "border-r px-2 py-2.5 text-center font-mono tabular-nums text-xs font-semibold",
                row.freeToPromise < 0
                  ? "text-destructive"
                  : row.freeToPromise === 0
                    ? "text-muted-foreground"
                    : "text-green-700 dark:text-green-400"
              )}
            >
              {row.freeToPromise < 0 && <AlertTriangle className="inline h-3 w-3 mr-0.5 mb-0.5" />}
              {row.freeToPromise > 0 ? `+${row.freeToPromise}` : row.freeToPromise}
            </td>

            <td className="border-r px-2 py-2.5">
              <div className="flex flex-col gap-0.5 items-center">
                <Input
                  ref={(el) => {
                    qtyRefs.current[idx] = el;
                  }}
                  type="number"
                  min={0}
                  value={rawVal}
                  onChange={(e) => handleQtyChange(row.articleCode, e.target.value)}
                  onKeyDown={(e) => handleQtyKeyDown(e, idx)}
                  onFocus={(e) => e.target.select()}
                  placeholder="0"
                  className={cn(
                    "h-7 text-center text-xs font-mono w-20 px-1 tabular-nums",
                    hasError && "border-destructive",
                    shortage && !hasError && "border-amber-400 dark:border-amber-500",
                    qty > 0 && !shortage && !hasError && "border-blue-400 dark:border-blue-500"
                  )}
                  data-testid={`input-v5-qty-${row.articleCode}`}
                />
                {hasError && <span className="text-[11px] text-destructive">{errors[`qty_${row.articleCode}`]}</span>}
                {shortage && !hasError && (
                  <span className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5 whitespace-nowrap">
                    <AlertTriangle className="h-2.5 w-2.5" />
                    short {shortBy}
                  </span>
                )}
              </div>
            </td>

            {/* Total KG */}
            {(() => {
              const product = map.get(row.articleCode);
              const weightPerBale = parseFloat(product?.weightPerBaleKg || "0");
              const rowKg = qty > 0 && weightPerBale > 0 ? qty * weightPerBale : null;
              return (
                <td className="border-r px-2 py-2.5 text-center font-mono tabular-nums text-xs text-muted-foreground">
                  {rowKg != null ? (
                    <span className="text-foreground font-medium">
                      {rowKg.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </td>
              );
            })()}

            {sendToLoading && n > 0 && (
              <td
                className={cn(
                  "border-r px-2 py-2.5 text-center font-mono tabular-nums text-xs font-semibold",
                  shortage
                    ? "text-destructive"
                    : request > 0
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground/40"
                )}
              >
                {request > 0 ? (
                  <span className="flex items-center justify-end gap-1">
                    {shortage && <AlertTriangle className="h-3 w-3" />}
                    {request}
                  </span>
                ) : (
                  "—"
                )}
              </td>
            )}

            <td className="px-2 py-2.5">
              {(() => {
                const mode = pricingModes[row.articleCode] ?? "per_bale";
                return (
                  <div className="flex items-center gap-1">
                    <div className="flex rounded-sm border shrink-0 overflow-hidden text-[11px] font-semibold">
                      <button
                        className={cn(
                          "px-1.5 py-0.5 transition-colors",
                          mode === "per_bale"
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-muted"
                        )}
                        onClick={() => setPricingModes((prev) => ({ ...prev, [row.articleCode]: "per_bale" }))}
                        data-testid={`button-v5-mode-bale-${row.articleCode}`}
                        title="Price per bale"
                      >
                        /bale
                      </button>
                      <button
                        className={cn(
                          "px-1.5 py-0.5 transition-colors",
                          mode === "per_kg"
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-muted"
                        )}
                        onClick={() => setPricingModes((prev) => ({ ...prev, [row.articleCode]: "per_kg" }))}
                        data-testid={`button-v5-mode-kg-${row.articleCode}`}
                        title="Price per kg"
                      >
                        /kg
                      </button>
                    </div>
                    {mode === "per_kg" ? (
                      <Input
                        type="number"
                        min={0}
                        step="0.001"
                        value={kgPrices[row.articleCode] ?? ""}
                        onChange={(e) => setKgPrices((prev) => ({ ...prev, [row.articleCode]: e.target.value }))}
                        onFocus={(e) => e.target.select()}
                        placeholder="0.000"
                        className="h-7 text-right text-xs font-mono w-20 px-2 tabular-nums"
                        data-testid={`input-v5-kgprice-${row.articleCode}`}
                      />
                    ) : (
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={sellingPrices[row.articleCode] ?? ""}
                        onChange={(e) => setSellingPrices((prev) => ({ ...prev, [row.articleCode]: e.target.value }))}
                        onFocus={(e) => e.target.select()}
                        placeholder="0.00"
                        className="h-7 text-right text-xs font-mono w-20 px-2 tabular-nums"
                        data-testid={`input-v5-price-${row.articleCode}`}
                      />
                    )}
                  </div>
                );
              })()}
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}
