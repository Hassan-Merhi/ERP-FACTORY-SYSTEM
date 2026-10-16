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
import { Plus, Package, Eye, Search, X, Ban, Loader2, Truck, Check, Download, ChevronDown, Filter } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { utils, writeFile } from "@/lib/excelHelper";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { spContainerInvoiceChargeLines } from "@shared/spContainerInvoiceCharges";
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
  const { formatAmount } = useCurrencyContext();
  const queryClient = useQueryClient();
  const [selectedContainer, setSelectedContainer] = useState<SpContainerRowView | null>(null);
  const [reason, setReason] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "OTW" | "OFFLOADED">("ALL");
  const [supplierFilter, setSupplierFilter] = useState("");

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
      subName: c.containerNumber && c.invoiceNumber ? c.invoiceNumber : null,
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

  // Keep native Supplier Partner and ERP-imported containers in one ERP-style list.
  const allSpItems = [...spNative, ...erpNormalized];
  const visibleContainers = allSpItems.filter((c) => !c.statusCancelled);
  const otwContainers = visibleContainers.filter((c) => !c.statusOffloaded);
  const offloadedContainers = visibleContainers.filter((c) => c.statusOffloaded);
  const totalValue = visibleContainers.reduce((sum, c) => sum + c.totalUsd, 0);
  const supplierNames = Array.from(new Set(allSpItems.map((c) => c.supplierName).filter(Boolean))).sort();
  const filtered = allSpItems.filter((c) =>
    searchAny(searchTerm, c.displayName, c.subName, c.supplierName) &&
    (statusFilter === "ALL" || (statusFilter === "OTW" ? !c.statusOffloaded && !c.statusCancelled : c.statusOffloaded)) &&
    (!supplierFilter || c.supplierName === supplierFilter)
  );

  const exportContainers = async (full: boolean) => {
    try {
      const summary = filtered.map((c) => ({
        "Container Number": c.subName || c.displayName,
        "Invoice / PO": c._source === "sp" ? c.displayName : "",
        Supplier: c.supplierName,
        Status: c.statusLabel,
        "Import / Invoice Date": formatDisplayDate(c.date),
        "Total (USD)": c.totalUsd,
        Source: c._source === "sp" ? "Supplier Partner" : "ERP",
      }));
      const book = utils.book_new();
      utils.book_append_sheet(book, utils.json_to_sheet(summary), "Containers");
      if (full) {
        const detailRows: Record<string, string | number>[] = [];
        for (const c of filtered) {
          if (c._source === "sp") {
            const native = spContainersList.find((item) => item.id === c.id);
            if (!native) continue;
            const factor = 1 - parseFloat(native.discountPct ?? "0") / 100;
            for (const line of native.lines ?? []) {
              const quantity = parseFloat(line.qty ?? "0");
              const rate = parseFloat(line.unitRateUsd ?? "0") * factor;
              detailRows.push({
                Container: native.containerNumber || "", Invoice: native.invoiceNumber || "",
                Supplier: native.supplierName || "", "Item Name": line.description || line.articleCode,
                Quantity: quantity, "Rate (USD)": rate, "Total (USD)": quantity * rate,
              });
            }
            for (const charge of spContainerInvoiceChargeLines(native)) {
              detailRows.push({
                Container: native.containerNumber || "", Invoice: native.invoiceNumber || "",
                Supplier: native.supplierName || "", "Item Name": charge.description,
                Quantity: 1, "Rate (USD)": charge.amountUsd, "Total (USD)": charge.amountUsd,
              });
            }
            detailRows.push({
              Container: native.containerNumber || "", Invoice: native.invoiceNumber || "",
              Supplier: native.supplierName || "", "Item Name": "Recorded Invoice Total",
              Quantity: Number(native.totalQty || 0), "Rate (USD)": 0,
              "Total (USD)": Number(native.invoiceTotalUsd || 0),
            });
          } else {
            const response = await fetch("/api/containers/" + c.id, { credentials: "include" });
            if (!response.ok) throw new Error("Cannot export ERP container " + c.displayName);
            const detail = await response.json() as {
              pos?: { items?: { itemName?: string; quantity?: string; rate?: string; total?: string }[] }[];
            };
            for (const po of detail.pos ?? []) {
              for (const item of po.items ?? []) {
                detailRows.push({
                  Container: c.displayName, Invoice: "",
                  Supplier: c.supplierName, "Item Name": item.itemName || "",
                  Quantity: Number(item.quantity || 0), "Rate (USD)": Number(item.rate || 0),
                  "Total (USD)": Number(item.lineTotal || 0),
                });
              }
            }
          }
        }
        utils.book_append_sheet(book, utils.json_to_sheet(detailRows.length ? detailRows : [{ Message: "No line items" }]), "Line Items");
      }
      await writeFile(book, full ? "containers_full_export.xlsx" : "containers.xlsx");
    } catch (error) {
      toast({ title: "Export failed", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader title="Container Tracking" subtitle="Track containers and manage offloading">
        <div className="flex flex-wrap gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2" data-testid="button-export-dropdown">
                <Download className="h-4 w-4" /> Export <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => void exportContainers(false)} data-testid="button-export-excel">Export</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void exportContainers(true)} data-testid="button-export-all-full">Export All (Full)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button className="gap-2" onClick={() => setLocation("/po-import")} data-testid="button-add-container">
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
      </PageHeader>
      <div className="flex flex-wrap gap-3" data-testid="sp-container-summary">
        <div className="rounded-lg bg-muted/60 px-3 py-2 flex items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          <strong className="text-sm">{visibleContainers.length}</strong><span className="text-xs text-muted-foreground">Containers</span>
        </div>
        <div className="rounded-lg bg-blue-500/10 px-3 py-2 flex items-center gap-2">
          <Truck className="h-4 w-4 text-blue-600" /><strong className="text-sm">{otwContainers.length}</strong>
          <span className="text-xs text-muted-foreground">OTW</span>
        </div>
        <div className="rounded-lg bg-green-500/10 px-3 py-2 flex items-center gap-2">
          <Check className="h-4 w-4 text-green-600" /><strong className="text-sm">{offloadedContainers.length}</strong>
          <span className="text-xs text-muted-foreground">Offloaded</span>
        </div>
        <div className="rounded-lg bg-primary/10 px-3 py-2 flex items-center gap-2">
          <strong className="text-sm tabular-nums">{formatAmount(totalValue)}</strong>
          <span className="text-xs text-muted-foreground">total value</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by container number, invoice, supplier..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
            data-testid="input-search-container"
          />
        </div>
        <div className="flex gap-1">
          {(["ALL", "OTW", "OFFLOADED"] as const).map((status) => (
            <Button key={status} size="sm" variant={statusFilter === status ? "default" : "outline"}
              onClick={() => setStatusFilter(status)} data-testid={"button-status-" + status.toLowerCase()}>
              {status === "ALL" ? "All" : status === "OTW" ? "OTW" : "Offloaded"}
            </Button>
          ))}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1" data-testid="select-supplier-filter">
              <Filter className="h-4 w-4" />{supplierFilter || "All Suppliers"}<ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => setSupplierFilter("")}>All Suppliers</DropdownMenuItem>
            {supplierNames.map((name) => (
              <DropdownMenuItem key={name} onClick={() => setSupplierFilter(name)}>{name}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {(searchTerm || supplierFilter || statusFilter !== "ALL") && (
          <Button variant="ghost" size="sm" onClick={() => { setSearchTerm(""); setSupplierFilter(""); setStatusFilter("ALL"); }}>
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
