import { Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { ReportExportMenu } from "@/components/export/ReportExportMenu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Package, Eye, X, Ban, Loader2, Truck, Check, ChevronDown, Filter } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useContainerSpViewState, type ContainerSpViewProps } from "./useContainerSpViewState";
import { SearchField } from "@/components/ui/search-field";

export function ContainerSpView(props: ContainerSpViewProps) {
  const {
    allSpItems,
    canCancel,
    cancelContainer,
    exportContainers,
    filtered,
    formatAmount,
    formatDisplayDate,
    isSpLoading,
    offloadedContainers,
    otwContainers,
    reason,
    recordChanges,
    searchTerm,
    selectedContainer,
    setLocation,
    setReason,
    setSearchTerm,
    setSelectedContainer,
    setStatusFilter,
    setSupplierFilter,
    statusFilter,
    supplierFilter,
    supplierNames,
    totalValue,
    visibleContainers,
  } = useContainerSpViewState(props);

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader title="Container Tracking" subtitle="Track containers and manage offloading">
        <div className="flex flex-wrap gap-2">
          <ReportExportMenu
            align="start"
            data-testid="button-export-dropdown"
            options={[
              {
                id: "containers",
                label: "Export Excel",
                kind: "excel",
                onSelect: () => exportContainers(false),
                testId: "button-export-excel",
              },
              {
                id: "containers-full",
                label: "Export Excel (Full)",
                kind: "excel",
                onSelect: () => exportContainers(true),
                testId: "button-export-all-full",
              },
            ]}
          />
          {recordChanges.canCreate("POST", "/api/po-import/import") && (
            <Button className="gap-2" onClick={() => setLocation("/po-import")} data-testid="button-add-container">
              <Plus className="h-4 w-4" /> Import PO
            </Button>
          )}
        </div>
      </PageHeader>
      <div className="flex flex-wrap gap-3" data-testid="sp-container-summary">
        <div className="rounded-lg bg-muted/60 px-3 py-2 flex items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          <strong className="text-sm">{visibleContainers.length}</strong>
          <span className="text-xs text-muted-foreground">Containers</span>
        </div>
        <div className="rounded-lg bg-blue-500/10 px-3 py-2 flex items-center gap-2">
          <Truck className="h-4 w-4 text-blue-600" />
          <strong className="text-sm">{otwContainers.length}</strong>
          <span className="text-xs text-muted-foreground">OTW</span>
        </div>
        <div className="rounded-lg bg-green-500/10 px-3 py-2 flex items-center gap-2">
          <Check className="h-4 w-4 text-green-600" />
          <strong className="text-sm">{offloadedContainers.length}</strong>
          <span className="text-xs text-muted-foreground">Offloaded</span>
        </div>
        <div className="rounded-lg bg-primary/10 px-3 py-2 flex items-center gap-2">
          <strong className="text-sm tabular-nums">{formatAmount(totalValue)}</strong>
          <span className="text-xs text-muted-foreground">total value</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <SearchField
          value={searchTerm}
          onValueChange={setSearchTerm}
          placeholder="Search by container number, invoice, supplier..."
          wrapperClassName="flex-1 min-w-[220px]"
          data-testid="input-search-container"
        />
        <div className="flex gap-1">
          {(["ALL", "OTW", "OFFLOADED"] as const).map((status) => (
            <Button
              key={status}
              size="sm"
              variant={statusFilter === status ? "default" : "outline"}
              onClick={() => setStatusFilter(status)}
              data-testid={"button-status-" + status.toLowerCase()}
            >
              {status === "ALL" ? "All" : status === "OTW" ? "OTW" : "Offloaded"}
            </Button>
          ))}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1" data-testid="select-supplier-filter">
              <Filter className="h-4 w-4" />
              {supplierFilter || "All Suppliers"}
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => setSupplierFilter("")}>All Suppliers</DropdownMenuItem>
            {supplierNames.map((name) => (
              <DropdownMenuItem key={name} onClick={() => setSupplierFilter(name)}>
                {name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {(searchTerm || supplierFilter || statusFilter !== "ALL") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearchTerm("");
              setSupplierFilter("");
              setStatusFilter("ALL");
            }}
          >
            <X className="h-4 w-4 mr-1" /> Clear
          </Button>
        )}
      </div>

      {isSpLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12">
          <Package className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground">
            {allSpItems.length === 0
              ? "No containers yet. Click Import Container to add one."
              : "No containers match your search."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => {
            const detailPath = c._source === "erp" ? `/containers/${c.id}?src=erp` : `/containers/${c.id}`;
            const rowIsNavigable = !c.statusCancelled;
            return (
              <div
                key={c._key}
                className={`flex flex-col gap-3 p-4 rounded-xl border border-border bg-card sm:flex-row sm:items-center sm:gap-4 ${
                  rowIsNavigable ? "hover-elevate cursor-pointer" : "opacity-75"
                }`}
                onClick={() => {
                  if (rowIsNavigable) setLocation(detailPath);
                }}
                data-testid={`row-sp-container-${c.id}`}
              >
                <div className="flex flex-1 min-w-0 items-center gap-3">
                  <div className="shrink-0 w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Package className="h-5 w-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm font-mono">{c.displayName}</span>
                      <Badge
                        variant="outline"
                        className={
                          c.statusCancelled
                            ? "text-muted-foreground border-muted-foreground/40"
                            : c.statusOffloaded
                              ? "text-green-600 border-green-600/40"
                              : "text-blue-600 border-blue-600/40"
                        }
                      >
                        {c.statusLabel}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {c.supplierName}
                      {c.subName ? ` · PO ${c.subName}` : ""}
                    </p>
                  </div>
                </div>
                <div className="text-left sm:text-right">
                  <p className="text-xs text-muted-foreground">{c.dateLabel}</p>
                  <p className="text-sm font-mono">{formatDisplayDate(c.date)}</p>
                </div>
                <div className="text-left sm:text-right">
                  <p className="text-xs text-muted-foreground">Total (USD)</p>
                  <p className="text-sm font-mono font-semibold">
                    ${c.totalUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                </div>
                {canCancel && c._source === "sp" && c.status === "open" && (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedContainer(c);
                      setReason("");
                    }}
                    data-testid={`button-cancel-sp-container-${c.id}`}
                  >
                    <Ban className="h-4 w-4 mr-1" />
                    Cancel
                  </Button>
                )}
                {rowIsNavigable && (
                  <Link href={detailPath} onClick={(event) => event.stopPropagation()}>
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`button-view-sp-${c.id}`}
                      data-remote-control-safe="true"
                      data-remote-control-action="view-container"
                    >
                      <Eye className="h-4 w-4 mr-1" />
                      View PO
                    </Button>
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={!!selectedContainer}
        onOpenChange={(open) => {
          if (!open && !cancelContainer.isPending) {
            setSelectedContainer(null);
            setReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Supplier Partner container</DialogTitle>
            <DialogDescription>
              Only an open container with no offload, stock movement, or used prepaid charge can be cancelled. The Goods
              OTW voucher is reversed and unused prepaid charges are detached rather than deleted.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p className="font-medium">{selectedContainer?.displayName}</p>
              <p className="text-muted-foreground">{selectedContainer?.supplierName}</p>
            </div>
            <label className="text-sm font-medium" htmlFor="sp-container-cancellation-reason">
              Required reason
            </label>
            <textarea
              id="sp-container-cancellation-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={4}
              maxLength={500}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="Explain why the open container is being cancelled…"
              data-testid="input-sp-container-cancellation-reason"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setSelectedContainer(null)} disabled={cancelContainer.isPending}>
                Keep container
              </Button>
              <Button
                variant="destructive"
                onClick={() => cancelContainer.mutate()}
                disabled={reason.trim().length < 5 || cancelContainer.isPending}
                data-testid="confirm-cancel-sp-container"
              >
                {cancelContainer.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Cancel container
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
