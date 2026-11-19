import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Radio,
  Loader2,
  Package,
  Ship,
  Truck,
  DollarSign,
  Clock,
  Filter,
  ChevronDown,
  Scale,
  Upload,
  RefreshCcw,
  CalendarDays,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { OtwTrackingTabProps } from "./factoryotwtrackingtab/types";
import { fmtAmt } from "./factoryotwtrackingtab/utils";
import { SummaryCard } from "./factoryotwtrackingtab/components/SummaryCard";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { SearchField } from "@/components/ui/search-field";
import { useFactoryOtwTrackingTabModel } from "./FactoryOtwTrackingTabModel";
import { FactoryOtwTrackingTable } from "./FactoryOtwTrackingTable";
export default function FactoryOtwTrackingTab({ onEdit }: OtwTrackingTabProps = {}) {
  const m = useFactoryOtwTrackingTabModel();

  if (m.isLoading) {
    return (
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-16 w-36 rounded-lg border bg-muted animate-pulse" />
          ))}
        </div>
        <div className="h-48 rounded-lg border bg-muted animate-pulse" />
      </div>
    );
  }
  if (m.otwContainers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
        <Radio className="h-12 w-12 opacity-20" />
        <p className="text-sm">No containers currently on the way.</p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 pb-6">
      <header className="relative isolate overflow-hidden rounded-2xl border border-blue-200/50 bg-gradient-to-r from-slate-50 via-blue-50/70 to-sky-100/60 p-5 shadow-sm dark:border-blue-400/15 dark:from-[hsl(var(--factory-hue)_58%_11%)] dark:via-[hsl(var(--factory-hue)_59%_14%)] dark:to-[hsl(var(--factory-hue)_71%_15%)] sm:p-6">
        <div className="pointer-events-none absolute -right-12 -top-12 h-52 w-72 rounded-full bg-blue-500/15 blur-3xl" />
        <Ship
          className="pointer-events-none absolute -bottom-4 right-10 hidden h-36 w-36 text-blue-500/10 lg:block"
          strokeWidth={1}
        />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-blue-500/30 bg-blue-500/15 shadow-lg shadow-blue-500/10">
              <Truck className="h-7 w-7 text-blue-600 dark:text-blue-300" />
            </div>
            <div>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">OTW Tracking</h2>
                <span className="rounded-full border border-blue-400/20 bg-blue-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-200">
                  Incoming shipments
                </span>
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Container visibility, delays, ETAs and documents in one place.
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-2 rounded-xl border border-slate-300/40 bg-white/50 px-3 py-2 text-xs text-slate-600 dark:border-white/10 dark:bg-slate-950/25 dark:text-slate-300">
            <CalendarDays className="h-4 w-4 text-blue-500" /> Active shipment overview
          </span>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        <SummaryCard
          label="Active containers"
          value={m.otwContainers.length}
          icon={<Package className="h-5 w-5 text-blue-500" />}
          accent="bg-blue-500/10"
          helper="Currently tracked"
        />
        <SummaryCard
          label="In transit"
          value={m.inTransit}
          icon={<Truck className="h-5 w-5 text-cyan-500" />}
          accent="bg-cyan-500/10"
          helper={m.arrived + " arrived"}
        />
        <SummaryCard
          label="Delayed"
          value={m.delayed}
          icon={<Clock className="h-5 w-5 text-red-500" />}
          accent="bg-red-500/10"
          helper="Past ETA date"
        />
        <SummaryCard
          label="Total weight"
          value={Math.round(m.totalWeight).toLocaleString() + " KG"}
          icon={<Scale className="h-5 w-5 text-violet-500" />}
          accent="bg-violet-500/10"
          helper="Filtered containers"
        />
        {Object.entries(m.totalByCurrencyWithUsdBalance).map(([ccy, item]) => (
          <SummaryCard
            key={"total-" + ccy}
            label={"Total (" + ccy + ")"}
            value={fmtAmt(item.symbol, item.amount)}
            icon={<DollarSign className="h-5 w-5 text-emerald-500" />}
            accent="bg-emerald-500/10"
            helper={ccy === "USD" ? "Cost + freight + commission" : "Container cost"}
          />
        ))}
        {Object.entries(m.freightByCurrency).map(([ccy, item]) => (
          <SummaryCard
            key={"freight-" + ccy}
            label={"Freight (" + ccy + ")"}
            value={fmtAmt(item.symbol, item.amount)}
            icon={<Ship className="h-5 w-5 text-sky-500" />}
            accent="bg-sky-500/10"
            helper="Filtered containers"
          />
        ))}
      </div>

      <section
        aria-label="OTW search and filters"
        className="rounded-2xl border border-border/70 bg-card p-3 shadow-sm sm:p-4"
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <SearchField
            value={m.search}
            onValueChange={m.setSearch}
            placeholder="Search container # or supplier..."
            wrapperClassName="min-w-[210px] flex-[2_1_320px]"
            className="h-10 rounded-xl bg-background/80"
            data-testid="input-otw-search"
          />
          <div className="min-w-[150px] flex-[1_1_155px]">
            <Select value={m.supplierFilter} onValueChange={m.setSupplierFilter}>
              <SelectTrigger className="h-10 rounded-xl" data-testid="select-supplier-filter">
                <SelectValue placeholder="All suppliers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All suppliers</SelectItem>
                {m.suppliers.map(([key, name]) => (
                  <SelectItem key={key} value={key}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[130px] flex-[1_1_135px]">
            <Select value={m.delayedFilter} onValueChange={m.setDelayedFilter}>
              <SelectTrigger className="h-10 rounded-xl" data-testid="select-delayed-filter">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="on_time">On time</SelectItem>
                <SelectItem value="delayed">Delayed</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
                <SelectItem value="eta_missing">ETA missing</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[135px] flex-[1_1_145px]">
            <Select value={m.sortOrder} onValueChange={m.setSortOrder}>
              <SelectTrigger className="h-10 rounded-xl" data-testid="select-sort-order">
                <CalendarDays className="mr-1 h-4 w-4 shrink-0 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DEFAULT">Default order</SelectItem>
                <SelectItem value="ETA_ASC">Earliest ETA</SelectItem>
                <SelectItem value="ETA_DESC">Latest ETA</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            className="h-10 rounded-xl"
            onClick={() => m.setShowFilters((v) => !v)}
            aria-expanded={m.showFilters}
            data-testid="button-otw-filters"
          >
            <Filter className="mr-1.5 h-4 w-4" /> Filters
            {m.activeFilterCount > 0 && (
              <span className="ml-1.5 rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] leading-none text-white">
                {m.activeFilterCount}
              </span>
            )}
            <ChevronDown className={cn("ml-1.5 h-3.5 w-3.5 transition-transform", m.showFilters && "rotate-180")} />
          </Button>
          <Button
            variant="ghost"
            className="h-10 rounded-xl"
            onClick={m.clearFilters}
            data-testid="button-clear-filters"
          >
            <RefreshCcw className="mr-1.5 h-4 w-4" /> Reset
          </Button>
        </div>
        {m.showFilters && (
          <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-border/60 bg-muted/20 p-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Freight</p>
              <Select value={m.freightFilter} onValueChange={m.setFreightFilter}>
                <SelectTrigger className="h-9" data-testid="select-freight-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All freight</SelectItem>
                  <SelectItem value="has_freight">Has freight</SelectItem>
                  <SelectItem value="no_freight">No freight</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Weight</p>
              <Select value={m.weightFilter} onValueChange={m.setWeightFilter}>
                <SelectTrigger className="h-9" data-testid="select-weight-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All weights</SelectItem>
                  <SelectItem value="has_weight">Has weight</SelectItem>
                  <SelectItem value="no_weight">No weight</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Documents</p>
              <Select value={m.docsFilter} onValueChange={m.setDocsFilter}>
                <SelectTrigger className="h-9" data-testid="select-docs-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All documents</SelectItem>
                  <SelectItem value="received">Docs received</SelectItem>
                  <SelectItem value="not_received">Docs pending</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {m.currentUser?.role === "Developer" && (
              <div className="flex flex-wrap gap-2 sm:col-span-3">
                <ExportButton
                  kind="csv"
                  className="h-9"
                  onClick={m.exportCsv}
                  disabled={m.filtered.length === 0}
                  data-testid="button-export-csv"
                />
                {m.canImport && (
                  <>
                    <Button
                      variant="outline"
                      className="h-9"
                      disabled={m.importing}
                      title="Import CSV to bulk-update ETA. Columns: Container #, Supplier, ETA (YYYY-MM-DD)"
                      data-testid="button-import-csv"
                      onClick={() => document.getElementById("otw-import-input")?.click()}
                    >
                      {m.importing ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="mr-1.5 h-4 w-4" />
                      )}{" "}
                      Import CSV
                    </Button>
                    <input
                      id="otw-import-input"
                      type="file"
                      accept=".csv,.txt"
                      className="hidden"
                      onChange={m.handleImportFile}
                    />
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <FactoryOtwTrackingTable m={m} onEdit={onEdit} />
    </div>
  );
}
