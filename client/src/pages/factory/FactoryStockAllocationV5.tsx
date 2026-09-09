import { Fragment } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Loader2,
  RefreshCw,
  AlertTriangle,
  Plus,
  ChevronDown,
  ChevronRight,
  Container,
  CheckCircle2,
  Pencil,
  X,
  Link2,
  FileDown,
  RotateCcw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import CreateProformaV5Drawer from "./CreateProformaV5Drawer";
import EditProformaV5Drawer from "./EditProformaV5Drawer";
import { PageHeader } from "@/components/PageHeader";
import { STATUS_LABELS } from "./factorystockallocationv5/utils";
import { useFactoryStockAllocationV5Model } from "./factorystockallocationv5/useFactoryStockAllocationV5Model";
import { FactoryStockAllocationV5Dialog1 } from "./factorystockallocationv5/components/FactoryStockAllocationV5Dialog1";
import { FactoryStockAllocationV5Dialog2 } from "./factorystockallocationv5/components/FactoryStockAllocationV5Dialog2";
import { FactoryStockAllocationV5Dialog3 } from "./factorystockallocationv5/components/FactoryStockAllocationV5Dialog3";
import { FactoryStockAllocationV5Dialog4 } from "./factorystockallocationv5/components/FactoryStockAllocationV5Dialog4";
import { FactoryStockAllocationV5Dialog5 } from "./factorystockallocationv5/components/FactoryStockAllocationV5Dialog5";
import { FactoryStockAllocationV5Dialog6 } from "./factorystockallocationv5/components/FactoryStockAllocationV5Dialog6";
import { FactoryStockAllocationV5Dialog7 } from "./factorystockallocationv5/components/FactoryStockAllocationV5Dialog7";
import { FactoryStockAllocationV5Dialog8 } from "./factorystockallocationv5/components/FactoryStockAllocationV5Dialog8";

export default function FactoryStockAllocationV5() {
  const model = useFactoryStockAllocationV5Model();
  const {
    focusProformaId,
    firstMatchRef,
    createDrawerOpen,
    setCreateDrawerOpen,
    editDrawerProformaId,
    setEditDrawerProformaId,
    expandedRows,
    hideZero,
    setHideZero,
    showNegativeOnly,
    setShowNegativeOnly,
    showGarbageWipers,
    setShowGarbageWipers,
    refreshFlash,
    searchQuery,
    setSearchQuery,
    categoryFilter,
    setCategoryFilter,
    exportDialogOpen: _exportDialogOpen,
    setExportDialogOpen,
    exportIncludePositive: _exportIncludePositive,
    setExportIncludePositive: _setExportIncludePositive,
    exportIncludeNegative: _exportIncludeNegative,
    setExportIncludeNegative: _setExportIncludeNegative,
    exportIncludeZero: _exportIncludeZero,
    setExportIncludeZero: _setExportIncludeZero,
    addCtDialog: _addCtDialog,
    setAddCtDialog: _setAddCtDialog,
    ctCount: _ctCount,
    ctNames: _ctNames,
    openAddContainers,
    handleCtCountChange: _handleCtCountChange,
    handleCtNameChange: _handleCtNameChange,
    addContainersMut: _addContainersMut,
    submitAddContainers: _submitAddContainers,
    closeDialog: _closeDialog,
    setCloseDialog: _setCloseDialog,
    closeProformaMut: _closeProformaMut,
    editDraftDialog: _editDraftDialog,
    setEditDraftDialog: _setEditDraftDialog,
    editDraftQtys: _editDraftQtys,
    setEditDraftQtys: _setEditDraftQtys,
    openEditDraft,
    editDraftMut: _editDraftMut,
    submitEditDraft: _submitEditDraft,
    linkDialog: _linkDialog,
    setLinkDialog,
    linkSelected: _linkSelected,
    setLinkSelected,
    unlinkedQuery: _unlinkedQuery,
    linkMut: _linkMut,
    restoreDialogOpen: _restoreDialogOpen,
    setRestoreDialogOpen,
    cancelledContainersQuery: _cancelledContainersQuery,
    restoreContainerMut: _restoreContainerMut,
    cancelDialog: _cancelDialog,
    setCancelDialog,
    setCancelSuperUser,
    setCancelSuperPass,
    cancelContainerMut: _cancelContainerMut,
    query,
    garbageWipersCount,
    rows,
    allCategories,
    totals,
    handleRefresh,
    toggleRow,
    handleExportExcel: _handleExportExcel,
    drawerRows,
    catDropOpen,
    setCatDropOpen,
    catDropRef,
    toggleCategory,
    catLabel,
  } = model;

  /* ── Render ───────────────────────────────────────────────────────────── */
  return (
    <div className="flex h-full min-w-0 flex-col" data-testid="factory-stock-allocation-v5-page">
      {/* ── Row 1: Title + action buttons ─────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 pb-3 pt-3 sm:px-4 sm:pt-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <PageHeader title="Stock Allocation" />
          <Badge variant="secondary" className="text-[11px] font-semibold tracking-wide">
            v5
          </Badge>
          {totals && totals.shortageCount > 0 && (
            <Badge variant="destructive" className="text-[11px] gap-1">
              <AlertTriangle className="h-3 w-3" />
              {totals.shortageCount} shortage{totals.shortageCount !== 1 ? "s" : ""}
            </Badge>
          )}
        </div>
        <div className="grid w-full grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:flex sm:w-auto sm:items-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRestoreDialogOpen(true)}
            data-testid="button-v5-restore-cancelled"
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            Restore Cancelled
          </Button>
          <Button size="sm" onClick={() => setCreateDrawerOpen(true)} data-testid="button-v5-open-create-proforma">
            <Plus className="h-4 w-4 mr-1.5" />
            Create Proforma
          </Button>
        </div>
      </div>

      {/* ── Row 2: Toolbar (search + filters + icon buttons) ──────────────── */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b bg-muted/30 px-3 py-2.5 sm:px-4">
        {/* Left: search + category */}
        <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative w-full sm:w-auto">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search product or code…"
              className="h-9 w-full pl-8 text-sm sm:w-52"
              data-testid="input-v5-search"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground rounded"
                data-testid="button-v5-clear-search"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Category multi-select */}
          {allCategories.length > 0 && (
            <div ref={catDropRef} className="relative w-full sm:w-auto" data-testid="select-v5-category-filter">
              <button
                onClick={() => setCatDropOpen((v) => !v)}
                className={cn(
                  "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border px-3 text-sm font-medium transition-colors sm:min-w-[160px]",
                  catDropOpen || categoryFilter.length > 0
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-input bg-background text-foreground hover:bg-accent"
                )}
              >
                <span className="truncate">{catLabel}</span>
                <div className="flex items-center gap-1 shrink-0">
                  {categoryFilter.length > 0 && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        setCategoryFilter([]);
                      }}
                      className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/20 hover:bg-primary/30"
                    >
                      <X className="h-2.5 w-2.5" />
                    </span>
                  )}
                  <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", catDropOpen && "rotate-180")} />
                </div>
              </button>
              {catDropOpen && (
                <div className="absolute left-0 top-full z-50 mt-1.5 max-h-[min(24rem,70dvh)] w-full min-w-56 overflow-y-auto rounded-lg border bg-popover shadow-lg sm:w-56">
                  <button
                    onClick={() =>
                      setCategoryFilter(categoryFilter.length === allCategories.length ? [] : [...allCategories])
                    }
                    className="flex w-full items-center gap-2.5 border-b px-3 py-2.5 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                  >
                    <div
                      className={cn(
                        "flex h-4 w-4 items-center justify-center rounded border transition-colors",
                        categoryFilter.length === allCategories.length ? "border-primary bg-primary" : "border-input"
                      )}
                    >
                      {categoryFilter.length === allCategories.length && (
                        <CheckCircle2 className="h-2.5 w-2.5 text-primary-foreground" />
                      )}
                      {categoryFilter.length > 0 && categoryFilter.length < allCategories.length && (
                        <div className="h-1.5 w-1.5 rounded-sm bg-primary" />
                      )}
                    </div>
                    Select all
                  </button>
                  {allCategories.map((cat) => {
                    const checked = categoryFilter.includes(cat);
                    return (
                      <button
                        key={cat}
                        onClick={() => toggleCategory(cat)}
                        className={cn(
                          "flex w-full items-center gap-2.5 px-3 py-2.5 text-sm transition-colors",
                          checked ? "bg-primary/10 text-primary" : "text-foreground hover:bg-accent"
                        )}
                      >
                        <div
                          className={cn(
                            "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                            checked ? "border-primary bg-primary" : "border-input"
                          )}
                        >
                          {checked && <CheckCircle2 className="h-2.5 w-2.5 text-primary-foreground" />}
                        </div>
                        {cat}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: toggle pill group + icon buttons */}
        <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
          {/* Grouped toggle pills */}
          <div className="grid w-full grid-cols-1 gap-1 rounded-lg border bg-background p-1 min-[420px]:grid-cols-3 sm:flex sm:w-auto sm:items-center sm:gap-0.5">
            <button
              onClick={() => setHideZero((v) => !v)}
              data-testid="button-v5-toggle-zero"
              className={cn(
                "rounded-md px-2 py-1.5 text-xs font-semibold transition-all sm:px-3",
                !hideZero
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              Show Zero Rows
            </button>
            <button
              onClick={() => setShowNegativeOnly((v) => !v)}
              data-testid="button-v5-toggle-negative-only"
              className={cn(
                "rounded-md px-2 py-1.5 text-xs font-semibold transition-all sm:px-3",
                showNegativeOnly
                  ? "bg-destructive text-destructive-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {showNegativeOnly ? `Negative Only (${rows.length})` : "Negative Only"}
            </button>
            <button
              onClick={() => setShowGarbageWipers((v) => !v)}
              data-testid="button-v5-toggle-garbage-wipers"
              className={cn(
                "rounded-md px-2 py-1.5 text-xs font-semibold transition-all sm:px-3",
                showGarbageWipers
                  ? "bg-secondary text-secondary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {showGarbageWipers
                ? `Hide Garbage/Wipers (${garbageWipersCount})`
                : `Show Garbage/Wipers${garbageWipersCount > 0 ? ` (${garbageWipersCount})` : ""}`}
            </button>
          </div>

          <div className="w-px h-5 bg-border hidden sm:block" />

          <div className="flex items-center gap-2 self-end sm:self-auto">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  onClick={() => setExportDialogOpen(true)}
                  disabled={rows.length === 0}
                  data-testid="button-v5-export-excel"
                >
                  <FileDown className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Export Excel</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={refreshFlash ? "secondary" : "outline"}
                  size="icon"
                  className={cn("h-9 w-9", refreshFlash && "ring-2 ring-primary/40")}
                  onClick={handleRefresh}
                  disabled={query.isFetching}
                  data-testid="button-v5-refresh"
                >
                  {refreshFlash ? <CheckCircle2 className="h-4 w-4 text-primary" /> : <RefreshCw className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{refreshFlash ? "Refreshed" : "Refresh"}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Content */}
      {query.isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : query.isError ? (
        <div className="p-6 flex flex-col items-center gap-4">
          <p className="text-muted-foreground text-sm">{(query.error as Error)?.message || "Failed to load."}</p>
          <Button variant="outline" onClick={() => query.refetch()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Try Again
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="p-3 sm:p-4">
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              No data found. Create a proforma with containers to use V5 stock allocation.
            </CardContent>
          </Card>
        </div>
      ) : (
        <>
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
                        {row.categoryName && <div className="mt-0.5 text-[11px] text-muted-foreground">{row.categoryName}</div>}
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
                                {activeContainers.some((container) => container.status === "DRAFT" && container.loadedQty === 0) && (
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

          <div className="hidden max-h-[calc(100vh-160px)] overflow-auto md:block">
            <table className="w-full text-sm border-collapse min-w-max">
              <thead>
                <tr className="bg-muted sticky top-0 z-30">
                  <th className="text-left px-3 pb-2.5 pt-0 font-medium border-b border-r whitespace-nowrap sticky left-0 bg-muted z-20 min-w-[200px] border-t-2 border-t-border">
                    Product
                  </th>
                  <th className="text-right px-3 pb-2.5 pt-0 font-medium border-b border-r whitespace-nowrap min-w-[120px] border-t-2 border-t-green-500 text-green-700 dark:text-green-400">
                    Stock Available
                  </th>
                  <th className="text-right px-3 pb-2.5 pt-0 font-medium border-b border-r whitespace-nowrap min-w-[130px] border-t-2 border-t-amber-500 text-amber-600 dark:text-amber-400">
                    Expected to Load
                  </th>
                  <th className="text-right px-3 pb-2.5 pt-0 font-medium border-b border-r whitespace-nowrap min-w-[110px] border-t-2 border-t-blue-500 text-blue-600 dark:text-blue-400">
                    Total Loaded
                  </th>
                  <th className="text-right px-3 pb-2.5 pt-0 font-medium border-b border-r whitespace-nowrap min-w-[140px] border-t-2 border-t-border">
                    Available Balance
                  </th>
                  <th className="text-center px-3 pb-2.5 pt-0 font-medium border-b whitespace-nowrap min-w-[70px] border-t-2 border-t-border">
                    Detail
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => {
                  const isExpanded = expandedRows.has(row.articleCode);
                  const isShortage = row.freeToPromise < 0;

                  return (
                    <Fragment key={row.articleCode}>
                      <tr
                        className={cn(
                          "border-b transition-colors",
                          idx % 2 === 0 ? "bg-background" : "bg-muted/20",
                          isShortage && "bg-destructive/5"
                        )}
                        style={isShortage ? { boxShadow: "inset 3px 0 0 hsl(var(--destructive))" } : undefined}
                        data-testid={`row-v5-${row.articleCode}`}
                      >
                        <td className="px-3 py-2 border-r sticky left-0 bg-inherit z-10">
                          <div className="flex items-center gap-1.5">
                            {isShortage && <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />}
                            <div>
                              <div
                                className="font-medium text-xs leading-tight truncate max-w-[200px]"
                                title={row.productName}
                              >
                                {row.productName}
                              </div>
                              <div className="text-[10px] text-muted-foreground font-mono">{row.articleCode}</div>
                            </div>
                          </div>
                        </td>

                        <td className="px-3 py-2 border-r text-right font-mono tabular-nums text-xs">
                          {row.stockAvailable > 0 ? (
                            <span className="text-green-700 dark:text-green-400 font-medium">{row.stockAvailable}</span>
                          ) : (
                            <span className="text-muted-foreground/40">0</span>
                          )}
                        </td>

                        <td
                          className={cn(
                            "px-3 py-2 border-r text-right font-mono tabular-nums text-xs",
                            row.expectedToLoad > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/40"
                          )}
                        >
                          {row.expectedToLoad > 0 ? row.expectedToLoad : "0"}
                        </td>

                        <td
                          className={cn(
                            "px-3 py-2 border-r text-right font-mono tabular-nums text-xs",
                            row.totalLoaded > 0 ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/40"
                          )}
                        >
                          {row.totalLoaded > 0 ? row.totalLoaded : <span className="text-muted-foreground/40">—</span>}
                        </td>

                        <td className="px-3 py-2 border-r text-right">
                          <div className="flex flex-col items-end gap-0.5">
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
                              <span className="text-[10px] text-destructive/70 font-normal">
                                need {Math.abs(row.freeToPromise)} more
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="px-3 py-2 text-center">
                          {row.proformaDetails.length > 0 ? (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => toggleRow(row.articleCode)}
                              data-testid={`button-v5-expand-${row.articleCode}`}
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
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

                          const isFocused = focusProformaId === proforma.proformaId;
                          const isFirstFocused = isFocused && !firstMatchRef.current;

                          return (
                            <tr
                              key={`${row.articleCode}-p${proforma.proformaId}`}
                              ref={
                                isFirstFocused
                                  ? (el) => {
                                      firstMatchRef.current = el;
                                    }
                                  : undefined
                              }
                              className={cn(
                                "border-b",
                                isFocused ? "bg-primary/10 ring-1 ring-inset ring-primary/30" : "bg-muted/30"
                              )}
                            >
                              <td colSpan={5} className="px-0 py-0">
                                <div className="px-8 py-2">
                                  <div className="flex items-center gap-2 mb-1.5 text-xs flex-wrap">
                                    <span className={cn("font-semibold", isFocused && "text-primary")}>
                                      {proforma.proformaName}
                                    </span>
                                    <span className="text-muted-foreground">—</span>
                                    <span className="text-muted-foreground">{proforma.customerName}</span>
                                    <Badge variant="outline" className="text-[10px] h-4 px-1">
                                      {proforma.containerCount} container{proforma.containerCount !== 1 ? "s" : ""}
                                    </Badge>
                                    <span className="text-muted-foreground">
                                      {proforma.lineQty} × {proforma.containerCount} =
                                      <span className="font-semibold text-amber-600 dark:text-amber-400 ml-1">
                                        {proforma.totalExpected} expected
                                      </span>
                                    </span>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-5 px-2 text-[10px]"
                                      data-testid={`button-v5-add-containers-${proforma.proformaId}`}
                                      onClick={() =>
                                        openAddContainers(
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
                                      className="h-5 px-2 text-[10px]"
                                      data-testid={`button-v5-link-container-${proforma.proformaId}`}
                                      onClick={() => {
                                        setLinkSelected(new Set());
                                        setLinkDialog({
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
                                      className="h-5 px-2 text-[10px]"
                                      data-testid={`button-v5-edit-proforma-${proforma.proformaId}`}
                                      onClick={() => setEditDrawerProformaId(proforma.proformaId)}
                                    >
                                      <Pencil className="h-2.5 w-2.5 mr-1" />
                                      Edit Proforma
                                    </Button>
                                    {activeContainers.some((c) => c.status === "DRAFT" && c.loadedQty === 0) && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-5 px-2 text-[10px]"
                                        data-testid={`button-v5-edit-draft-${proforma.proformaId}`}
                                        onClick={() => openEditDraft(proforma.proformaId, proforma.proformaName, rows)}
                                      >
                                        <Pencil className="h-2.5 w-2.5 mr-1" />
                                        Edit Draft Qty
                                      </Button>
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
                                          <Badge variant="outline" className="text-[9px] h-4 px-1">
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
                                          {(c.status === "DRAFT" || c.status === "LOADING") && (
                                            <button
                                              type="button"
                                              title={`Cancel ${c.containerName}`}
                                              data-testid={`button-v5-cancel-container-${c.orderId}`}
                                              onClick={() => {
                                                setCancelSuperUser("");
                                                setCancelSuperPass("");
                                                setCancelDialog({
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
                {totals && (
                  <tr className="bg-muted font-semibold text-xs border-t-2 sticky bottom-0 z-10">
                    <td className="px-3 py-2 border-r sticky left-0 bg-muted z-20">
                      Totals <span className="font-normal text-muted-foreground">({rows.length} products)</span>
                    </td>
                    <td className="px-3 py-2 border-r text-right font-mono tabular-nums">
                      <span className="text-green-700 dark:text-green-400">{totals.stockAvailable}</span>
                    </td>
                    <td className="px-3 py-2 border-r text-right font-mono tabular-nums text-amber-600 dark:text-amber-400">
                      {totals.expectedToLoad}
                    </td>
                    <td className="px-3 py-2 border-r text-right font-mono tabular-nums text-blue-600 dark:text-blue-400">
                      {totals.totalLoaded > 0 ? totals.totalLoaded : "—"}
                    </td>
                    <td className="px-3 py-2 border-r text-right">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold font-mono tabular-nums ring-1",
                          totals.freeToPromise < 0
                            ? "bg-destructive/10 text-destructive ring-destructive/30"
                            : totals.freeToPromise === 0
                              ? "bg-muted text-muted-foreground ring-border"
                              : "bg-green-500/10 text-green-700 dark:text-green-400 ring-green-500/30"
                        )}
                      >
                        {totals.freeToPromise > 0 ? `+${totals.freeToPromise}` : totals.freeToPromise}
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

      {/* Create drawer */}
      <CreateProformaV5Drawer
        open={createDrawerOpen}
        onClose={() => setCreateDrawerOpen(false)}
        articleRows={drawerRows}
        onSuccess={() => query.refetch()}
      />

      {/* Edit Proforma drawer */}
      {editDrawerProformaId !== null && (
        <EditProformaV5Drawer
          open={editDrawerProformaId !== null}
          onClose={() => setEditDrawerProformaId(null)}
          proformaId={editDrawerProformaId}
          articleRows={drawerRows}
          onSuccess={() => query.refetch()}
        />
      )}

      {/* Add Containers dialog */}
      <FactoryStockAllocationV5Dialog1 model={model} />

      {/* Edit Draft Quantities dialog */}
      <FactoryStockAllocationV5Dialog2 model={model} />

      {/* Close Proforma confirmation dialog */}
      <FactoryStockAllocationV5Dialog3 model={model} />

      {/* Link Existing Container dialog */}
      <FactoryStockAllocationV5Dialog4 model={model} />

      {/* Restore Cancelled Container dialog */}
      <FactoryStockAllocationV5Dialog5 model={model} />

      {/* Cancel Container — DRAFT */}
      <FactoryStockAllocationV5Dialog6 model={model} />

      {/* Cancel Container — LOADING */}
      <FactoryStockAllocationV5Dialog7 model={model} />

      {/* Export Excel dialog */}
      <FactoryStockAllocationV5Dialog8 model={model} />
    </div>
  );
}
