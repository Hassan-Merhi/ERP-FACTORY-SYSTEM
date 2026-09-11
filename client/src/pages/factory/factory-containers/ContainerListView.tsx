import {
  Search,
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
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber } from "@/lib/formatNumber";
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
  suppliers: _suppliers,
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
  const toggleSupplier = (key: string) => {
    setExpandedSuppliers((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const _renderCharges = (
    c: ContainerWithSupplier & { additionalChargesSum?: string | null; preRegisteredChargesByCurrency?: unknown }
  ) => {
    const ccy = c.currencyCode || "USD";
    const freightAmt = parseFloat(c.freight || "0");
    const freightCcy = c.freightCurrencyCode || ccy;
    const freightSameCcy = freightCcy === ccy;
    const legacyOtherAmt = parseFloat(c.otherCharges || "0");
    const additionalAmt = parseFloat(c.additionalChargesSum || "0");
    let chargesByCcy: { currencyCode: string; amount: number }[] = [];
    try {
      const raw =
        typeof c.preRegisteredChargesByCurrency === "string"
          ? JSON.parse(c.preRegisteredChargesByCurrency)
          : c.preRegisteredChargesByCurrency || [];
      chargesByCcy = Array.isArray(raw)
        ? raw.map((x) => ({ currencyCode: x.currencyCode || "USD", amount: parseFloat(x.amount || "0") }))
        : [];
    } catch {
      // Malformed or absent payload — fall through to the default rather than surface a parse error.
    }
    const hasCharges =
      freightAmt > 0 || legacyOtherAmt > 0 || chargesByCcy.some((x) => x.amount > 0) || additionalAmt > 0;
    if (!hasCharges) return <span className="text-muted-foreground">—</span>;
    const ccyTotals = new Map<string, number>();
    if (freightSameCcy && freightAmt > 0) ccyTotals.set(freightCcy, (ccyTotals.get(freightCcy) || 0) + freightAmt);
    if (legacyOtherAmt > 0) ccyTotals.set(ccy, (ccyTotals.get(ccy) || 0) + legacyOtherAmt);
    for (const ch of chargesByCcy) {
      if (ch.amount > 0) ccyTotals.set(ch.currencyCode, (ccyTotals.get(ch.currencyCode) || 0) + ch.amount);
    }
    if (additionalAmt > 0) ccyTotals.set(ccy, (ccyTotals.get(ccy) || 0) + additionalAmt);
    return (
      <div className="space-y-0.5">
        <div className="font-mono text-sm">
          {Array.from(ccyTotals.entries()).map(([cc, amt]) => (
            <div key={cc}>
              {cc} {formatNumber(amt)}
            </div>
          ))}
          {!freightSameCcy && freightAmt > 0 && (
            <div>
              {freightCcy} {formatNumber(freightAmt)}
            </div>
          )}
        </div>
        <div className="text-xs text-muted-foreground space-y-0">
          {freightAmt > 0 && (
            <div>
              Freight: {freightCcy} {formatNumber(freightAmt)}
            </div>
          )}
          {(legacyOtherAmt > 0 || chargesByCcy.some((x) => x.amount > 0)) && (
            <div>
              Other:{" "}
              {(() => {
                const parts: string[] = [];
                if (legacyOtherAmt > 0) parts.push(`${ccy} ${formatNumber(legacyOtherAmt)}`);
                for (const ch of chargesByCcy) {
                  if (ch.amount > 0) parts.push(`${ch.currencyCode} ${formatNumber(ch.amount)}`);
                }
                return parts.join(" + ");
              })()}
            </div>
          )}
          {additionalAmt > 0 && (
            <div>
              Additional: {ccy} {formatNumber(additionalAmt)}
            </div>
          )}
        </div>
      </div>
    );
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
    <div className="rounded-xl border overflow-hidden">
      <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-b bg-muted/20">
        <div className="flex items-center gap-2">
          <Container className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">
            Containers ({filteredContainers?.length || 0}
            {filteredContainers?.length !== containers?.length ? ` of ${containers?.length}` : ""})
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative w-52">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search containers..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              data-testid="input-search-containers"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40" data-testid="select-filter-status">
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
          {hasActiveFilters && (
            <Button variant="outline" type="button" onClick={onResetFilters} data-testid="button-reset-filters">
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset filters
            </Button>
          )}
        </div>
      </div>

      <div className="overflow-auto max-h-[calc(100vh-280px)]">
        {filteredContainers && filteredContainers.length > 0 ? (
          <Table wrapperClassName="overflow-visible border-0 rounded-none">
            <TableHeader className="sticky top-0 z-30 bg-background">
              <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
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
                    className="bg-muted/40 hover-elevate cursor-pointer border-b border-border/50"
                    onClick={() => toggleSupplier(supplierKey)}
                    data-testid={`row-supplier-group-${supplierKey}`}
                  >
                    <TableCell className="w-10 py-2.5">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </TableCell>
                    <TableCell colSpan={2} className="py-2.5">
                      <div className="flex items-center gap-2">
                        <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="text-sm font-semibold">{supplierName}</span>
                        <Badge variant="secondary" className="text-xs">
                          {count} container{count !== 1 ? "s" : ""}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono font-semibold text-sm py-2.5">
                      {(() => {
                        const totalKg = groupContainers.reduce((s, c) => s + parseFloat(c.totalKg || "0"), 0);
                        return totalKg > 0 ? formatNumber(totalKg) : <span className="text-muted-foreground">—</span>;
                      })()}
                    </TableCell>
                    <TableCell className="font-mono font-semibold text-sm py-2.5">
                      {Array.from(groupTotals.entries()).map(([cc, amt]) => (
                        <div key={cc}>
                          {cc} {formatNumber(amt)}
                        </div>
                      ))}
                    </TableCell>
                    <TableCell colSpan={2} className="py-2.5" />
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
                            className={selectedIds.has(c.id) ? "bg-muted/50" : ""}
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
                            <TableCell className="font-semibold font-mono">
                              <button
                                className="hover:underline text-left cursor-pointer text-foreground"
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
                            <TableCell className="text-right font-mono" data-testid={`text-weight-${c.id}`}>
                              {parseFloat(c.totalKg || "0") > 0 ? (
                                formatNumber(parseFloat(c.totalKg || "0"))
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="font-mono font-semibold">
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
                              <div className="flex gap-1">
                                {c.status !== "OFFLOADED" && c.status !== "PARTIALLY_RECEIVED" && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={onNavigateOffload}
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
                                  data-testid={`button-edit-container-${c.id}`}
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => onDelete(c.id)}
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
          <div className="text-center py-8 text-muted-foreground">
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
    </div>
  );
}
