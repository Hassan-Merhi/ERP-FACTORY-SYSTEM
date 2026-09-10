import { AlertTriangle, ChevronDown, ChevronRight, Container, Link2, Pencil, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { STATUS_LABELS } from "../utils";
import type { useFactoryStockAllocationV5Model } from "../useFactoryStockAllocationV5Model";

type Model = ReturnType<typeof useFactoryStockAllocationV5Model>;

/**
 * Phone layout for the V5 allocation rows.
 *
 * Rendered alongside the desktop table and hidden above the `md` breakpoint by
 * CSS, so both trees exist in the DOM at once — a text query that does not scope
 * itself to one of them will match twice.
 */
export function FactoryStockAllocationV5MobileList({ model }: { model: Model }) {
  const {
    rows,
    totals,
    expandedRows,
    toggleRow,
    focusProformaId,
    openAddContainers,
    openEditDraft,
    setCancelDialog,
    setCancelSuperPass,
    setCancelSuperUser,
    setEditDrawerProformaId,
    setLinkDialog,
    setLinkSelected,
  } = model;

  return (
    <div className="space-y-3 overflow-y-auto p-3 md:hidden" data-testid="v5-mobile-list">
      {totals && (
        <div className="grid grid-cols-2 gap-2 rounded-xl border bg-muted/30 p-3" data-testid="v5-mobile-totals">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Stock</div>
            <div className="font-mono text-sm font-bold text-green-700 dark:text-green-400">
              {totals.stockAvailable}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Expected</div>
            <div className="font-mono text-sm font-bold text-amber-600 dark:text-amber-400">
              {totals.expectedToLoad}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Loaded</div>
            <div className="font-mono text-sm font-bold text-blue-600 dark:text-blue-400">{totals.totalLoaded}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Balance</div>
            <div className={cn("font-mono text-sm font-bold", totals.freeToPromise < 0 && "text-destructive")}>
              {totals.freeToPromise > 0 ? `+${totals.freeToPromise}` : totals.freeToPromise}
            </div>
          </div>
        </div>
      )}

      {rows.map((row) => {
        const isExpanded = expandedRows.has(row.articleCode);
        const isShortage = row.freeToPromise < 0;

        return (
          <Card
            key={`mobile-${row.articleCode}`}
            className={cn("overflow-hidden", isShortage && "border-destructive/40")}
            data-testid={`card-v5-mobile-${row.articleCode}`}
          >
            <CardContent className="space-y-3 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {isShortage && <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />}
                    <span className="break-words text-sm font-semibold">{row.productName}</span>
                  </div>
                  <div className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{row.articleCode}</div>
                  {row.categoryName && (
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{row.categoryName}</div>
                  )}
                </div>
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-bold font-mono tabular-nums ring-1",
                    row.freeToPromise < 0
                      ? "bg-destructive/10 text-destructive ring-destructive/30"
                      : row.freeToPromise === 0
                        ? "bg-muted text-muted-foreground ring-border"
                        : "bg-green-500/10 text-green-700 dark:text-green-400 ring-green-500/30"
                  )}
                  data-testid={`text-v5-mobile-balance-${row.articleCode}`}
                >
                  {row.freeToPromise > 0 ? `+${row.freeToPromise}` : row.freeToPromise}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-muted/40 p-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Stock Available</div>
                  <div className="mt-0.5 font-mono font-semibold text-green-700 dark:text-green-400">
                    {row.stockAvailable}
                  </div>
                </div>
                <div className="rounded-lg bg-muted/40 p-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Expected to Load</div>
                  <div className="mt-0.5 font-mono font-semibold text-amber-600 dark:text-amber-400">
                    {row.expectedToLoad}
                  </div>
                </div>
                <div className="rounded-lg bg-muted/40 p-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Total Loaded</div>
                  <div className="mt-0.5 font-mono font-semibold text-blue-600 dark:text-blue-400">
                    {row.totalLoaded}
                  </div>
                </div>
                <div className="rounded-lg bg-muted/40 p-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Available Balance</div>
                  <div className={cn("mt-0.5 font-mono font-semibold", isShortage && "text-destructive")}>
                    {row.freeToPromise}
                  </div>
                </div>
              </div>

              {row.proformaDetails.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full justify-between"
                  onClick={() => toggleRow(row.articleCode)}
                  data-testid={`button-v5-mobile-expand-${row.articleCode}`}
                >
                  <span>
                    {row.proformaDetails.length} proforma{row.proformaDetails.length !== 1 ? "s" : ""}
                  </span>
                  {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
              )}

              {isExpanded && (
                <div className="space-y-3 border-t pt-3">
                  {row.proformaDetails.map((proforma) => {
                    const activeContainers = proforma.containers.filter(
                      (container) => container.status !== "FINALIZED" && container.status !== "CANCELLED"
                    );
                    const isFocused = focusProformaId === proforma.proformaId;

                    return (
                      <div
                        key={`mobile-${row.articleCode}-p${proforma.proformaId}`}
                        className={cn("space-y-2 rounded-lg border p-2.5", isFocused && "border-primary bg-primary/5")}
                        data-testid={`detail-v5-mobile-proforma-${proforma.proformaId}`}
                      >
                        <div className="min-w-0">
                          <div className={cn("break-words text-xs font-semibold", isFocused && "text-primary")}>
                            {proforma.proformaName}
                          </div>
                          <div className="mt-0.5 break-words text-[11px] text-muted-foreground">
                            {proforma.customerName}
                          </div>
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {proforma.lineQty} × {proforma.containerCount} = {proforma.totalExpected} expected
                          </div>
                        </div>

                        <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
                          <Button
                            size="sm"
                            variant="outline"
                            data-testid={`button-v5-mobile-add-containers-${proforma.proformaId}`}
                            onClick={() =>
                              openAddContainers(proforma.proformaId, proforma.proformaName, proforma.containerCount)
                            }
                          >
                            <Plus className="h-3.5 w-3.5 mr-1" />
                            Add Containers
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            data-testid={`button-v5-mobile-link-container-${proforma.proformaId}`}
                            onClick={() => {
                              setLinkSelected(new Set());
                              setLinkDialog({
                                proformaId: proforma.proformaId,
                                proformaName: proforma.proformaName,
                                proformaCustomerId: proforma.customerId ?? null,
                              });
                            }}
                          >
                            <Link2 className="h-3.5 w-3.5 mr-1" />
                            Link Existing
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            data-testid={`button-v5-mobile-edit-proforma-${proforma.proformaId}`}
                            onClick={() => setEditDrawerProformaId(proforma.proformaId)}
                          >
                            <Pencil className="h-3.5 w-3.5 mr-1" />
                            Edit Proforma
                          </Button>
                          {activeContainers.some(
                            (container) => container.status === "DRAFT" && container.loadedQty === 0
                          ) && (
                            <Button
                              size="sm"
                              variant="outline"
                              data-testid={`button-v5-mobile-edit-draft-${proforma.proformaId}`}
                              onClick={() => openEditDraft(proforma.proformaId, proforma.proformaName, rows)}
                            >
                              <Pencil className="h-3.5 w-3.5 mr-1" />
                              Edit Draft Qty
                            </Button>
                          )}
                        </div>

                        {activeContainers.length > 0 ? (
                          <div className="space-y-2">
                            {activeContainers.map((container) => (
                              <div
                                key={container.orderId}
                                className="flex min-w-0 items-center gap-2 rounded-md border bg-background px-2 py-2 text-xs"
                                data-testid={`detail-v5-mobile-container-${container.orderId}`}
                              >
                                <Container className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-medium">{container.containerName}</div>
                                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                                    <Badge variant="outline" className="h-4 px-1 text-[9px]">
                                      {STATUS_LABELS[container.status] ?? container.status}
                                    </Badge>
                                    <span className="tabular-nums">
                                      {container.loadedQty}/{container.expectedQty}
                                      {container.remainingQty > 0 && (
                                        <span className="ml-1 text-amber-500">-{container.remainingQty}</span>
                                      )}
                                      {container.remainingQty === 0 && container.expectedQty > 0 && (
                                        <span className="ml-1 text-green-500">✓</span>
                                      )}
                                    </span>
                                  </div>
                                </div>
                                {(container.status === "DRAFT" || container.status === "LOADING") && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="shrink-0 text-muted-foreground hover:text-destructive"
                                    title={`Cancel ${container.containerName}`}
                                    aria-label={`Cancel ${container.containerName}`}
                                    data-testid={`button-v5-mobile-cancel-container-${container.orderId}`}
                                    onClick={() => {
                                      setCancelSuperUser("");
                                      setCancelSuperPass("");
                                      setCancelDialog({
                                        orderId: container.orderId,
                                        containerName: container.containerName,
                                        status: container.status as "DRAFT" | "LOADING",
                                      });
                                    }}
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[11px] italic text-muted-foreground">No containers linked yet</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
