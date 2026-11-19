import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useLocation } from "wouter";
import {
  RefreshCw,
  AlertTriangle,
  Plus,
  ChevronDown,
  Container,
  CheckCircle2,
  X,
  FileDown,
  RotateCcw,
  Package,
  Boxes,
  Truck,
  Scale,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useFactoryStockAllocationV5Model } from "./factorystockallocationv5/useFactoryStockAllocationV5Model";
import { FactoryStockAllocationV5Dialog1 } from "./factorystockallocationv5/components/FactoryStockAllocationV5Dialog1";
import { FactoryStockAllocationV5Dialog2 } from "./factorystockallocationv5/components/FactoryStockAllocationV5Dialog2";
import { FactoryStockAllocationV5Dialog3 } from "./factorystockallocationv5/components/FactoryStockAllocationV5Dialog3";
import { FactoryStockAllocationV5Dialog4 } from "./factorystockallocationv5/components/FactoryStockAllocationV5Dialog4";
import { FactoryStockAllocationV5Dialog5 } from "./factorystockallocationv5/components/FactoryStockAllocationV5Dialog5";
import { FactoryStockAllocationV5Dialog6 } from "./factorystockallocationv5/components/FactoryStockAllocationV5Dialog6";
import { FactoryStockAllocationV5Dialog7 } from "./factorystockallocationv5/components/FactoryStockAllocationV5Dialog7";
import { FactoryStockAllocationV5Dialog8 } from "./factorystockallocationv5/components/FactoryStockAllocationV5Dialog8";
import { SearchField } from "@/components/ui/search-field";
import { FactoryStockAllocationV5Table } from "./FactoryStockAllocationV5Table";

export default function FactoryStockAllocationV5() {
  const model = useFactoryStockAllocationV5Model();
  const mhd = useFactoryMhdView();
  const recordChanges = useExistingRecordChangeAccess();
  const [, setLocation] = useLocation();
  const mhdRows = mhd.sortRows(model.rows, (row) => row.articleCode);
  /* ── Render ───────────────────────────────────────────────────────────── */
  return (
    <div className="flex min-w-0 flex-col pb-6" data-testid="factory-stock-allocation-v5-page">
      <section className="px-3 pb-3 pt-5 sm:px-5">
        <PageHeader
          title="Stock Allocation"
          icon={<Package className="h-5 w-5" />}
          subtitle="Monitor product stock, expected loading and available balances."
          meta={
            model.totals && model.totals.shortageCount > 0 ? (
              <Badge variant="destructive" className="gap-1 text-xs">
                <AlertTriangle className="h-3 w-3" />
                {model.totals.shortageCount} shortages
              </Badge>
            ) : undefined
          }
        >
          <Button
            size="icon"
            variant="outline"
            className="h-9 w-9 rounded-lg"
            onClick={model.handleRefresh}
            disabled={model.query.isFetching}
            aria-label="Refresh stock allocation"
            data-testid="button-v5-refresh"
          >
            {model.refreshFlash ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            ) : (
              <RefreshCw className={cn("h-4 w-4", model.query.isFetching && "animate-spin")} />
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 rounded-lg"
            onClick={() => model.setExportDialogOpen(true)}
            disabled={model.rows.length === 0}
            data-testid="button-v5-export-excel"
          >
            <FileDown className="h-4 w-4" />
            Export
          </Button>
          {recordChanges.allowed && (
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 rounded-lg"
              onClick={() => model.setRestoreDialogOpen(true)}
              data-testid="button-v5-restore-cancelled"
            >
              <RotateCcw className="h-4 w-4" />
              Restore Cancelled
            </Button>
          )}
          {!recordChanges.isCreateOnly && (
            <Button
              size="sm"
              className="h-9 gap-1.5 rounded-lg bg-violet-600 text-white shadow-md shadow-violet-500/20 hover:bg-violet-700"
              onClick={() => setLocation("/factory/stock-allocation-v5/proformas/new")}
              data-testid="button-v5-open-create-proforma"
            >
              <Plus className="h-4 w-4" />
              Create Proforma
            </Button>
          )}
        </PageHeader>
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3 xl:grid-cols-5">
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-violet-500/25 bg-violet-500/[0.08] p-3.5 shadow-sm">
            <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-500/20 text-violet-500 sm:flex">
              <Package className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">Total Products</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">
                {(model.query.data?.rows.length ?? 0).toLocaleString()}
              </p>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] p-3.5 shadow-sm">
            <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-500 sm:flex">
              <Boxes className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">Stock Available</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-500">
                {(model.totals?.stockAvailable ?? 0).toLocaleString()}
              </p>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-3.5 shadow-sm">
            <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-500 sm:flex">
              <Container className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">Expected to Load</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-amber-500">
                {(model.totals?.expectedToLoad ?? 0).toLocaleString()}
              </p>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-sky-500/25 bg-sky-500/[0.07] p-3.5 shadow-sm">
            <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-500 sm:flex">
              <Truck className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">Total Loaded</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-sky-500">
                {(model.totals?.totalLoaded ?? 0).toLocaleString()}
              </p>
            </div>
          </div>
          <div className="col-span-2 flex min-w-0 items-center gap-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.07] p-3.5 shadow-sm lg:col-span-1">
            <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rose-500/15 text-rose-500 sm:flex">
              <Scale className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">Net Available Balance</p>
              <p
                className={cn(
                  "mt-1 text-2xl font-bold tabular-nums",
                  (model.totals?.freeToPromise ?? 0) < 0 ? "text-rose-500" : "text-emerald-500"
                )}
              >
                {(model.totals?.freeToPromise ?? 0).toLocaleString()}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Row 2: Toolbar (search + filters + icon buttons) ──────────────── */}
      <div className="mx-3 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-t-xl border bg-card/70 p-3 shadow-sm sm:mx-5">
        {/* Left: search + category */}
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2.5 xl:w-auto">
          <SearchField
            value={model.searchQuery}
            onValueChange={model.setSearchQuery}
            placeholder="Search product name or code..."
            wrapperClassName="min-w-[180px] flex-1 xl:w-[320px] xl:flex-none"
            className="h-10 rounded-lg text-sm"
            data-testid="input-v5-search"
            clearTestId="button-v5-clear-search"
          />

          {/* Category multi-select */}
          {model.allCategories.length > 0 && (
            <div
              ref={model.catDropRef}
              className="relative min-w-[150px] flex-1 sm:flex-none"
              data-testid="select-v5-category-filter"
            >
              <button
                onClick={() => model.setCatDropOpen((v) => !v)}
                className={cn(
                  "flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-lg border px-3 text-sm font-medium transition-colors sm:min-w-[175px]",
                  model.catDropOpen || model.categoryFilter.length > 0
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-input bg-background text-foreground hover:bg-accent"
                )}
              >
                <span className="truncate">{model.catLabel}</span>
                <div className="flex items-center gap-1 shrink-0">
                  {model.categoryFilter.length > 0 && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        model.setCategoryFilter([]);
                      }}
                      className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/20 hover:bg-primary/30"
                    >
                      <X className="h-2.5 w-2.5" />
                    </span>
                  )}
                  <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", model.catDropOpen && "rotate-180")} />
                </div>
              </button>
              {model.catDropOpen && (
                <div className="absolute left-0 top-full z-50 mt-1.5 max-h-[min(24rem,70dvh)] w-full min-w-56 overflow-y-auto rounded-lg border bg-popover shadow-lg sm:w-56">
                  <button
                    onClick={() =>
                      model.setCategoryFilter(
                        model.categoryFilter.length === model.allCategories.length ? [] : [...model.allCategories]
                      )
                    }
                    className="flex w-full items-center gap-2.5 border-b px-3 py-2.5 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                  >
                    <div
                      className={cn(
                        "flex h-4 w-4 items-center justify-center rounded-sm border transition-colors",
                        model.categoryFilter.length === model.allCategories.length
                          ? "border-primary bg-primary"
                          : "border-input"
                      )}
                    >
                      {model.categoryFilter.length === model.allCategories.length && (
                        <CheckCircle2 className="h-2.5 w-2.5 text-primary-foreground" />
                      )}
                      {model.categoryFilter.length > 0 && model.categoryFilter.length < model.allCategories.length && (
                        <div className="h-1.5 w-1.5 rounded-xs bg-primary" />
                      )}
                    </div>
                    Select all
                  </button>
                  {model.allCategories.map((cat) => {
                    const checked = model.categoryFilter.includes(cat);
                    return (
                      <button
                        key={cat}
                        onClick={() => model.toggleCategory(cat)}
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
          <button
            type="button"
            onClick={() => model.setHideZero((v) => !v)}
            data-testid="button-v5-toggle-zero"
            aria-pressed={!model.hideZero}
            className="flex items-center gap-2 text-foreground hover:text-violet-500"
          >
            <span
              className={cn(
                "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                !model.hideZero ? "bg-violet-600" : "bg-muted-foreground/30"
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all",
                  !model.hideZero ? "left-[18px]" : "left-0.5"
                )}
              />
            </span>
            Show Zero Rows
          </button>
          <button
            type="button"
            onClick={() => model.setShowNegativeOnly((v) => !v)}
            data-testid="button-v5-toggle-negative-only"
            aria-pressed={model.showNegativeOnly}
            className="flex items-center gap-2 text-foreground hover:text-violet-500"
          >
            <span
              className={cn(
                "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                model.showNegativeOnly ? "bg-violet-600" : "bg-muted-foreground/30"
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all",
                  model.showNegativeOnly ? "left-[18px]" : "left-0.5"
                )}
              />
            </span>
            Negative Only
          </button>
          <button
            type="button"
            onClick={() => model.setShowGarbageWipers((v) => !v)}
            data-testid="button-v5-toggle-garbage-wipers"
            aria-pressed={model.showGarbageWipers}
            className="flex items-center gap-2 text-foreground hover:text-violet-500"
          >
            <span
              className={cn(
                "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                model.showGarbageWipers ? "bg-violet-600" : "bg-muted-foreground/30"
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all",
                  model.showGarbageWipers ? "left-[18px]" : "left-0.5"
                )}
              />
            </span>
            Show Garbage/Wipers
          </button>
        </div>
      </div>

      {/* Content */}
      <FactoryStockAllocationV5Table
        model={model}
        mhd={mhd}
        recordChanges={recordChanges}
        setLocation={setLocation}
        mhdRows={mhdRows}
      />

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
