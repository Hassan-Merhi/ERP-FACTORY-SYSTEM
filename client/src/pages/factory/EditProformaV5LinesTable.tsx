// Extracted from ./EditProformaV5Drawer.tsx
import { Input } from "@/components/ui/input";
import { AlertTriangle, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatUsd } from "@/lib/moneyDisplay";
import type { EditProformaV5DrawerModel } from "./EditProformaV5DrawerModel";

export function EditProformaV5LinesTable({ m }: { m: EditProformaV5DrawerModel }) {
  return (
    <div className="mx-3 hidden min-w-0 overflow-x-auto rounded-b-xl border border-t-0 bg-card shadow-sm md:block phone-land:hidden sm:mx-5">
      <table className="w-full min-w-[1120px] table-fixed border-collapse text-sm">
        <colgroup>
          <col style={{ width: "27%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "15%" }} />
          <col style={{ width: "13%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "19%" }} />
          <col style={{ width: "4%" }} />
        </colgroup>
        <thead>
          <tr className="sticky top-0 z-30 bg-slate-100 text-slate-700 dark:bg-slate-800/95 dark:text-slate-200">
            <th className="sticky left-0 z-20 border-b border-r bg-slate-100 px-4 py-3 text-left text-xs font-semibold dark:bg-slate-800/95">
              Product
            </th>
            <th className="border-b border-r px-3 py-3 text-left text-xs font-semibold">Code</th>
            <th className="border-b border-r px-2 py-3 text-center text-xs font-semibold whitespace-nowrap">
              Available Balance
            </th>
            <th className="border-b border-r px-2 py-3 text-center text-xs font-semibold whitespace-nowrap">
              Qty / Container
            </th>
            <th className="border-b border-r px-2 py-3 text-center text-xs font-semibold whitespace-nowrap text-muted-foreground">
              Total KG
            </th>
            <th className="border-b px-2 py-3 text-center text-xs font-semibold whitespace-nowrap">Price</th>
            <th className="border-b px-2 py-3 text-center text-xs font-semibold"></th>
          </tr>
        </thead>
        <tbody>
          {m.visibleRows.map((row, idx) => {
            const rawVal = m.quantities[row.articleCode] ?? "";
            const parsed = parseInt(rawVal);
            const qty = isNaN(parsed) ? 0 : parsed;
            const shortage = qty > 0 && row.freeToPromise < 0;
            const p = m.map.get(row.articleCode);
            const w = parseFloat(p?.weightPerBaleKg || "0");
            const totalKgRow = qty > 0 && w > 0 ? qty * w : null;
            const hasExistingLine = !!m.proformaQuery.data?.lines.find((l) => l.articleCode === row.articleCode);

            return (
              <tr
                key={row.articleCode}
                className={cn(
                  "border-b transition-colors",
                  idx % 2 === 0 ? "bg-card" : "bg-muted/25",
                  qty > 0 && "bg-violet-500/[0.06]"
                )}
                data-testid={`row-v5-edit-${row.articleCode}`}
              >
                <td className="sticky left-0 z-10 border-r bg-inherit px-4 py-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    {hasExistingLine && qty > 0 && (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-violet-500" title="Line exists in proforma" />
                    )}
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
                  {row.freeToPromise > 0 ? "+" : ""}
                  {row.freeToPromise.toLocaleString()}
                </td>

                <td className="border-r px-2 py-2.5">
                  <div className="flex flex-col gap-0.5 items-center">
                    <Input
                      ref={(el) => {
                        m.qtyRefs.current[idx] = el;
                      }}
                      type="number"
                      min={0}
                      value={rawVal}
                      onChange={(e) => m.setQuantities((prev) => ({ ...prev, [row.articleCode]: e.target.value }))}
                      onFocus={(e) => e.target.select()}
                      onKeyDown={(e) => m.handleQtyKeyDown(e, idx)}
                      placeholder="0"
                      className={cn(
                        "h-7 text-center text-xs tabular-nums w-full",
                        shortage && "border-amber-400 bg-amber-50/30 dark:bg-amber-950/20"
                      )}
                      data-testid={`input-edit-v5-qty-${row.articleCode}`}
                    />
                    {shortage && (
                      <span className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5 whitespace-nowrap">
                        <AlertTriangle className="h-2.5 w-2.5" />
                        Low stock
                      </span>
                    )}
                  </div>
                </td>

                <td className="border-r px-2 py-2.5 text-center text-xs text-muted-foreground tabular-nums">
                  {totalKgRow != null ? (
                    <span className="text-foreground font-medium">
                      {totalKgRow.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </td>

                <td className="px-2 py-2.5">
                  {(() => {
                    const mode = m.pricingModes[row.articleCode] ?? "per_bale";
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
                            onClick={() => m.setPricingModes((prev) => ({ ...prev, [row.articleCode]: "per_bale" }))}
                            data-testid={`button-edit-v5-mode-bale-${row.articleCode}`}
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
                            onClick={() => m.setPricingModes((prev) => ({ ...prev, [row.articleCode]: "per_kg" }))}
                            data-testid={`button-edit-v5-mode-kg-${row.articleCode}`}
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
                            value={m.kgPrices[row.articleCode] ?? ""}
                            onChange={(e) => m.setKgPrices((prev) => ({ ...prev, [row.articleCode]: e.target.value }))}
                            onFocus={(e) => e.target.select()}
                            placeholder="0.000"
                            className="h-7 text-right text-xs tabular-nums w-full"
                            data-testid={`input-edit-v5-kgprice-${row.articleCode}`}
                          />
                        ) : (
                          <Input
                            type="number"
                            min={0}
                            value={m.prices[row.articleCode] ?? ""}
                            onChange={(e) => m.setPrices((prev) => ({ ...prev, [row.articleCode]: e.target.value }))}
                            onFocus={(e) => e.target.select()}
                            placeholder="0.00"
                            className="h-7 text-right text-xs tabular-nums w-full"
                            data-testid={`input-edit-v5-price-${row.articleCode}`}
                          />
                        )}
                      </div>
                    );
                  })()}
                </td>

                <td className="px-1 py-1 text-center">
                  {hasExistingLine && qty > 0 && (
                    <button
                      className="text-muted-foreground/40 hover:text-destructive transition-colors"
                      title="Remove line (set qty to 0)"
                      onClick={() => m.setQuantities((prev) => ({ ...prev, [row.articleCode]: "0" }))}
                      data-testid={`button-edit-v5-clear-${row.articleCode}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="sticky bottom-0 z-20 border-t-2 bg-slate-100 text-xs font-semibold dark:bg-slate-800">
            <td className="sticky left-0 z-10 border-r bg-slate-100 px-4 py-3 dark:bg-slate-800">
              <span className="text-foreground">Totals</span>
              <span className="ml-1.5 font-normal text-muted-foreground">
                ({m.visibleRows.length} visible products)
              </span>
            </td>
            <td className="border-r px-3 py-3 text-xs text-muted-foreground">Total</td>
            <td
              className={cn(
                "border-r px-2 py-3 text-center font-mono tabular-nums",
                m.visibleTotalBalance < 0
                  ? "text-destructive"
                  : m.visibleTotalBalance > 0
                    ? "text-green-700 dark:text-green-400"
                    : "text-muted-foreground"
              )}
            >
              {m.visibleTotalBalance > 0 ? `+${m.visibleTotalBalance}` : m.visibleTotalBalance}
            </td>
            <td className="border-r px-2 py-3 text-center font-mono tabular-nums text-foreground">
              {m.totalQty > 0 ? m.totalQty : <span className="text-muted-foreground/40">—</span>}
            </td>
            <td className="border-r px-2 py-3 text-center font-mono tabular-nums text-muted-foreground">
              {m.totalKg > 0 ? (
                <span className="text-foreground">
                  {m.totalKg.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg
                </span>
              ) : (
                <span className="text-muted-foreground/40">—</span>
              )}
            </td>
            <td className="px-2 py-3 text-center font-mono tabular-nums text-foreground" colSpan={2}>
              {m.totalValue > 0 ? formatUsd(m.totalValue, 2) : <span className="text-muted-foreground/40">—</span>}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
