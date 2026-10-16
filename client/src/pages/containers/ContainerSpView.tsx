import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Plus, Package, Eye, Search, X, Ban, Loader2, Truck, CheckCircle2 } from "lucide-react";
import type { Container, Supplier } from "@shared/schema";
import type { SpContainerWithLines } from "./types";

/**
 * Common display shape the SP list and the ERP (PO Import) containers are
 * normalized to. Also the shape held by the cancel-dialog selection state.
 */
interface SpContainerRowView {
  _key: string;
  id: number;
  _source: "sp" | "erp";
  displayName: string;
  subName: string | null;
  supplierName: string;
  status: string;
  statusLabel: string;
  statusOffloaded: boolean;
  statusCancelled: boolean;
  date: string;
  dateLabel: string;
  totalUsd: number;
}

interface ContainerSpViewProps {
  spContainersList: SpContainerWithLines[];
  allContainers: Container[];
  suppliers: Supplier[];
  searchTerm: string;
  setSearchTerm: (v: string) => void;
  isSpLoading: boolean;
  setLocation: (path: string) => void;
  formatDisplayDate: (date: string) => string;
}

export function ContainerSpView({
  spContainersList,
  allContainers,
  suppliers,
  searchTerm,
  setSearchTerm,
  isSpLoading,
  setLocation,
  formatDisplayDate,
}: ContainerSpViewProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedContainer, setSelectedContainer] = useState<SpContainerRowView | null>(null);
  const [reason, setReason] = useState("");

  const { data: currentUser } = useQuery<{ role?: string; currentRole?: string | null }>({
    queryKey: ["/api/auth/me"],
  });
  const role = currentUser?.currentRole ?? currentUser?.role ?? "";
  const canCancel = role === "Admin" || role === "Developer";

  const cancelContainer = useMutation({
    mutationFn: async () => {
      if (!selectedContainer) throw new Error("No container selected");
      const response = await apiRequest("POST", `/api/sp/containers/${selectedContainer.id}/cancel`, { reason });
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sp/containers"] });
      queryClient.invalidateQueries({ queryKey: [`/api/sp/containers/${selectedContainer?.id}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/sp/report/payable"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      toast({
        title: "Container cancelled",
        description: data.cancellationVoucherId
          ? `Goods OTW was reversed with voucher #${data.cancellationVoucherId}.`
          : "The open container was cancelled without deleting its history.",
      });
      setSelectedContainer(null);
      setReason("");
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Cancellation failed", description: error.message, variant: "destructive" });
    },
  });

  // Normalize sp_containers rows to a common display shape
  const spNative: SpContainerRowView[] = (Array.isArray(spContainersList) ? spContainersList : []).map((c) => {
    const statusCancelled = c.status === "cancelled";
    const statusOffloaded = c.status === "offloaded";
    return {
      _key: `sp-${c.id}`,
      id: c.id,
      _source: "sp",
      displayName: c.containerNumber || c.invoiceNumber || `#${c.id}`,
      subName: c.invoiceNumber && c.containerNumber ? c.invoiceNumber : null,
      supplierName: c.supplierName ?? "",
      status: c.status,
      statusLabel: statusCancelled ? "Cancelled" : statusOffloaded ? "Offloaded" : "Open / OTW",
      statusOffloaded,
      statusCancelled,
      date: c.invoiceDate,
      dateLabel: "Invoice Date",
      totalUsd: parseFloat(c.invoiceTotalUsd ?? "0"),
    };
  });

  // Normalize regular containers (from PO Import) to same shape
  const erpNormalized: SpContainerRowView[] = allContainers.map((c) => {
    const sup = suppliers.find((s) => s.id === c.supplierId);
    const isOffloaded = c.status === "OFFLOADED";
    return {
      _key: `erp-${c.id}`,
      id: c.id,
      _source: "erp",
      displayName: c.containerNumber,
      subName: null,
      supplierName:
        (
          sup as unknown as (
            | {
                id: number;
                code: string;
                legalName: string;
                phone: string | null;
                openingBalance: string | null;
                active: boolean;
                deletedAt: Date | null;
                createdAt: Date;
                email: string;
                address: string | null;
                taxId: string | null;
                paymentTerms: string | null;
                stockGroupId: number | null;
              }
            | undefined
          ) & { legalName: unknown }
        )?.legalName ??
        (
          sup as unknown as (
            | {
                id: number;
                code: string;
                legalName: string;
                phone: string | null;
                openingBalance: string | null;
                active: boolean;
                deletedAt: Date | null;
                createdAt: Date;
                email: string;
                address: string | null;
                taxId: string | null;
                paymentTerms: string | null;
                stockGroupId: number | null;
              }
            | undefined
          ) & { name: unknown }
        )?.name ??
        "",
      status: c.status,
      statusLabel: isOffloaded ? "Offloaded" : c.status === "OTW" ? "On The Way" : c.status,
      statusOffloaded: isOffloaded,
      statusCancelled: false,
      date: c.importDate,
      dateLabel: "Import Date",
      totalUsd: parseFloat(c.grandTotal ?? "0"),
    };
  });

  const allSpItems = [...spNative, ...erpNormalized];
  const filtered = allSpItems.filter((c) =>
    searchAny(searchTerm, c.displayName, c.subName, c.supplierName)
  );

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader title="Container Tracking" subtitle="Supplier partner containers">
        <div className="flex gap-2 flex-wrap">
          <Button className="gap-2" onClick={() => setLocation("/po-import")} data-testid="button-add-container">
            <Plus className="h-4 w-4" />
            Import Container
          </Button>
        </div>
      </PageHeader>

      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by invoice, container, supplier…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
            data-testid="input-search-container"
          />
        </div>
        {searchTerm && (
          <Button variant="ghost" size="sm" onClick={() => setSearchTerm("")} data-testid="button-clear-search">
            <X className="h-4 w-4 mr-1" />
            Clear
          </Button>
        )}
      </div>

      {!isSpLoading && allSpItems.length > 0 && (
        <div className="flex flex-wrap gap-3" data-testid="sp-container-summary">
          <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2">
            <Package className="h-4 w-4 text-muted-foreground" />
            <strong className="text-sm">{allSpItems.length.toLocaleString()}</strong>
            <span className="text-xs text-muted-foreground">Containers</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-blue-500/10 px-3 py-2">
            <Truck className="h-4 w-4 text-blue-600" />
            <strong className="text-sm">{allSpItems.filter((row) => row.status === "open" || row.status === "OTW").length}</strong>
            <span className="text-xs text-muted-foreground">OTW</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-green-500/10 px-3 py-2">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <strong className="text-sm">{allSpItems.filter((row) => row.statusOffloaded).length}</strong>
            <span className="text-xs text-muted-foreground">Offloaded</span>
          </div>
        </div>
      )}

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
                    {c.supplierName}{c.subName ? ` · PO ${c.subName}` : ""}
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
