import { useState, useRef, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, Download, FileSpreadsheet, AlertCircle, CheckCircle2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { factoryApiRequest } from "@/lib/factoryApi";
import type { FactorySupplier } from "@shared/schema";
import { useCompany } from "@/contexts/CompanyContext";
import { usePaginatedFilterState } from "@/hooks/use-paginated-filter-state";

import {
  type ContainerWithSupplier,
  STATUS_ACTIVE,
  otwNum,
  otwContainerByCurrency,
  otwMergeCurrencyMaps,
} from "./factory-containers/otwHelpers";
import { ContainerStatusBadge } from "./factory-containers/ContainerBadges";
import { OtwSummaryView } from "./factory-containers/OtwSummaryView";
import { ContainerListView } from "./factory-containers/ContainerListView";
import { ContainerFormDialog } from "./factory-containers/ContainerFormDialog";
import { ContainerDetailDialog } from "./factory-containers/ContainerDetailDialog";
import { PostOffloadDialog } from "./factory-containers/PostOffloadDialog";
import {
  BulkDeleteDialog,
  SingleDeleteDialog,
  ReverseOffloadDialog,
  downloadContainerTemplate,
} from "./factory-containers/ContainerDialogs";
import type { AuthMe, FactoryMyAccess, ApiListRow } from "@shared/apiTypes";

export default function FactoryContainers() {
  const { selectedCompany } = useCompany();
  const [viewMode, setViewMode] = useState<"list" | "summary">("summary");
  const [_trackingNowId, _setTrackingNowId] = useState<number | null>(null);
  const [openOtwGroups, setOpenOtwGroups] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [editingContainer, setEditingContainer] = useState<ContainerWithSupplier | null>(null);
  const [expandedSuppliers, setExpandedSuppliers] = useState<Set<string>>(new Set(["__all__"]));
  const [viewContainer, setViewContainer] = useState<ContainerWithSupplier | null>(null);
  const {
    filters: { searchQuery, statusFilter },
    setFilter,
    resetFilters,
    hasActiveFilters,
  } = usePaginatedFilterState<{ searchQuery: string; statusFilter: string }>({
    createInitialFilters: () => ({ searchQuery: "", statusFilter: "all" }),
    storageKey: selectedCompany?.id ? `erp-factory-containers-filters-v1:${selectedCompany.id}` : undefined,
  });
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [importOpen, setImportOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<any[]>([]);
  const [importResult, setImportResult] = useState<{ imported: number; errors: string[]; total: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [reversingContainer, setReversingContainer] = useState<ContainerWithSupplier | null>(null);
  const [postOffloadContainer, setPostOffloadContainer] = useState<ContainerWithSupplier | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const { data: containers, isLoading } = useQuery<ContainerWithSupplier[]>({ queryKey: ["/api/factory/containers"] });
  const { data: suppliers } = useQuery<FactorySupplier[]>({ queryKey: ["/api/factory/suppliers"] });
  const { data: ledgerAccounts = [] } = useQuery<ApiListRow[]>({
    queryKey: ["/api/ledger-accounts?includeHidden=true"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // ── OTW Summary computed values ──────────────────────────────────────────
  const otwContainers = useMemo(() => (containers || []).filter((c) => STATUS_ACTIVE.has(c.status)), [containers]);

  const otwSupplierGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        supplierId: number | null;
        supplierName: string;
        containers: ContainerWithSupplier[];
        totalKg: number;
        totalsByCurrency: Record<string, number>;
      }
    >();
    for (const c of otwContainers) {
      const key = String(c.supplierId ?? "none");
      if (!map.has(key)) {
        map.set(key, {
          supplierId: c.supplierId ?? null,
          supplierName: c.supplierName || "No Supplier",
          containers: [],
          totalKg: 0,
          totalsByCurrency: {},
        });
      }
      const group = map.get(key)!;
      group.containers.push(c);
      group.totalKg += otwNum(c.totalKg);
      otwMergeCurrencyMaps(group.totalsByCurrency, otwContainerByCurrency(c));
    }
    return Array.from(map.values()).sort((a, b) => a.supplierName.localeCompare(b.supplierName));
  }, [otwContainers]);

  const otwGrandTotals = useMemo(() => {
    const totalsByCurrency: Record<string, number> = {};
    let count = 0;
    let kg = 0;
    for (const g of otwSupplierGroups) {
      count += g.containers.length;
      kg += g.totalKg;
      otwMergeCurrencyMaps(totalsByCurrency, g.totalsByCurrency);
    }
    return { containers: count, kg, totalsByCurrency };
  }, [otwSupplierGroups]);

  const fmtOtwKg = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const toggleOtwGroup = (key: string) => {
    setOpenOtwGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ── Import ────────────────────────────────────────────────────────────────
  const importMutation = useMutation({
    mutationFn: async (rows: any[]) => {
      const res = await factoryApiRequest("POST", "/api/factory/containers/import-excel", { rows });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Import failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      setImportResult(data);
      toast({
        title: "Import Complete",
        description: `${data.imported} of ${data.total} containers imported${data.errors.length > 0 ? ` (${data.errors.length} errors)` : ""}`,
      });
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Import Failed", description: err.message, variant: "destructive" });
    },
  });

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const XLSX = await import("@/lib/excelHelper");
    const data = await file.arrayBuffer();
    const wb = await XLSX.read(data, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const jsonRows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    const get = (row: any, keys: string[]) => {
      for (const k of keys) {
        const val = row[k] ?? row[k.toLowerCase()] ?? row[k.toUpperCase()];
        if (val !== undefined && val !== "") return String(val).trim();
      }
      return "";
    };
    const mapped = jsonRows
      .map((row) => ({
        containerNumber: get(row, ["Container Number", "Container #", "ContainerNumber", "container_number"]),
        supplierName: get(row, ["Supplier", "Supplier Name", "SupplierName"]),
        origin: get(row, ["Origin", "Country"]),
        totalKg: get(row, ["Total Kg", "TotalKg", "Weight", "KG", "Kg"]),
        ratePerKg: get(row, ["Rate/Kg", "Rate Per Kg", "RatePerKg", "Rate", "Price"]),
        currencyCode: get(row, ["Currency", "CurrencyCode"]) || "USD",
        fxRateToUsd: get(row, ["FX Rate", "FxRate", "fx_rate_to_usd"]) || "",
        fxSource: get(row, ["FX Source", "FxSource"]) || "",
        arrivalDate: get(row, ["Arrival Date", "ArrivalDate", "Date"]),
        notes: get(row, ["Notes", "Remarks"]),
        status: get(row, ["Status"]) || "PENDING",
        commissionAmount: get(row, ["Commission Amount", "CommissionAmount", "Commission"]) || "",
        commissionCurrencyCode: get(row, ["Commission Currency", "CommissionCurrency"]) || "USD",
      }))
      .filter((r) => r.containerNumber);
    setImportPreview(mapped);
    setImportResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const filteredContainers = containers?.filter((c) => {
    if (statusFilter === "HAS_WEIGHT") {
      if (!(parseFloat((c as { totalKg: string }).totalKg) > 0)) return false;
    } else if (statusFilter === "NO_WEIGHT") {
      if (parseFloat((c as { totalKg: string }).totalKg) > 0) return false;
    } else if (statusFilter !== "all" && c.status !== statusFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      if (
        !c.containerNumber?.toLowerCase().includes(q) &&
        !c.supplierName?.toLowerCase().includes(q) &&
        !c.origin?.toLowerCase().includes(q)
      )
        return false;
    }
    return true;
  });

  const openEdit = (c: ContainerWithSupplier) => {
    setEditingContainer(c);
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <PageHeader
            title="Factory Containers"
            subtitle="Track incoming containers (separate from ERP containers)"
            backTarget="/factory/production-report"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          {selectedIds.size > 0 && (
            <Button variant="destructive" onClick={() => setBulkDeleteOpen(true)} data-testid="button-delete-selected">
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Selected ({selectedIds.size})
            </Button>
          )}
          {viewMode === "summary" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setViewMode("list")}
              data-testid="button-view-list"
              className="gap-2"
            >
              <AlertCircle className="h-4 w-4" /> All Containers
            </Button>
          )}
          <Button
            onClick={() => navigate("/factory/containers/new")}
            data-testid="button-add-factory-container"
            className="gap-2 shadow-sm"
          >
            <Plus className="h-4 w-4" /> Add Container
          </Button>
        </div>
      </div>

      {viewMode === "summary" && (
        <OtwSummaryView
          otwContainers={otwContainers}
          otwSupplierGroups={otwSupplierGroups}
          otwGrandTotals={otwGrandTotals}
          openOtwGroups={openOtwGroups}
          toggleOtwGroup={toggleOtwGroup}
          fmtOtwKg={fmtOtwKg}
          onViewContainer={setViewContainer}
        />
      )}

      {viewMode === "list" && (
        <ContainerListView
          containers={containers}
          filteredContainers={filteredContainers}
          suppliers={suppliers}
          searchQuery={searchQuery}
          setSearchQuery={(next) => setFilter("searchQuery", next)}
          statusFilter={statusFilter}
          setStatusFilter={(next) => setFilter("statusFilter", next)}
          hasActiveFilters={hasActiveFilters}
          onResetFilters={resetFilters}
          expandedSuppliers={expandedSuppliers}
          setExpandedSuppliers={setExpandedSuppliers}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          onView={setViewContainer}
          onEdit={openEdit}
          onDelete={setPendingDeleteId}
          onPostOffload={setPostOffloadContainer}
          onReverseOffload={setReversingContainer}
          onNavigateOffload={() => navigate("/factory/raw-stock")}
        />
      )}

      {/* ── Dialogs ───────────────────────────────────────────────────────── */}
      <ContainerFormDialog
        open={createOpen || !!editingContainer}
        editingContainer={editingContainer}
        suppliers={suppliers}
        ledgerAccounts={ledgerAccounts}
        onClose={() => {
          setCreateOpen(false);
          setEditingContainer(null);
        }}
      />

      <ContainerDetailDialog
        container={viewContainer}
        suppliers={suppliers}
        ledgerAccounts={ledgerAccounts}
        onClose={() => setViewContainer(null)}
        onEdit={(c) => {
          setViewContainer(null);
          openEdit(c);
        }}
      />

      <PostOffloadDialog
        container={postOffloadContainer}
        ledgerAccounts={ledgerAccounts}
        onClose={() => setPostOffloadContainer(null)}
      />

      <BulkDeleteDialog
        open={bulkDeleteOpen}
        selectedIds={selectedIds}
        onClose={() => setBulkDeleteOpen(false)}
        onDeleted={() => setSelectedIds(new Set())}
      />

      <SingleDeleteDialog containerId={pendingDeleteId} onClose={() => setPendingDeleteId(null)} />

      <ReverseOffloadDialog container={reversingContainer} onClose={() => setReversingContainer(null)} />

      {/* ── Import Dialog ─────────────────────────────────────────────────── */}
      <Dialog
        open={importOpen}
        onOpenChange={(v) => {
          if (!v) {
            setImportOpen(false);
            setImportPreview([]);
            setImportResult(null);
          }
        }}
      >
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5" />
              Import Containers from Excel
            </DialogTitle>
            <DialogDescription>
              Upload an Excel file (.xlsx) to bulk-import containers. New suppliers will be created automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                onClick={downloadContainerTemplate}
                data-testid="button-download-template"
              >
                <Download className="h-4 w-4 mr-2" /> Download Template
              </Button>
              <div className="text-sm text-muted-foreground">
                Expected columns: Container Number, Supplier, Origin, Total Kg, Rate/Kg, Currency, FX Rate (optional),
                FX Source, Arrival Date, Status, Notes
              </div>
            </div>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx"
                onChange={handleFileSelect}
                className="block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-primary file:text-primary-foreground cursor-pointer"
                data-testid="input-import-file"
              />
            </div>
            {importPreview.length > 0 && !importResult && (
              <div className="space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <p className="text-sm font-medium">{importPreview.length} rows ready to import</p>
                  <Button
                    onClick={() => importMutation.mutate(importPreview)}
                    disabled={importMutation.isPending}
                    data-testid="button-confirm-import"
                  >
                    {importMutation.isPending ? "Importing..." : `Import ${importPreview.length} Containers`}
                  </Button>
                </div>
                <div className="border rounded-md overflow-auto max-h-64">
                  <Table>
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>#</TableHead>
                        <TableHead>Container #</TableHead>
                        <TableHead>Supplier</TableHead>
                        <TableHead>Origin</TableHead>
                        <TableHead className="text-right">Kg</TableHead>
                        <TableHead className="text-right">Rate/Kg</TableHead>
                        <TableHead>Currency</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {importPreview.map((row, i) => (
                        <TableRow key={i} data-testid={`row-import-preview-${i}`}>
                          <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                          <TableCell className="font-mono font-medium">{row.containerNumber}</TableCell>
                          <TableCell>{row.supplierName || "-"}</TableCell>
                          <TableCell>{row.origin || "-"}</TableCell>
                          <TableCell className="text-right font-mono">{row.totalKg || "-"}</TableCell>
                          <TableCell className="text-right font-mono">{row.ratePerKg || "-"}</TableCell>
                          <TableCell>{row.currencyCode}</TableCell>
                          <TableCell>
                            <ContainerStatusBadge status={row.status} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
            {importResult && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  <p className="font-medium">
                    {importResult.imported} of {importResult.total} containers imported successfully
                  </p>
                </div>
                {importResult.errors.length > 0 && (
                  <div className="border border-destructive/30 rounded-md p-3 space-y-1">
                    <p className="text-sm font-medium flex items-center gap-1">
                      <AlertCircle className="h-4 w-4 text-destructive" />
                      {importResult.errors.length} error(s):
                    </p>
                    {importResult.errors.map((err, i) => (
                      <p key={i} className="text-sm text-muted-foreground">
                        {err}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setImportOpen(false);
                setImportPreview([]);
                setImportResult(null);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
