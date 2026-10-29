import { Fragment } from "react";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import {
  Loader2,
  RefreshCw,
  AlertTriangle,
  Plus,
  ChevronDown,
  Container,
  CheckCircle2,
  Pencil,
  X,
  Link2,
  FileDown,
  RotateCcw,
  Search,
  Package,
  Boxes,
  Truck,
  Scale,
  MoreHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { STATUS_LABELS } from "./factorystockallocationv5/utils";
import { useFactoryStockAllocationV5Model } from "./factorystockallocationv5/useFactoryStockAllocationV5Model";
import { FactoryStockAllocationV5MobileList } from "./factorystockallocationv5/components/FactoryStockAllocationV5MobileList";
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
  const [, setLocation] = useLocation();
  const {
    focusProformaId,
    firstMatchRef,
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
    setExportDialogOpen,
    openAddContainers,
    openEditDraft,
    setLinkDialog,
    setLinkSelected,
    setRestoreDialogOpen,
    setCancelDialog,
    setCancelSuperUser,
    setCancelSuperPass,
    query,
    rows,
    allCategories,
    totals,
    handleRefresh,
    toggleRow,
    catDropOpen,
    setCatDropOpen,
    catDropRef,
    toggleCategory,
    catLabel,
  } = model;
  /* ── Render ───────────────────────────────────────────────────────────── */
  return (
    <div className="flex min-w-0 flex-col pb-6" data-testid="factory-stock-allocation-v5-page">

      <section className="px-3 pb-3 pt-5 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-violet-500/30 bg-violet-500/15 text-violet-500"><Package className="h-6 w-6" /></div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Stock Allocation</h1>
                {totals && totals.shortageCount > 0 && <Badge variant="destructive" className="gap-1 text-xs"><AlertTriangle className="h-3 w-3" />{totals.shortageCount} shortages</Badge>}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">Monitor product stock, expected loading and available balances.</p>
            </div>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Button size="icon" variant="outline" className="h-9 w-9 rounded-lg" onClick={handleRefresh} disabled={query.isFetching} aria-label="Refresh stock allocation" data-testid="button-v5-refresh">
              {refreshFlash ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <RefreshCw className={cn("h-4 w-4", query.isFetching && "animate-spin")} />}
            </Button>
            <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg" onClick={() => setExportDialogOpen(true)} disabled={rows.length === 0} data-testid="button-v5-export-excel"><FileDown className="h-4 w-4" />Export</Button>
            <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg" onClick={() => setRestoreDialogOpen(true)} data-testid="button-v5-restore-cancelled"><RotateCcw className="h-4 w-4" />Restore Cancelled</Button>
            <Button size="sm" className="h-9 gap-1.5 rounded-lg bg-violet-600 text-white shadow-md shadow-violet-500/20 hover:bg-violet-700" onClick={() => setLocation("/factory/stock-allocation-v5/proformas/new")} data-testid="button-v5-open-create-proforma"><Plus className="h-4 w-4" />Create Proforma</Button>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2.5 lg:grid-cols-3 xl:grid-cols-5">
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-violet-500/25 bg-violet-500/[0.08] p-3.5 shadow-sm">
            <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-500/20 text-violet-500 sm:flex"><Package className="h-5 w-5" /></div>
            <div className="min-w-0"><p className="text-xs font-medium text-muted-foreground">Total Products</p><p className="mt-1 text-2xl font-bold tabular-nums">{(query.data?.rows.length ?? 0).toLocaleString()}</p></div>
          </div>
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] p-3.5 shadow-sm">
            <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-500 sm:flex"><Boxes className="h-5 w-5" /></div>
            <div className="min-w-0"><p className="text-xs font-medium text-muted-foreground">Stock Available</p><p className="mt-1 text-2xl font-bold tabular-nums text-emerald-500">{(totals?.stockAvailable ?? 0).toLocaleString()}</p></div>
          </div>
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-3.5 shadow-sm">
            <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-500 sm:flex"><Container className="h-5 w-5" /></div>
            <div className="min-w-0"><p className="text-xs font-medium text-muted-foreground">Expected to Load</p><p className="mt-1 text-2xl font-bold tabular-nums text-amber-500">{(totals?.expectedToLoad ?? 0).toLocaleString()}</p></div>
          </div>
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-sky-500/25 bg-sky-500/[0.07] p-3.5 shadow-sm">
            <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-500 sm:flex"><Truck className="h-5 w-5" /></div>
            <div className="min-w-0"><p className="text-xs font-medium text-muted-foreground">Total Loaded</p><p className="mt-1 text-2xl font-bold tabular-nums text-sky-500">{(totals?.totalLoaded ?? 0).toLocaleString()}</p></div>
          </div>
          <div className="col-span-2 flex min-w-0 items-center gap-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.07] p-3.5 shadow-sm lg:col-span-1">
            <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rose-500/15 text-rose-500 sm:flex"><Scale className="h-5 w-5" /></div>
            <div className="min-w-0"><p className="text-xs font-medium text-muted-foreground">Net Available Balance</p><p className={cn("mt-1 text-2xl font-bold tabular-nums", (totals?.freeToPromise ?? 0) < 0 ? "text-rose-500" : "text-emerald-500")}>{(totals?.freeToPromise ?? 0).toLocaleString()}</p></div>
          </div>
        </div>
      </section>

      {/* ── Row 2: Toolbar (search + filters + icon buttons) ──────────────── */}
      <div className="mx-3 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-t-xl border bg-card/70 p-3 shadow-sm sm:mx-5">
        {/* Left: search + category */}
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2.5 xl:w-auto">
          <div className="relative min-w-[180px] flex-1 xl:flex-none">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search product name or code..."
              className="h-10 w-full rounded-lg pl-8 text-sm xl:w-[320px]"
              data-testid="input-v5-search"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground rounded-sm"
                data-testid="button-v5-clear-search"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Category multi-select */}
          {allCategories.length > 0 && (
            <div ref={catDropRef} className="relative min-w-[150px] flex-1 sm:flex-none" data-testid="select-v5-category-filter">
              <button
                onClick={() => setCatDropOpen((v) => !v)}
                className={cn(
                  "flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-lg border px-3 text-sm font-medium transition-colors sm:min-w-[175px]",
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
                        "flex h-4 w-4 items-center justify-center rounded-sm border transition-colors",
                        categoryFilter.length === allCategories.length ? "border-primary bg-primary" : "border-input"
                      )}
                    >
                      {categoryFilter.length === allCategories.length && (
                        <CheckCircle2 className="h-2.5 w-2.5 text-primary-foreground" />
                      )}
                      {categoryFilter.length > 0 && categoryFilter.length < allCategories.length && (
                        <div className="h-1.5 w-1.5 rounded-xs bg-primary" />
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
                            "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-colors",
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


        {/* Compact, accessible filter switches. No duplicate export/refresh buttons. */}
        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 text-xs font-medium xl:w-auto">
          <button type="button" onClick={() => setHideZero((v) => !v)} data-testid="button-v5-toggle-zero" aria-pressed={!hideZero} className="flex items-center gap-2 text-foreground hover:text-violet-500">
            <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", !hideZero ? "bg-violet-600" : "bg-muted-foreground/30")}>
              <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all", !hideZero ? "left-[18px]" : "left-0.5")} />
            </span>Show Zero Rows
          </button>
          <button type="button" onClick={() => setShowNegativeOnly((v) => !v)} data-testid="button-v5-toggle-negative-only" aria-pressed={showNegativeOnly} className="flex items-center gap-2 text-foreground hover:text-violet-500">
            <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", showNegativeOnly ? "bg-violet-600" : "bg-muted-foreground/30")}>
              <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all", showNegativeOnly ? "left-[18px]" : "left-0.5")} />
            </span>Negative Only
          </button>
          <button type="button" onClick={() => setShowGarbageWipers((v) => !v)} data-testid="button-v5-toggle-garbage-wipers" aria-pressed={showGarbageWipers} className="flex items-center gap-2 text-foreground hover:text-violet-500">
            <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", showGarbageWipers ? "bg-violet-600" : "bg-muted-foreground/30")}>
              <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all", showGarbageWipers ? "left-[18px]" : "left-0.5")} />
            </span>Show Garbage/Wipers
          </button>
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
          <FactoryStockAllocationV5MobileList model={model} />

          <div data-horizontal-scroll="true" className="hidden overflow-x-auto md:block phone-land:hidden mx-3 rounded-b-xl border border-t-0 bg-card shadow-sm sm:mx-5">
            <table className="w-full min-w-[1080px] table-fixed border-collapse text-sm">
              <colgroup>
                <col style={{ width: "29%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "19%" }} />
                <col style={{ width: "6%" }} />
              </colgroup>
              <thead>
                <tr className="sticky top-0 z-30 bg-slate-100 text-slate-700 dark:bg-slate-800/95 dark:text-slate-200">
                  <th className="sticky left-0 z-20 border-b border-r bg-slate-100 px-4 py-3 text-left text-xs font-semibold dark:bg-slate-800/95">Product</th>
                  <th className="border-b border-r px-3 py-3 text-left text-xs font-semibold">Code</th>
                  <th className="px-2 py-3 text-center text-xs font-semibold border-b border-r whitespace-nowrap text-green-700 dark:text-green-400">
                    Stock Available
                  </th>
                  <th className="px-2 py-3 text-center text-xs font-semibold border-b border-r whitespace-nowrap text-amber-600 dark:text-amber-400">
                    Expected to Load
                  </th>
                  <th className="px-2 py-3 text-center text-xs font-semibold border-b border-r whitespace-nowrap text-blue-600 dark:text-blue-400">
                    Total Loaded
                  </th>
                  <th className="px-2 py-3 text-center text-xs font-semibold border-b border-r whitespace-nowrap">
                    Available Balance
                  </th>
                  <th className="border-b px-2 py-3 text-center text-xs font-semibold whitespace-nowrap">
                    Action
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
                          idx % 2 === 0 ? "bg-card" : "bg-muted/25",
                          isShortage && "bg-rose-500/[0.06]"
                        )}
                        style={isShortage ? { boxShadow: "inset 3px 0 0 hsl(var(--destructive))" } : undefined}
                        data-testid={`row-v5-${row.articleCode}`}
                      >
                        <td className="sticky left-0 z-10 border-r bg-inherit px-4 py-2.5">
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center">{isShortage && <AlertTriangle className="h-4 w-4 text-rose-500" />}</span>
                            <span className="block truncate text-xs font-semibold sm:text-sm" title={row.productName}>{row.productName}</span>
                          </div>
                        </td>
                        <td className="border-r px-3 py-2.5 font-mono text-xs text-muted-foreground">{row.articleCode}</td>

                        <td className="border-r px-2 py-2.5 text-center font-mono text-xs tabular-nums">
                          {row.stockAvailable > 0 ? (
                            <span className="text-green-700 dark:text-green-400 font-medium">{row.stockAvailable}</span>
                          ) : (
                            <span className="text-muted-foreground/40">0</span>
                          )}
                        </td>

                        <td
                          className={cn(
                            "border-r px-2 py-2.5 text-center font-mono text-xs tabular-nums",
                            row.expectedToLoad > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/40"
                          )}
                        >
                          {row.expectedToLoad > 0 ? row.expectedToLoad : "0"}
                        </td>

                        <td
                          className={cn(
                            "border-r px-2 py-2.5 text-center font-mono text-xs tabular-nums",
                            row.totalLoaded > 0 ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/40"
                          )}
                        >
                          {row.totalLoaded > 0 ? row.totalLoaded : <span className="text-muted-foreground/40">—</span>}
                        </td>

                        <td className="border-r px-2 py-2.5 text-center">
                          <div className="flex flex-col items-center gap-0.5">
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
                              <span className="text-[11px] text-destructive/70 font-normal">
                                need {Math.abs(row.freeToPromise)} more
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="px-2 py-2.5 text-center">
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
                                <MoreHorizontal className="h-4 w-4" />
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
                              <td colSpan={7} className="px-0 py-0">
                                <div className="px-8 py-2">
                                  <div className="flex items-center gap-2 mb-1.5 text-xs flex-wrap">
                                    <span className={cn("font-semibold", isFocused && "text-primary")}>
                                      {proforma.proformaName}
                                    </span>
                                    <span className="text-muted-foreground">—</span>
                                    <span className="text-muted-foreground">{proforma.customerName}</span>
                                    <Badge variant="outline" className="text-[11px] h-4 px-1">
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
                                      className="h-5 px-2 text-[11px]"
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
                                      className="h-5 px-2 text-[11px]"
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
                                      className="h-5 px-2 text-[11px]"
                                      data-testid={`button-v5-edit-proforma-${proforma.proformaId}`}
                                      onClick={() => setLocation(`/factory/stock-allocation-v5/proformas/${proforma.proformaId}/edit`)}
                                    >
                                      <Pencil className="h-2.5 w-2.5 mr-1" />
                                      Edit Proforma
                                    </Button>
                                    {activeContainers.some((c) => c.status === "DRAFT" && c.loadedQty === 0) && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-5 px-2 text-[11px]"
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
                                          <Badge variant="outline" className="text-[11px] h-4 px-1">
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
                  <tr className="sticky bottom-0 z-10 border-t-2 bg-slate-100 text-xs font-semibold dark:bg-slate-800">
                    <td className="sticky left-0 z-20 border-r bg-slate-100 px-4 py-3 dark:bg-slate-800">
                      Totals <span className="font-normal text-muted-foreground">({rows.length} products)</span>
                    </td>
                    <td className="border-r px-3 py-3 text-xs text-muted-foreground">Total</td>
                    <td className="border-r px-2 py-3 text-center font-mono tabular-nums">
                      <span className="text-green-700 dark:text-green-400">{totals.stockAvailable}</span>
                    </td>
                    <td className="border-r px-2 py-3 text-center font-mono tabular-nums text-amber-600 dark:text-amber-400">
                      {totals.expectedToLoad}
                    </td>
                    <td className="border-r px-2 py-3 text-center font-mono tabular-nums text-blue-600 dark:text-blue-400">
                      {totals.totalLoaded > 0 ? totals.totalLoaded : "—"}
                    </td>
                    <td className="border-r px-2 py-3 text-center">
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
