// Extracted from ./FactoryMonthlyProductionMatrix.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { ArrowDown, ArrowUp, GripVertical, ListOrdered } from "lucide-react";
import { useFactoryMonthlyProductionMatrixState } from "./useFactoryMonthlyProductionMatrixState";

export function FactoryMonthlyProductionMatrixSection({
  byId,
  canReorder,
  draggingId,
  mhd,
  monthLabel,
  months,
  moveOne,
  openMoveDialog,
  openWorkerBreakdown,
  overallTotal,
  recordChanges,
  reorder,
  rowPositionById,
  rowTotal,
  saving,
  setDraggingId,
  t,
  totals,
  visibleProducts,
}: Pick<
  ReturnType<typeof useFactoryMonthlyProductionMatrixState>,
  | "byId"
  | "canReorder"
  | "draggingId"
  | "mhd"
  | "monthLabel"
  | "months"
  | "moveOne"
  | "openMoveDialog"
  | "openWorkerBreakdown"
  | "overallTotal"
  | "recordChanges"
  | "reorder"
  | "rowPositionById"
  | "rowTotal"
  | "saving"
  | "setDraggingId"
  | "t"
  | "totals"
  | "visibleProducts"
>) {
  return (
    <div
      className="hidden overflow-auto rounded-xl border bg-card md:block phone-land:hidden"
      style={{ maxHeight: "calc(100dvh - 280px)" }}
    >
      <table className="min-w-max w-full border-separate border-spacing-0 text-sm tabular-nums">
        <thead className="sticky top-0 z-20 bg-muted text-foreground">
          <tr>
            <th className="sticky left-0 z-30 min-w-72 border-b border-r bg-muted p-2 text-left">
              {t("monthlyProduction.itemCode")}
            </th>
            {months.map((month) => (
              <th key={month} className="min-w-24 border-b border-r px-3 py-2 text-right whitespace-nowrap">
                {monthLabel(month)}
              </th>
            ))}
            <th className="sticky right-0 z-30 min-w-24 border-b bg-muted px-3 py-2 text-right">
              {t("monthlyProduction.total")}
            </th>
          </tr>
        </thead>
        <tbody>
          {visibleProducts.map((product, index) => {
            const values = months.map((month) => byId(product.id, month));
            const min = Math.min(...values);
            const max = Math.max(...values);
            const hasRange = values.length > 1 && min !== max;
            return (
              <tr
                key={product.id}
                draggable={canReorder}
                onDragStart={(event) => {
                  setDraggingId(product.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(event) => {
                  if (canReorder) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (draggingId != null) void reorder(draggingId, product.id);
                  setDraggingId(null);
                }}
                onDragEnd={() => setDraggingId(null)}
                className={
                  "group hover:bg-accent/30 " +
                  (draggingId === product.id ? "opacity-50 " : "") +
                  (index % 2 ? "bg-muted/20" : "")
                }
              >
                <td className="sticky left-0 z-10 border-r border-b bg-card p-1.5 group-hover:bg-accent/30">
                  <div className="flex items-center gap-1.5">
                    <GripVertical
                      className={
                        "h-4 w-4 shrink-0 " +
                        (canReorder ? "cursor-grab text-muted-foreground" : "text-muted-foreground/30")
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium leading-tight">{mhd.nameFor(product.articleCode, product.name)}</div>
                      <div className="text-[11px] text-muted-foreground">
                        #{rowPositionById.get(product.id)} · {product.articleCode} · {product.categoryName}
                      </div>
                    </div>
                    {recordChanges.allowed && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 shrink-0 gap-1 px-2 text-xs"
                          disabled={saving}
                          onClick={() => openMoveDialog(product.id)}
                          aria-label={
                            t("monthlyProduction.moveTo") + ": " + mhd.nameFor(product.articleCode, product.name)
                          }
                          data-testid={"move-matrix-item-" + product.id}
                        >
                          <ListOrdered className="h-3.5 w-3.5" /> {t("monthlyProduction.moveTo")}
                        </Button>
                        <div className="flex flex-col">
                          <button
                            type="button"
                            aria-label={
                              t("monthlyProduction.moveUp") + ": " + mhd.nameFor(product.articleCode, product.name)
                            }
                            disabled={!canReorder || index === 0}
                            onClick={() => moveOne(product.id, -1)}
                            className="rounded hover:bg-muted disabled:opacity-25"
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label={
                              t("monthlyProduction.moveDown") + ": " + mhd.nameFor(product.articleCode, product.name)
                            }
                            disabled={!canReorder || index === visibleProducts.length - 1}
                            onClick={() => moveOne(product.id, 1)}
                            className="rounded hover:bg-muted disabled:opacity-25"
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </td>
                {values.map((value, i) => {
                  const accent =
                    hasRange && value === max
                      ? "bg-emerald-100 text-emerald-800 font-bold dark:bg-emerald-950/50 dark:text-emerald-300"
                      : hasRange && value === min
                        ? "bg-red-100 text-red-800 font-bold dark:bg-red-950/50 dark:text-red-300"
                        : "";
                  return (
                    <td
                      key={months[i]}
                      title={monthLabel(months[i]) + ": " + value + " " + t("monthlyProduction.baleUnits")}
                      className={"border-b border-r px-3 py-2 text-right " + accent}
                    >
                      {value > 0 ? (
                        <button
                          type="button"
                          className="font-semibold underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                          onClick={() => openWorkerBreakdown(product.id, [months[i]])}
                          title="View production by worker"
                          aria-label={
                            "View workers who produced " +
                            value +
                            " bales of " +
                            mhd.nameFor(product.articleCode, product.name) +
                            " in " +
                            monthLabel(months[i])
                          }
                          data-testid={"matrix-worker-drilldown-" + product.id + "-" + months[i]}
                        >
                          {value.toLocaleString()}
                        </button>
                      ) : (
                        value.toLocaleString()
                      )}
                    </td>
                  );
                })}
                <td className="sticky right-0 z-10 border-b bg-card px-3 py-2 text-right font-semibold group-hover:bg-accent/30">
                  {rowTotal(product.id) > 0 ? (
                    <button
                      type="button"
                      className="font-semibold underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      onClick={() => openWorkerBreakdown(product.id, months)}
                      title="View production by worker for selected months"
                      aria-label={
                        "View workers who produced " +
                        rowTotal(product.id) +
                        " bales of " +
                        mhd.nameFor(product.articleCode, product.name) +
                        " across selected months"
                      }
                      data-testid={"matrix-total-drilldown-" + product.id}
                    >
                      {rowTotal(product.id).toLocaleString()}
                    </button>
                  ) : (
                    rowTotal(product.id).toLocaleString()
                  )}
                </td>
              </tr>
            );
          })}
          {visibleProducts.length === 0 && (
            <tr>
              <td colSpan={months.length + 2} className="p-10 text-center text-muted-foreground">
                {t("monthlyProduction.noMatching")}
              </td>
            </tr>
          )}
        </tbody>
        <tfoot className="sticky bottom-0 z-10 bg-muted font-bold">
          <tr>
            <td className="sticky left-0 border-t border-r bg-muted px-3 py-2">
              {t("monthlyProduction.totalProduced")}
            </td>
            {totals.map((value, index) => (
              <td key={months[index]} className="border-t border-r px-3 py-2 text-right">
                {value.toLocaleString()}
              </td>
            ))}
            <td className="sticky right-0 border-t bg-muted px-3 py-2 text-right">{overallTotal.toLocaleString()}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
