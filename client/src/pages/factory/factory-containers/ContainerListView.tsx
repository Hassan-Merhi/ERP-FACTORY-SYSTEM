import {
  Container,
  Building2,
  ChevronDown,
  ChevronRight,
  ArrowDown,
  PlusCircle,
  RotateCcw,
  Pencil,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTableToolbar } from "@/components/DataTableToolbar";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber } from "@/lib/formatNumber";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { FactorySupplier } from "@shared/schema";
import { ContainerStatusBadge } from "./ContainerBadges";
import type { ContainerWithSupplier } from "./otwHelpers";

interface ContainerListViewProps {
  containers: ContainerWithSupplier[] | undefined;
  filteredContainers: ContainerWithSupplier[] | undefined;
  suppliers: FactorySupplier[] | undefined;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  hasActiveFilters: boolean;
  onResetFilters: () => void;
  expandedSuppliers: Set<string>;
  setExpandedSuppliers: (fn: (prev: Set<string>) => Set<string>) => void;
  selectedIds: Set<number>;
  setSelectedIds: (fn: (prev: Set<number>) => Set<number>) => void;
  onView: (c: ContainerWithSupplier) => void;
  onEdit: (c: ContainerWithSupplier) => void;
  onDelete: (id: number) => void;
  onPostOffload: (c: ContainerWithSupplier) => void;
  onReverseOffload: (c: ContainerWithSupplier) => void;
  onNavigateOffload: () => void;
}

export function ContainerListView({
  containers,
  filteredContainers,
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  hasActiveFilters,
  onResetFilters,
  expandedSuppliers,
  setExpandedSuppliers,
  selectedIds,
  setSelectedIds,
  onView,
  onEdit,
  onDelete,
  onPostOffload,
  onReverseOffload,
  onNavigateOffload,
}: ContainerListViewProps) {
  const recordChanges = useExistingRecordChangeAccess();
  const recordChangeReason = recordChanges.reason ?? undefined;
  const toggleSupplier = (key: string) => {
    setExpandedSuppliers((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Group containers by supplier
  const groups: { supplierKey: string; supplierName: string; containers: ContainerWithSupplier[] }[] = [];
  const seenKeys = new Map<string, number>();
  for (const c of filteredContainers || []) {
    const key = c.supplierName || "__none__";
    if (!seenKeys.has(key)) {
      seenKeys.set(key, groups.length);
      groups.push({ supplierKey: key, supplierName: c.supplierName || "No Supplier", containers: [] });
    }
    groups[seenKeys.get(key)!].containers.push(c);
  }

  return (
    <section
      className="overflow-hidden rounded-2xl border border-border/70 bg-card/95 shadow-sm dark:border-blue-200/10 dark:bg-slate-900/60"
      aria-label="All factory containers"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-gradient-to-r from-blue-500/5 via-background/40 to-violet-500/5 px-4 py-4 sm:px-5">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-300">
            <Container className="h-5 w-5" />
          </span>
          <span className="text-sm font-semibold tracking-tight sm:text-base">
            Containers ({filteredContainers?.length || 0}
            {filteredContainers?.length !== containers?.length ? ` of ${containers?.length}` : ""})
          </span>
        </div>
        <DataTableToolbar
          search={searchQuery}
          onSearchChange={setSearchQuery}
          searchPlaceholder="Search containers..."
          searchTestId="input-search-containers"
          mobileFilters
          filterLabel="Container filters"
          activeFilterCount={statusFilter !== "all" ? 1 : 0}
          onResetFilters={onResetFilters}
          className="mb-0"
          filters={
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger
                className="w-40 rounded-lg border-border/70 bg-background/80 shadow-sm"
                data-testid="select-filter-status"
              >
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="IN_TRANSIT">In Transit</SelectItem>
                <SelectItem value="AVAILABLE">Available</SelectItem>
                <SelectItem value="OFFLOADED">Offloaded</SelectItem>
                <SelectItem value="HAS_WEIGHT">Has Weight</SelectItem>
                <SelectItem value="NO_WEIGHT">No Weight</SelectItem>
              </SelectContent>
            </Select>
          }
          actions={
            hasActiveFilters ? (
              <Button variant="outline" type="button" onClick={onResetFilters} data-testid="button-reset-filters">
                <RotateCcw className="mr-2 h-4 w-4" />
                Reset filters
              </Button>
            ) : undefined
          }
        />
      </div>

      <div data-horizontal-scroll="true" className="overflow-x-auto">
        {filteredContainers && filteredContainers.length > 0 ? (
          <Table mobileLayout="cards" wrapperClassName="overflow-visible rounded-none border-0">
            <TableHeader className="sticky top-0 z-30 bg-card dark:bg-slate-900">
              <TableRow className="border-b border-border/70 bg-blue-500/5 hover:bg-blue-500/5 dark:bg-slate-800/70 dark:hover:bg-slate-800/70">
                <TableHead className="w-10 py-2">
                  <Checkbox
                    checked={filteredContainers.length > 0 && filteredContainers.every((c) => selectedIds.has(c.id))}
                    onCheckedChange={(checked) => {
                      if (checked) setSelectedIds(() => new Set(filteredContainers.map((c) => c.id)));
                      else setSelectedIds(() => new Set());
                    }}
                    data-testid="checkbox-select-all"
                  />
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Container #
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Commission
                </TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Weight (kg)
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Total Value
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Status
                </TableHead>
                <TableHead className="w-24 text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map(({ supplierKey, supplierName, containers: groupContainers }) => {
                const isExpanded = expandedSuppliers.has(supplierKey);
                const count = groupContainers.length;
                const groupTotals = new Map<string, number>();
                for (const c of groupContainers) {
                  const ccy = c.currencyCode || "USD";
                  const baseValue = parseFloat(c.totalKg || "0") * parseFloat(c.ratePerKg || "0");
                  const freightAmt = parseFloat(c.freight || "0");
                  const freightCcy = c.freightCurrencyCode || ccy;
                  const freightSameCcy = freightCcy === ccy;
                  const legacyOtherAmt = parseFloat(c.otherCharges || "0");
                  const preRegisteredAmt = parseFloat(
                    (c as unknown as ContainerWithSupplier & { preRegisteredChargesSum: string })
                      .preRegisteredChargesSum || "0"
                  );
                  const additionalAmt = parseFloat(
                    (c as unknown as ContainerWithSupplier & { additionalChargesSum: string }).additionalChargesSum ||
                      "0"
                  );
                  const totalInCcy =
                    baseValue + (freightSameCcy ? freightAmt : 0) + legacyOtherAmt + preRegisteredAmt + additionalAmt;
                  groupTotals.set(ccy, (groupTotals.get(ccy) || 0) + totalInCcy);
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
                        <Badge
                          variant="secondary"
                          className="rounded-full border border-border/60 px-2.5 py-0.5 text-xs"
                        >
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
                        const baseValue = parseFloat(c.totalKg || "0") * parseFloat(c.ratePerKg || "0");
                        const freightAmt = parseFloat(c.freight || "0");
                        const freightCcy = c.freightCurrencyCode || ccy;
                        const freightSameCcy = freightCcy === ccy;
                        const legacyOtherAmt = parseFloat(c.otherCharges || "0");
                        const preRegisteredAmt = parseFloat(
                          (c as unknown as ContainerWithSupplier & { preRegisteredChargesSum: string })
                            .preRegisteredChargesSum || "0"
                        );
                        const additionalAmt = parseFloat(
                          (c as unknown as ContainerWithSupplier & { additionalChargesSum: string })
                            .additionalChargesSum || "0"
                        );
                        const totalValue =
                          baseValue +
                          (freightSameCcy ? freightAmt : 0) +
                          legacyOtherAmt +
                          preRegisteredAmt +
                          additionalAmt;
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
                            <TableCell
                              className="text-right font-mono tabular-nums"
                              data-testid={`text-weight-${c.id}`}
                            >
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
          </Table>
        ) : (
          <div className="py-16 text-center text-muted-foreground">
            <Container className="h-12 w-12 mx-auto mb-3 opacity-50" />
            {containers && containers.length > 0 ? (
              <>
                <p className="text-lg font-medium">No matching containers</p>
                <p className="text-sm mt-1">Try adjusting your search or filter</p>
              </>
            ) : (
              <>
                <p className="text-lg font-medium">No factory containers yet</p>
                <p className="text-sm mt-1">Add your first container to start tracking arrivals</p>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
