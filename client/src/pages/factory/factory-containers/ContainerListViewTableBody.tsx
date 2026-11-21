// Extracted from ./ContainerListView.tsx
import { Building2, ChevronDown, ChevronRight, ArrowDown, PlusCircle, RotateCcw, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber } from "@/lib/formatNumber";
import { ContainerStatusBadge } from "./ContainerBadges";
import { containerTotalValue, type ContainerListViewProps } from "./ContainerListViewHelpers";
import { useContainerListViewState } from "./useContainerListViewState";

export function ContainerListViewTableBody({
  expandedSuppliers,
  groups,
  onDelete,
  onEdit,
  onNavigateOffload,
  onPostOffload,
  onReverseOffload,
  onView,
  recordChangeReason,
  recordChanges,
  selectedIds,
  setSelectedIds,
  toggleSupplier,
}: Pick<
  ContainerListViewProps,
  | "expandedSuppliers"
  | "onDelete"
  | "onEdit"
  | "onNavigateOffload"
  | "onPostOffload"
  | "onReverseOffload"
  | "onView"
  | "selectedIds"
  | "setSelectedIds"
> &
  Pick<
    ReturnType<typeof useContainerListViewState>,
    "groups" | "recordChangeReason" | "recordChanges" | "toggleSupplier"
  >) {
  return (
    <TableBody>
      {groups.map(({ supplierKey, supplierName, containers: groupContainers }) => {
        const isExpanded = expandedSuppliers.has(supplierKey);
        const count = groupContainers.length;
        const groupTotals = new Map<string, number>();
        for (const c of groupContainers) {
          const ccy = c.currencyCode || "USD";
          groupTotals.set(ccy, (groupTotals.get(ccy) || 0) + containerTotalValue(c));
        }
        return [
          <TableRow
            key={`supplier-${supplierKey}`}
            className="cursor-pointer border-b border-border/60 bg-muted/30 transition-colors hover:bg-blue-500/10 dark:bg-slate-800/50 dark:hover:bg-slate-800/90"
            onClick={() => toggleSupplier(supplierKey)}
            data-testid={`row-supplier-group-${supplierKey}`}
          >
            <TableCell className="w-10 py-3.5">
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 text-blue-600 dark:text-blue-300" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </TableCell>
            <TableCell colSpan={2} className="py-3.5">
              <div className="flex items-center gap-2.5">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-300">
                  <Building2 className="h-4 w-4" />
                </span>
                <span className="text-sm font-semibold tracking-tight">{supplierName}</span>
                <Badge variant="secondary" className="rounded-full border border-border/60 px-2.5 py-0.5 text-xs">
                  {count} container{count !== 1 ? "s" : ""}
                </Badge>
              </div>
            </TableCell>
            <TableCell className="py-3.5 text-right font-mono text-sm font-semibold tabular-nums">
              {(() => {
                const totalKg = groupContainers.reduce((s, c) => s + parseFloat(c.totalKg || "0"), 0);
                return totalKg > 0 ? formatNumber(totalKg) : <span className="text-muted-foreground">—</span>;
              })()}
            </TableCell>
            <TableCell className="py-3.5 font-mono text-sm font-semibold tabular-nums">
              {Array.from(groupTotals.entries()).map(([cc, amt]) => (
                <div key={cc}>
                  {cc} {formatNumber(amt)}
                </div>
              ))}
            </TableCell>
            <TableCell colSpan={2} className="py-3.5" />
          </TableRow>,
          ...(isExpanded
            ? groupContainers.map((c) => {
                const commAmt = parseFloat(c.commissionAmount || "0");
                const commCcy = c.commissionCurrencyCode || "USD";
                const ccy = c.currencyCode || "USD";
                const totalValue = containerTotalValue(c);
                return (
                  <TableRow
                    key={c.id}
                    data-testid={`row-factory-container-${c.id}`}
                    className={
                      selectedIds.has(c.id)
                        ? "border-border/40 bg-blue-500/10 dark:bg-blue-500/15"
                        : "border-border/40 transition-colors hover:bg-blue-500/5 dark:hover:bg-blue-400/10"
                    }
                  >
                    <TableCell className="w-10 pl-6">
                      <Checkbox
                        checked={selectedIds.has(c.id)}
                        onCheckedChange={(checked) => {
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (checked) next.add(c.id);
                            else next.delete(c.id);
                            return next;
                          });
                        }}
                        data-testid={`checkbox-container-${c.id}`}
                      />
                    </TableCell>
                    <TableCell className="font-mono font-semibold tabular-nums">
                      <button
                        className="cursor-pointer text-left text-blue-700 hover:text-blue-600 hover:underline dark:text-blue-300 dark:hover:text-blue-200"
                        onClick={() => onView(c)}
                        data-testid={`button-view-container-${c.id}`}
                      >
                        {c.containerNumber}
                      </button>
                    </TableCell>
                    <TableCell className="font-mono">
                      {commAmt > 0 ? (
                        `${commCcy} ${formatNumber(commAmt)}`
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums" data-testid={`text-weight-${c.id}`}>
                      {parseFloat(c.totalKg || "0") > 0 ? (
                        formatNumber(parseFloat(c.totalKg || "0"))
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono font-semibold tabular-nums">
                      {totalValue > 0 ? (
                        `${ccy} ${formatNumber(totalValue)}`
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <ContainerStatusBadge status={c.status} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {c.status !== "OFFLOADED" && c.status !== "PARTIALLY_RECEIVED" && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={onNavigateOffload}
                                disabled={!recordChanges.allowed}
                                title={recordChangeReason}
                                aria-label={recordChanges.reason ?? "Offload to Production"}
                                data-testid={`button-offload-container-${c.id}`}
                              >
                                <ArrowDown className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Offload to Production</TooltipContent>
                          </Tooltip>
                        )}
                        {(c.status === "OFFLOADED" || c.status === "PARTIALLY_RECEIVED") && (
                          <>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => onPostOffload(c)}
                                  disabled={!recordChanges.allowed}
                                  title={recordChangeReason}
                                  aria-label={recordChanges.reason ?? "Add Post-Offload Charges"}
                                  data-testid={`button-post-offload-charges-${c.id}`}
                                >
                                  <PlusCircle className="h-4 w-4 text-blue-500" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Add Post-Offload Charges</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => onReverseOffload(c)}
                                  disabled={!recordChanges.allowed}
                                  title={recordChangeReason}
                                  aria-label={recordChanges.reason ?? "Reverse Offload"}
                                  data-testid={`button-reverse-offload-${c.id}`}
                                >
                                  <RotateCcw className="h-4 w-4 text-amber-500" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Reverse Offload</TooltipContent>
                            </Tooltip>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onEdit(c)}
                          disabled={!recordChanges.allowed}
                          title={recordChangeReason}
                          aria-label={recordChanges.reason ?? "Edit container"}
                          data-testid={`button-edit-container-${c.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onDelete(c.id)}
                          disabled={!recordChanges.allowed}
                          title={recordChangeReason}
                          aria-label={recordChanges.reason ?? "Delete container"}
                          data-testid={`button-delete-container-${c.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            : []),
        ];
      })}
    </TableBody>
  );
}
