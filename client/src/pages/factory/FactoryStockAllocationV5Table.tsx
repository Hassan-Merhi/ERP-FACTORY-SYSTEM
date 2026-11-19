// Extracted from ./FactoryStockAllocationV5.tsx
import { Fragment } from "react";
import { EmptyState, LoadingState } from "@/components/ui/page-state";
import { RefreshCw, AlertTriangle, Plus, ChevronDown, Container, Pencil, X, Link2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS_LABELS } from "./factorystockallocationv5/utils";
import { FactoryStockAllocationV5MobileList } from "./factorystockallocationv5/components/FactoryStockAllocationV5MobileList";
import type { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import type { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { useFactoryStockAllocationV5Model } from "./factorystockallocationv5/useFactoryStockAllocationV5Model";

export function FactoryStockAllocationV5Table({
  model,
  mhd,
  recordChanges,
  setLocation,
  mhdRows,
}: {
  model: ReturnType<typeof useFactoryStockAllocationV5Model>;
  mhd: ReturnType<typeof useFactoryMhdView>;
  recordChanges: ReturnType<typeof useExistingRecordChangeAccess>;
  setLocation: (to: string) => void;
  mhdRows: ReturnType<typeof useFactoryStockAllocationV5Model>["rows"];
}) {
  return (
    <>
      {model.query.isLoading ? (
        <LoadingState className="m-3 sm:m-4" />
      ) : model.query.isError ? (
        <div className="p-6 flex flex-col items-center gap-4">
          <p className="text-muted-foreground text-sm">{(model.query.error as Error)?.message || "Failed to load."}</p>
          <Button variant="outline" onClick={() => model.query.refetch()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Try Again
          </Button>
        </div>
      ) : model.rows.length === 0 ? (
        <div className="p-3 sm:p-4">
          <EmptyState title="No data found. Create a proforma with containers to use V5 stock allocation." />
        </div>
      ) : (
        <>
          <FactoryStockAllocationV5MobileList model={model} />

          <div
            data-horizontal-scroll="true"
            className="hidden overflow-x-auto md:block phone-land:hidden mx-3 rounded-b-xl border border-t-0 bg-card shadow-sm sm:mx-5"
          >
            <table className="w-full min-w-[1080px] table-fixed border-collapse text-sm">
              <colgroup>
                <col style={{ width: "29%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "19%" }} />
                <col style={{ width: "6%" }} />
              </colgroup>
              <thead>
                <tr className="sticky top-0 z-30 bg-slate-100 text-slate-700 dark:bg-slate-800/95 dark:text-slate-200">
                  <th className="sticky left-0 z-20 border-b border-r bg-slate-100 px-4 py-3 text-left text-xs font-semibold dark:bg-slate-800/95">
                    Product
                  </th>
                  <th className="border-b border-r px-3 py-3 text-left text-xs font-semibold">Code</th>
                  <th className="px-2 py-3 text-center text-xs font-semibold border-b border-r whitespace-nowrap text-green-700 dark:text-green-400">
                    Stock Available
                  </th>
                  <th className="px-2 py-3 text-center text-xs font-semibold border-b border-r whitespace-nowrap text-amber-600 dark:text-amber-400">
                    Expected to Load
                  </th>
                  <th className="px-2 py-3 text-center text-xs font-semibold border-b border-r whitespace-nowrap text-blue-600 dark:text-blue-400">
                    Total Loaded
                  </th>
                  <th className="px-2 py-3 text-center text-xs font-semibold border-b border-r whitespace-nowrap">
                    Available Balance
                  </th>
                  <th className="border-b px-2 py-3 text-center text-xs font-semibold whitespace-nowrap">Action</th>
                </tr>
              </thead>
              <tbody>
                {mhdRows.map((row, idx) => {
                  const isExpanded = model.expandedRows.has(row.articleCode);
                  const isShortage = row.freeToPromise < 0;

                  return (
                    <Fragment key={row.articleCode}>
                      <tr
                        className={cn(
                          "border-b transition-colors",
                          idx % 2 === 0 ? "bg-card" : "bg-muted/25",
                          isShortage && "bg-rose-500/[0.06]"
                        )}
                        style={isShortage ? { boxShadow: "inset 3px 0 0 hsl(var(--destructive))" } : undefined}
                        data-testid={`row-v5-${row.articleCode}`}
                      >
                        <td className="sticky left-0 z-10 border-r bg-inherit px-4 py-2.5">
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                              {isShortage && <AlertTriangle className="h-4 w-4 text-rose-500" />}
                            </span>
                            <span
                              className="block truncate text-xs font-semibold sm:text-sm"
                              title={mhd.nameFor(row.articleCode, row.productName)}
                            >
                              {mhd.nameFor(row.articleCode, row.productName)}
                            </span>
                          </div>
                        </td>
                        <td className="border-r px-3 py-2.5 font-mono text-xs text-muted-foreground">
                          {row.articleCode}
                        </td>

                        <td className="border-r px-2 py-2.5 text-center font-mono text-xs tabular-nums">
                          {row.stockAvailable > 0 ? (
                            <span className="text-green-700 dark:text-green-400 font-medium">{row.stockAvailable}</span>
                          ) : (
                            <span className="text-muted-foreground/40">0</span>
                          )}
                        </td>

                        <td
                          className={cn(
                            "border-r px-2 py-2.5 text-center font-mono text-xs tabular-nums",
                            row.expectedToLoad > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/40"
                          )}
                        >
                          {row.expectedToLoad > 0 ? row.expectedToLoad : "0"}
                        </td>

                        <td
                          className={cn(
                            "border-r px-2 py-2.5 text-center font-mono text-xs tabular-nums",
                            row.totalLoaded > 0 ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/40"
                          )}
                        >
                          {row.totalLoaded > 0 ? row.totalLoaded : <span className="text-muted-foreground/40">—</span>}
                        </td>

                        <td className="border-r px-2 py-2.5 text-center">
                          <div className="flex flex-col items-center gap-0.5">
                            <span
                              className={cn(
                                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold font-mono tabular-nums ring-1",
                                row.freeToPromise < 0
                                  ? "bg-destructive/10 text-destructive ring-destructive/30"
                                  : row.freeToPromise === 0
                                    ? "bg-muted text-muted-foreground ring-border"
                                    : "bg-green-500/10 text-green-700 dark:text-green-400 ring-green-500/30"
                              )}
                            >
                              {row.freeToPromise > 0 ? `+${row.freeToPromise}` : row.freeToPromise}
                            </span>
                            {isShortage && (
                              <span className="text-[11px] text-destructive/70 font-normal">
                                need {Math.abs(row.freeToPromise)} more
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="px-2 py-2.5 text-center">
                          {row.proformaDetails.length > 0 ? (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => model.toggleRow(row.articleCode)}
                              data-testid={`button-v5-expand-${row.articleCode}`}
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <MoreHorizontal className="h-4 w-4" />
                              )}
                            </Button>
                          ) : (
                            <span className="text-muted-foreground/30 text-xs">—</span>
                          )}
                        </td>
                      </tr>

                      {/* Expandable proforma/container detail */}
                      {isExpanded &&
                        row.proformaDetails.map((proforma) => {
                          const activeContainers = proforma.containers.filter(
                            (c) => c.status !== "FINALIZED" && c.status !== "CANCELLED"
                          );

                          const isFocused = model.focusProformaId === proforma.proformaId;
                          const isFirstFocused = isFocused && !model.firstMatchRef.current;

                          return (
                            <tr
                              key={`${row.articleCode}-p${proforma.proformaId}`}
                              ref={
                                isFirstFocused
                                  ? (el) => {
                                      model.firstMatchRef.current = el;
                                    }
                                  : undefined
                              }
                              className={cn(
                                "border-b",
                                isFocused ? "bg-primary/10 ring-1 ring-inset ring-primary/30" : "bg-muted/30"
                              )}
                            >
                              <td colSpan={7} className="px-0 py-0">
                                <div className="px-8 py-2">
                                  <div className="flex items-center gap-2 mb-1.5 text-xs flex-wrap">
                                    <span className={cn("font-semibold", isFocused && "text-primary")}>
                                      {proforma.proformaName}
                                    </span>
                                    <span className="text-muted-foreground">—</span>
                                    <span className="text-muted-foreground">{proforma.customerName}</span>
                                    <Badge variant="outline" className="text-[11px] h-4 px-1">
                                      {proforma.containerCount} container{proforma.containerCount !== 1 ? "s" : ""}
                                    </Badge>
                                    <span className="text-muted-foreground">
                                      {proforma.lineQty} × {proforma.containerCount} =
                                      <span className="font-semibold text-amber-600 dark:text-amber-400 ml-1">
                                        {proforma.totalExpected} expected
                                      </span>
                                    </span>
                                    {recordChanges.allowed && (
                                      <>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="h-5 px-2 text-[11px]"
                                          data-testid={`button-v5-add-containers-${proforma.proformaId}`}
                                          onClick={() =>
                                            model.openAddContainers(
                                              proforma.proformaId,
                                              proforma.proformaName,
                                              proforma.containerCount
                                            )
                                          }
                                        >
                                          <Plus className="h-2.5 w-2.5 mr-1" />
                                          Add Containers
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="h-5 px-2 text-[11px]"
                                          data-testid={`button-v5-link-container-${proforma.proformaId}`}
                                          onClick={() => {
                                            model.setLinkSelected(new Set());
                                            model.setLinkDialog({
                                              proformaId: proforma.proformaId,
                                              proformaName: proforma.proformaName,
                                              proformaCustomerId: proforma.customerId ?? null,
                                            });
                                          }}
                                        >
                                          <Link2 className="h-2.5 w-2.5 mr-1" />
                                          Link Existing
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="h-5 px-2 text-[11px]"
                                          data-testid={`button-v5-edit-proforma-${proforma.proformaId}`}
                                          onClick={() =>
                                            setLocation(
                                              `/factory/stock-allocation-v5/proformas/${proforma.proformaId}/edit`
                                            )
                                          }
                                        >
                                          <Pencil className="h-2.5 w-2.5 mr-1" />
                                          Edit Proforma
                                        </Button>
                                        {activeContainers.some((c) => c.status === "DRAFT" && c.loadedQty === 0) && (
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-5 px-2 text-[11px]"
                                            data-testid={`button-v5-edit-draft-${proforma.proformaId}`}
                                            onClick={() =>
                                              model.openEditDraft(
                                                proforma.proformaId,
                                                proforma.proformaName,
                                                model.rows
                                              )
                                            }
                                          >
                                            <Pencil className="h-2.5 w-2.5 mr-1" />
                                            Edit Draft Qty
                                          </Button>
                                        )}
                                      </>
                                    )}
                                  </div>

                                  {activeContainers.length > 0 ? (
                                    <div className="flex flex-wrap gap-2">
                                      {activeContainers.map((c) => (
                                        <div
                                          key={c.orderId}
                                          className="flex items-center gap-1.5 bg-background border rounded-md px-2 py-1 text-xs"
                                          data-testid={`detail-v5-container-${c.orderId}`}
                                        >
                                          <Container className="h-3 w-3 text-muted-foreground shrink-0" />
                                          <span className="font-medium">{c.containerName}</span>
                                          <Badge variant="outline" className="text-[11px] h-4 px-1">
                                            {STATUS_LABELS[c.status] ?? c.status}
                                          </Badge>
                                          <span className="text-muted-foreground tabular-nums">
                                            {c.loadedQty}/{c.expectedQty}
                                            {c.remainingQty > 0 && (
                                              <span className="text-amber-500 ml-1">-{c.remainingQty}</span>
                                            )}
                                            {c.remainingQty === 0 && c.expectedQty > 0 && (
                                              <span className="text-green-500 ml-1">✓</span>
                                            )}
                                          </span>
                                          {recordChanges.allowed &&
                                            (c.status === "DRAFT" || c.status === "LOADING") && (
                                              <button
                                                type="button"
                                                title={`Cancel ${c.containerName}`}
                                                data-testid={`button-v5-cancel-container-${c.orderId}`}
                                                onClick={() => {
                                                  model.setCancelSuperUser("");
                                                  model.setCancelSuperPass("");
                                                  model.setCancelDialog({
                                                    orderId: c.orderId,
                                                    containerName: c.containerName,
                                                    status: c.status as "DRAFT" | "LOADING",
                                                  });
                                                }}
                                                className="ml-0.5 text-muted-foreground hover:text-destructive transition-colors"
                                              >
                                                <X className="h-3 w-3" />
                                              </button>
                                            )}
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="text-[11px] text-muted-foreground italic">No containers linked yet</p>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                    </Fragment>
                  );
                })}

                {/* Totals row */}
                {model.totals && (
                  <tr className="sticky bottom-0 z-10 border-t-2 bg-slate-100 text-xs font-semibold dark:bg-slate-800">
                    <td className="sticky left-0 z-20 border-r bg-slate-100 px-4 py-3 dark:bg-slate-800">
                      Totals <span className="font-normal text-muted-foreground">({model.rows.length} products)</span>
                    </td>
                    <td className="border-r px-3 py-3 text-xs text-muted-foreground">Total</td>
                    <td className="border-r px-2 py-3 text-center font-mono tabular-nums">
                      <span className="text-green-700 dark:text-green-400">{model.totals.stockAvailable}</span>
                    </td>
                    <td className="border-r px-2 py-3 text-center font-mono tabular-nums text-amber-600 dark:text-amber-400">
                      {model.totals.expectedToLoad}
                    </td>
                    <td className="border-r px-2 py-3 text-center font-mono tabular-nums text-blue-600 dark:text-blue-400">
                      {model.totals.totalLoaded > 0 ? model.totals.totalLoaded : "—"}
                    </td>
                    <td className="border-r px-2 py-3 text-center">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold font-mono tabular-nums ring-1",
                          model.totals.freeToPromise < 0
                            ? "bg-destructive/10 text-destructive ring-destructive/30"
                            : model.totals.freeToPromise === 0
                              ? "bg-muted text-muted-foreground ring-border"
                              : "bg-green-500/10 text-green-700 dark:text-green-400 ring-green-500/30"
                        )}
                      >
                        {model.totals.freeToPromise > 0 ? `+${model.totals.freeToPromise}` : model.totals.freeToPromise}
                      </span>
                    </td>
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
