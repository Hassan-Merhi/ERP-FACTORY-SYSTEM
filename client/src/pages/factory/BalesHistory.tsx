import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import { addDays, format } from "date-fns";
import {
  Printer,
  Trash2,
  Search,
  Package,
  CheckSquare,
  RefreshCw,
  Pencil,
  Check,
  X,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Undo2,
  Lock,
  XCircle,
  ShieldAlert,
  FileSpreadsheet,
  Upload,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { queryClient } from "@/lib/queryClient";
import { LabelPrintSettings } from "@/components/LabelPrintSettings";
import { formatLabelNum } from "@/lib/labelHtml";
import { BaleWeightEditDialog } from "@/components/BaleWeightEditDialog";
import { BALE_STATUS_COLORS } from "./baleshistory/pagePolicies";
import { useBalesHistoryModel } from "./baleshistory/useBalesHistoryModel";
import { BalesHistoryOverview } from "./baleshistory/components/BalesHistoryOverview";
import { BalesHistoryDialog1 } from "./baleshistory/components/BalesHistoryDialog1";
import { BalesHistoryDialog2 } from "./baleshistory/components/BalesHistoryDialog2";
import { BalesHistoryDialog3 } from "./baleshistory/components/BalesHistoryDialog3";
import { BalesHistoryDialog4 } from "./baleshistory/components/BalesHistoryDialog4";
import { BalesHistoryDialog5 } from "./baleshistory/components/BalesHistoryDialog5";
import { useToast } from "@/hooks/use-toast";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import type { RouteComponentProps } from "wouter";

/** Routed standalone (receives route props) or embedded as a hub tab panel. */
type EmbeddablePageProps = { embedded?: boolean } & Partial<RouteComponentProps>;

/** `embedded`: rendered as the Bales hub "History" tab, whose PageHeader already titles the page. */
export default function BalesHistory({ embedded = false }: EmbeddablePageProps) {
  const mhd = useFactoryMhdView();
  const model = useBalesHistoryModel();
  const { toast } = useToast();
  const downloadExport = async (url: string, fileName: string) => {
    try {
      await downloadFromUrl(url, { fileName });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };
  const {
    wrapAdminAction,
    AdminDialog,
    searchTerm,
    setSearchTerm,
    statusFilter,
    setStatusFilter,
    dateFilter,
    setDateFilter,
    currentPage,
    setCurrentPage,
    setDeleteConfirm,
    selectedIds,
    setSelectedIds,
    bulkStatus,
    setBulkStatus,
    editingNameId,
    setEditingNameId,
    editingNameValue,
    setEditingNameValue,
    setRepackConfirm,
    setReturnToStockBale,
    expandedGroups,
    nameInputRef,
    reimportFileRef,
    namesFileRef,
    removeDialogOpen,
    setRemoveDialogOpen,
    supervisorUsername,
    setSupervisorUsername,
    supervisorPassword,
    setSupervisorPassword,
    removalReason,
    setRemovalReason,
    authError,
    setAuthError,
    importingNames,
    setImportingNames,
    reimporting,
    setReimporting,
    weightEditBale,
    setWeightEditBale,
    myAccess,
    isLoading,
    balesData,
    serverTotalPages,
    serverTotal,
    updateStatus,
    bulkUpdateStatus,
    removeMutation,
    bulkUpdateNamesMutation,
    reimportMutation,
    startEditName,
    saveEditName,
    toggleSelect,
    toggleSelectAll,
    handleReprint,
    filtered,
    groupedFiltered,
    toggleGroup,
    canChangeExistingRecords,
  } = model;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const inStockSelectedCount = Array.from(selectedIds).filter((id) =>
    (balesData || []).some((r) => r.bale.id === id && r.bale.status === "IN_STOCK")
  ).length;

  return (
    <div className="bales-history-modern">
      {!embedded && (
        <PageHeader
          title="Bales"
          subtitle="Stock history, status management and removal"
          icon={<Package className="h-5 w-5" />}
        />
      )}
      <BalesHistoryOverview model={model} />

      {/* ── Main table card ── */}
      <div className="bales-modern-table-card">
        {/* Toolbar */}
        <div className="bales-modern-toolbar">
          <div className="bales-modern-search relative flex-1 min-w-[180px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search by ref #, code, product, batch..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8 h-8 text-sm"
              data-testid="input-bales-search"
            />
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              onClick={() =>
                setDateFilter((prev) => (prev ? format(addDays(new Date(prev + "T00:00:00"), -1), "yyyy-MM-dd") : prev))
              }
              disabled={!dateFilter}
              data-testid="button-prev-date"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Input
              type="date"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="bales-modern-date-input w-[140px] h-8 text-sm"
              data-testid="input-date-filter"
            />
            <Button
              size="icon"
              variant="ghost"
              onClick={() =>
                setDateFilter((prev) => (prev ? format(addDays(new Date(prev + "T00:00:00"), 1), "yyyy-MM-dd") : prev))
              }
              disabled={!dateFilter}
              data-testid="button-next-date"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            {dateFilter && (
              <Button variant="ghost" size="sm" onClick={() => setDateFilter("")} data-testid="button-clear-date">
                Clear
              </Button>
            )}
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[150px] h-8 text-sm" data-testid="select-status-filter">
              <SelectValue placeholder="All Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="PENDING_PRESSING">Pending Pressing</SelectItem>
              <SelectItem value="LABEL_PRINTED">Label Printed</SelectItem>
              <SelectItem value="PRESSED">Pressed</SelectItem>
              <SelectItem value="FINALIZED">Finalized</SelectItem>
              <SelectItem value="IN_STOCK">In Stock</SelectItem>
              <SelectItem value="RESERVED">Reserved</SelectItem>
              <SelectItem value="SOLD">Sold</SelectItem>
              <SelectItem value="REPACKED">Repacked</SelectItem>
            </SelectContent>
          </Select>
          <LabelPrintSettings />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-tools-menu">
                Tools
                <ChevronDown className="h-3.5 w-3.5 ml-1.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Export / Import</DropdownMenuLabel>
              <DropdownMenuItem
                onClick={() => {
                  const exportDate = dateFilter || new Date().toLocaleDateString("en-CA");
                  void downloadExport(
                    `/api/factory/bales/export-full.xlsx?date=${exportDate}`,
                    exportFileName("bales", "xlsx", { date: exportDate })
                  );
                }}
                data-testid="button-export-bales-full"
              >
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                Export Excel (Bales, {dateFilter || "Today"})
              </DropdownMenuItem>
              {canChangeExistingRecords && (
                <DropdownMenuItem
                  onClick={() => reimportFileRef.current?.click()}
                  disabled={reimportMutation.isPending || reimporting}
                  data-testid="button-reimport-bales"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  {reimportMutation.isPending ? "Reimporting..." : "Reimport Bales"}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() =>
                  void downloadExport("/api/factory/bales/export-names.xlsx", exportFileName("bale names", "xlsx"))
                }
                data-testid="button-export-bale-names"
              >
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                Export Excel (Names)
              </DropdownMenuItem>
              {canChangeExistingRecords && (
                <DropdownMenuItem
                  onClick={() => namesFileRef.current?.click()}
                  disabled={bulkUpdateNamesMutation.isPending || importingNames}
                  data-testid="button-import-bale-names"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  {bulkUpdateNamesMutation.isPending ? "Importing..." : "Import Names"}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={reimportFileRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                setReimporting(true);
                reimportMutation.mutate(file);
                e.target.value = "";
              }
            }}
            data-testid="input-reimport-bales"
          />
          <input
            ref={namesFileRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                setImportingNames(true);
                bulkUpdateNamesMutation.mutate(file);
                e.target.value = "";
              }
            }}
            data-testid="input-import-bale-names"
          />
        </div>

        {/* Selection action bar */}
        {selectedIds.size > 0 && (
          <div className="bales-modern-selection flex items-center gap-3 px-3 py-2 flex-wrap">
            <CheckSquare className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium">{selectedIds.size} selected</span>
            {canChangeExistingRecords && (
              <>
                <Select value={bulkStatus} onValueChange={setBulkStatus}>
                  <SelectTrigger className="w-[170px] h-7 text-xs" data-testid="select-bulk-status">
                    <SelectValue placeholder="Change status to..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PENDING_PRESSING">Pending Pressing</SelectItem>
                    <SelectItem value="LABEL_PRINTED">Label Printed</SelectItem>
                    <SelectItem value="PRESSED">Pressed</SelectItem>
                    <SelectItem value="FINALIZED">Finalized</SelectItem>
                    <SelectItem value="IN_STOCK">In Stock</SelectItem>
                    <SelectItem value="RESERVED">Reserved</SelectItem>
                    <SelectItem value="SOLD">Sold</SelectItem>
                    <SelectItem value="REPACKED">Repacked</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  disabled={!bulkStatus || bulkUpdateStatus.isPending}
                  onClick={() =>
                    wrapAdminAction(
                      () => bulkUpdateStatus.mutate({ ids: Array.from(selectedIds), status: bulkStatus }),
                      "Bulk Update Status"
                    )
                  }
                  data-testid="button-bulk-update"
                >
                  {bulkUpdateStatus.isPending ? "Updating..." : "Apply"}
                </Button>
                {inStockSelectedCount > 0 && (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      setRemoveDialogOpen(true);
                      setSupervisorUsername("");
                      setSupervisorPassword("");
                      setRemovalReason("");
                      setAuthError("");
                    }}
                    data-testid="button-remove-bales"
                  >
                    <ShieldAlert className="h-3.5 w-3.5 mr-1.5" />
                    Remove ({inStockSelectedCount})
                  </Button>
                )}
              </>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSelectedIds(new Set());
                setBulkStatus("");
              }}
              data-testid="button-clear-selection"
            >
              Clear
            </Button>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Package className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No bales found</p>
            {searchTerm && <p className="text-xs mt-1">Try a different search term</p>}
          </div>
        ) : (
          <div>
            <Table>
              <TableHeader className="sticky top-0 z-30 border-b border-border/60">
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={filtered.length > 0 && filtered.every((r) => selectedIds.has(r.bale.id))}
                      onCheckedChange={() => toggleSelectAll(filtered)}
                      data-testid="checkbox-select-all"
                    />
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Ref #
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Product
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Article
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Qty
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Weight (kg)
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Status
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Last Printed
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mhd
                  .sortRows(groupedFiltered, (group) => group.articleCode)
                  .map((group) => {
                    const isExpanded = expandedGroups.has(group.key);
                    const allGroupSelected = group.rows.every((r) => selectedIds.has(r.bale.id));
                    const someGroupSelected = group.rows.some((r) => selectedIds.has(r.bale.id));
                    const uniqueStatuses = [...new Set(group.rows.map((r) => r.bale.status as string))];

                    return [
                      // ── Group summary row ──
                      <TableRow
                        key={`group-${group.key}`}
                        className="cursor-pointer"
                        data-testid={`row-group-${group.key}`}
                      >
                        <TableCell>
                          <Checkbox
                            checked={allGroupSelected}
                            data-state={someGroupSelected && !allGroupSelected ? "indeterminate" : undefined}
                            onCheckedChange={() => {
                              setSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (allGroupSelected) group.rows.forEach((r) => next.delete(r.bale.id));
                                else group.rows.forEach((r) => next.add(r.bale.id));
                                return next;
                              });
                            }}
                            data-testid={`checkbox-group-${group.key}`}
                          />
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground font-mono">
                          <Badge variant="outline" className="text-xs font-mono">
                            {group.rows.length} bale{group.rows.length !== 1 ? "s" : ""}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <button
                            className="flex items-center gap-1.5 text-left font-medium hover:underline"
                            onClick={() => toggleGroup(group.key)}
                            data-testid={`button-toggle-group-${group.key}`}
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                            )}
                            {mhd.nameFor(group.articleCode, group.productName)}
                          </button>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{group.articleCode}</TableCell>
                        <TableCell className="text-right font-semibold">{group.totalQty}</TableCell>
                        <TableCell className="text-right font-mono font-semibold">
                          {formatLabelNum(group.totalWeightKg)}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {uniqueStatuses.map((s) => (
                              <Badge
                                key={s}
                                variant={
                                  (BALE_STATUS_COLORS[s] || "secondary") as
                                    | "default"
                                    | "outline"
                                    | "secondary"
                                    | "destructive"
                                    | "success"
                                    | "warning"
                                    | "info"
                                    | "muted"
                                    | null
                                    | undefined
                                }
                                className="text-xs"
                              >
                                {s.replace(/_/g, " ")}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell />
                        <TableCell />
                      </TableRow>,

                      // ── Expanded individual bale rows ──
                      ...(isExpanded
                        ? group.rows.map((row) => {
                            const bale = row.bale;
                            const product = row.product;
                            return (
                              <TableRow key={bale.id} className="bg-background" data-testid={`row-bale-${bale.id}`}>
                                <TableCell className="pl-6">
                                  <Checkbox
                                    checked={selectedIds.has(bale.id)}
                                    onCheckedChange={() => toggleSelect(bale.id)}
                                    data-testid={`checkbox-bale-${bale.id}`}
                                  />
                                </TableCell>
                                <TableCell className="font-mono text-xs pl-6">
                                  {bale.referenceNumber || bale.baleCode || "-"}
                                </TableCell>
                                <TableCell className="pl-8">
                                  {editingNameId === bale.id ? (
                                    <div className="flex items-center gap-1">
                                      <Input
                                        ref={nameInputRef}
                                        value={editingNameValue}
                                        onChange={(e) => setEditingNameValue(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") saveEditName(bale.id);
                                          if (e.key === "Escape") setEditingNameId(null);
                                        }}
                                        className="h-7 text-xs w-[160px]"
                                        data-testid={`input-edit-name-${bale.id}`}
                                      />
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        onClick={() => saveEditName(bale.id)}
                                        data-testid={`button-save-name-${bale.id}`}
                                      >
                                        <Check className="h-3 w-3" />
                                      </Button>
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        onClick={() => setEditingNameId(null)}
                                        data-testid={`button-cancel-name-${bale.id}`}
                                      >
                                        <X className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  ) : (
                                    <div
                                      className="flex items-center gap-1 group cursor-pointer text-sm text-muted-foreground"
                                      onClick={() => {
                                        if (canChangeExistingRecords)
                                          startEditName(bale.id, product?.name || bale.productName || "");
                                      }}
                                      data-testid={`text-product-name-${bale.id}`}
                                    >
                                      <span>
                                        {mhd.nameFor(
                                          product?.articleCode || "",
                                          product?.name || bale.productName || "-"
                                        )}
                                      </span>
                                      {canChangeExistingRecords && (
                                        <Pencil className="h-3 w-3 text-muted-foreground visible md:invisible md:group-hover:visible touch:visible" />
                                      )}
                                    </div>
                                  )}
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {product?.articleCode || bale.category || "-"}
                                </TableCell>
                                <TableCell className="text-right">{bale.quantity}</TableCell>
                                <TableCell className="text-right font-mono">
                                  <button
                                    className="group flex items-center gap-1 ml-auto hover:text-foreground"
                                    disabled={!canChangeExistingRecords}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setWeightEditBale({
                                        id: bale.id,
                                        referenceNumber: bale.referenceNumber,
                                        weightKg: bale.weightKg,
                                      });
                                    }}
                                    title={canChangeExistingRecords ? "Correct weight" : undefined}
                                  >
                                    {formatLabelNum(bale.weightKg)}
                                    {canChangeExistingRecords && (
                                      <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60 shrink-0" />
                                    )}
                                  </button>
                                </TableCell>
                                <TableCell>
                                  <Select
                                    value={bale.status}
                                    disabled={!canChangeExistingRecords}
                                    onValueChange={(val) =>
                                      wrapAdminAction(
                                        () => updateStatus.mutate({ id: bale.id, status: val }),
                                        "Update Bale Status"
                                      )
                                    }
                                  >
                                    <SelectTrigger
                                      className="w-[140px] h-8 text-xs"
                                      data-testid={`select-status-${bale.id}`}
                                    >
                                      <Badge
                                        variant={
                                          (BALE_STATUS_COLORS[bale.status] || "secondary") as
                                            | "default"
                                            | "outline"
                                            | "secondary"
                                            | "destructive"
                                            | "success"
                                            | "warning"
                                            | "info"
                                            | "muted"
                                            | null
                                            | undefined
                                        }
                                        className="text-xs"
                                      >
                                        {bale.status.replace(/_/g, " ")}
                                      </Badge>
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="PENDING_PRESSING">Pending Pressing</SelectItem>
                                      <SelectItem value="LABEL_PRINTED">Label Printed</SelectItem>
                                      <SelectItem value="PRESSED">Pressed</SelectItem>
                                      <SelectItem value="FINALIZED">Finalized</SelectItem>
                                      <SelectItem value="IN_STOCK">In Stock</SelectItem>
                                      <SelectItem value="RESERVED">Reserved</SelectItem>
                                      <SelectItem value="SOLD">Sold</SelectItem>
                                      <SelectItem value="REPACKED">Repacked</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </TableCell>
                                <TableCell
                                  className="text-xs text-muted-foreground"
                                  data-testid={`text-last-printed-${bale.id}`}
                                >
                                  {row.lastPrintedAt ? new Date(row.lastPrintedAt).toLocaleString() : "Never"}
                                </TableCell>
                                <TableCell className="text-right">
                                  <div className="flex items-center justify-end gap-1">
                                    {canChangeExistingRecords &&
                                      (bale.status === "RESERVED_FOR_ORDER" ||
                                        bale.status === "RESERVED" ||
                                        bale.status === "SOLD") && (
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          onClick={() => setReturnToStockBale(row)}
                                          title="Return bale to stock"
                                          data-testid={`button-return-to-stock-${bale.id}`}
                                        >
                                          <Undo2 className="h-4 w-4 text-blue-500" />
                                        </Button>
                                      )}
                                    {canChangeExistingRecords && myAccess?.fullAccess && (
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        onClick={() => setRepackConfirm(row)}
                                        disabled={bale.status === "REPACKED" || bale.status === "SOLD"}
                                        title="Repack bale"
                                        data-testid={`button-repack-${bale.id}`}
                                      >
                                        <RefreshCw className="h-4 w-4" />
                                      </Button>
                                    )}
                                    {canChangeExistingRecords && (
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        onClick={() => handleReprint(row)}
                                        data-testid={`button-reprint-${bale.id}`}
                                      >
                                        <Printer className="h-4 w-4" />
                                      </Button>
                                    )}
                                    {canChangeExistingRecords && myAccess?.fullAccess && (
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        onClick={() => setDeleteConfirm(bale.id)}
                                        data-testid={`button-delete-${bale.id}`}
                                      >
                                        <Trash2 className="h-4 w-4" />
                                      </Button>
                                    )}
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
          </div>
        )}

        {/* ── Pagination ── */}
        {serverTotalPages > 1 && (
          <div className="bales-modern-pagination flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              Page {currentPage} of {serverTotalPages} &mdash; {serverTotal.toLocaleString()} bales total
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                <ChevronLeft className="h-4 w-4" />
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage((p) => Math.min(serverTotalPages, p + 1))}
                disabled={currentPage >= serverTotalPages}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Remove from Stock Dialog ── */}
      <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5" />
              Supervisor Authorization Required
            </DialogTitle>
            <DialogDescription>
              Removing {inStockSelectedCount} IN STOCK bale(s) requires supervisor credentials. This action will be
              logged.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <p className="text-sm text-muted-foreground mb-1">Supervisor Username</p>
              <Input
                value={supervisorUsername}
                onChange={(e) => {
                  setSupervisorUsername(e.target.value);
                  setAuthError("");
                }}
                placeholder="Enter supervisor username..."
                data-testid="input-supervisor-username"
              />
            </div>
            <div>
              <p className="text-sm text-muted-foreground mb-1">Supervisor Password</p>
              <Input
                type="password"
                value={supervisorPassword}
                onChange={(e) => {
                  setSupervisorPassword(e.target.value);
                  setAuthError("");
                }}
                placeholder="Enter supervisor password..."
                data-testid="input-supervisor-password"
              />
            </div>
            <div>
              <p className="text-sm text-muted-foreground mb-1">Reason for Removal</p>
              <Input
                value={removalReason}
                onChange={(e) => setRemovalReason(e.target.value)}
                placeholder="Entered by mistake, damaged, etc..."
                data-testid="input-removal-reason"
              />
            </div>
            {authError && (
              <div className="flex items-center gap-2 text-destructive text-sm">
                <XCircle className="h-4 w-4" />
                {authError}
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRemoveDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!supervisorUsername || !supervisorPassword || removeMutation.isPending}
              onClick={() => {
                const idsToRemove = Array.from(selectedIds).filter((id) =>
                  (balesData || []).some((r) => r.bale.id === id && r.bale.status === "IN_STOCK")
                );
                removeMutation.mutate({
                  ids: idsToRemove,
                  supervisorUsername,
                  supervisorPassword,
                  reason: removalReason,
                });
              }}
              data-testid="button-confirm-remove"
            >
              {removeMutation.isPending ? "Removing..." : "Remove from Stock"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BalesHistoryDialog1 model={model} />

      <BalesHistoryDialog2 model={model} />

      <BalesHistoryDialog3 model={model} />

      {/* ── Stock Register Export Dialog ── */}
      <BalesHistoryDialog4 model={model} />
      {/* Return to Stock Dialog */}
      <BalesHistoryDialog5 model={model} />

      {AdminDialog}

      <BaleWeightEditDialog
        bale={weightEditBale}
        onClose={() => setWeightEditBale(null)}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
          setWeightEditBale(null);
        }}
      />
    </div>
  );
}
