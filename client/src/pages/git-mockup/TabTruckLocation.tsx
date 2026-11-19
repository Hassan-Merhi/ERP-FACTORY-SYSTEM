import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertCircle,
  Truck,
  Loader2,
  MessageCircle,
  SlidersHorizontal,
  MapPin,
  RotateCcw,
  Warehouse,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { groupBySupplier } from "./helpers";
import { STATUS_BADGE as STATUS_BADGE_MAP } from "./types";
import { ErpMobileRecordCard, ErpMobileRecordList } from "@/components/ui/erp-mobile-records";
import { SearchField } from "@/components/ui/search-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTabTruckLocationModel } from "./TabTruckLocationModel";
import { TabTruckLocationPrintReport } from "./TabTruckLocationPrintReport";

export function TabTruckLocation() {
  const m = useTabTruckLocationModel();

  if (m.isLoading)
    return (
      <div className="space-y-4">
        {m.modeSelector}
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-60 w-full rounded-2xl" />
      </div>
    );

  if (m.isError)
    return (
      <div className="space-y-3">
        {m.modeSelector}
        <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-semibold">Failed to load container data</div>
            <div className="mt-0.5 text-xs">{(m.error as Error)?.message ?? "Network or server error."}</div>
          </div>
        </div>
      </div>
    );

  return (
    <div className="space-y-4 pb-5">
      {/* Visual treatment adapts automatically to the application's light and dark themes. */}
      <div className="relative isolate overflow-hidden rounded-2xl border border-violet-200/70 bg-gradient-to-r from-violet-50 via-background to-indigo-50 p-4 shadow-sm dark:border-violet-500/20 dark:from-[#21123d] dark:via-[#17142f] dark:to-[#101d37] sm:p-5">
        <div className="pointer-events-none absolute -right-8 -top-24 h-64 w-64 rounded-full border border-violet-500/15 bg-violet-500/5" />
        <div className="pointer-events-none absolute right-16 top-[-7rem] h-64 w-64 rounded-full border border-violet-500/10" />
        <div className="relative flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white shadow-lg shadow-violet-500/20">
              <Truck className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-bold tracking-tight sm:text-2xl">Tracking</h2>
              <p className="text-xs text-muted-foreground sm:text-sm">Container movement, trucks and locations</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 rounded-full border border-violet-300/50 bg-background/60 px-3 py-1.5 text-xs font-medium text-violet-700 dark:border-violet-400/25 dark:bg-white/5 dark:text-violet-200 sm:flex">
            <MapPin className="h-3.5 w-3.5" />
            Truck / Location
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-3 xl:grid-cols-[minmax(280px,1fr)_repeat(3,minmax(0,190px))]">
        <div className="flex min-w-0 items-center rounded-xl border border-border/70 bg-card/70 px-3 py-2.5 shadow-sm lg:col-span-3 xl:col-span-1">
          {m.modeSelector}
        </div>
        <button
          type="button"
          aria-pressed={m.truckView === "with"}
          onClick={() => m.setTruckView("with")}
          data-testid="git-trucks-view-with"
          className={cn(
            "flex items-center gap-3 rounded-xl border p-3 text-left shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            m.truckView === "with"
              ? "border-violet-400/60 bg-violet-50 dark:border-violet-500/50 dark:bg-violet-500/15"
              : "border-border/70 bg-card hover:bg-muted/50"
          )}
        >
          <span className="rounded-lg bg-violet-500/10 p-2 text-violet-600 dark:text-violet-300">
            <Truck className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-[11px] text-muted-foreground">With Truck</span>
            <strong className="block text-xl leading-tight tabular-nums">{m.withTruck.length}</strong>
          </span>
        </button>
        <button
          type="button"
          aria-pressed={m.truckView === "without"}
          onClick={() => m.setTruckView("without")}
          data-testid="git-trucks-view-without"
          className={cn(
            "flex items-center gap-3 rounded-xl border p-3 text-left shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            m.truckView === "without"
              ? "border-sky-400/60 bg-sky-50 dark:border-sky-500/50 dark:bg-sky-500/15"
              : "border-border/70 bg-card hover:bg-muted/50"
          )}
        >
          <span className="rounded-lg bg-sky-500/10 p-2 text-sky-600 dark:text-sky-300">
            <Truck className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-[11px] text-muted-foreground">No Truck</span>
            <strong className="block text-xl leading-tight tabular-nums">{m.noTruck.length}</strong>
          </span>
        </button>
        <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-card p-3 shadow-sm">
          <span className="rounded-lg bg-emerald-500/10 p-2 text-emerald-600 dark:text-emerald-300">
            <Warehouse className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-[11px] text-muted-foreground">Shops</span>
            <strong className="block text-xl leading-tight tabular-nums">{m.shops.length}</strong>
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card p-2.5 shadow-sm">
        <SearchField
          value={m.searchQuery}
          onValueChange={m.setSearchQuery}
          placeholder="Search container, plate, supplier, location..."
          aria-label="Search tracking containers"
          data-testid="git-trucks-search"
          wrapperClassName="min-w-[210px] flex-1"
          className="h-9 rounded-lg"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={m.showFilters}
          onClick={() => m.setShowFilters(!m.showFilters)}
          className="h-9 rounded-lg"
          data-testid="git-trucks-filters-toggle"
        >
          <SlidersHorizontal className="mr-1.5 h-4 w-4" />
          Filters{m.activeFilterCount > 0 ? " (" + m.activeFilterCount + ")" : ""}
        </Button>
        {!m.restrictedViewer && (
          <Button
            size="sm"
            onClick={m.sendToWhatsApp}
            disabled={m.waSending || m.withTruck.length === 0}
            data-testid="button-send-wa-truck-location"
            className="h-9 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500"
          >
            {m.waSending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <MessageCircle className="mr-1.5 h-4 w-4" />
            )}
            {m.waSending ? "Sending…" : "Send to WhatsApp"}
          </Button>
        )}
      </div>

      {m.showFilters && (
        <div
          className="flex flex-wrap items-end gap-3 rounded-xl border border-border/70 bg-muted/20 p-3"
          data-testid="git-trucks-filters"
        >
          <label className="min-w-[160px] flex-1 space-y-1 text-xs font-medium text-muted-foreground">
            Status
            <Select value={m.statusFilter} onValueChange={m.setStatusFilter}>
              <SelectTrigger aria-label="Filter by status" className="h-9 w-full rounded-lg text-sm text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {m.statusOptions.map((status) => (
                  <SelectItem key={status} value={status}>
                    {status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="min-w-[160px] flex-1 space-y-1 text-xs font-medium text-muted-foreground">
            Shop
            <Select value={m.shopFilter} onValueChange={m.setShopFilter}>
              <SelectTrigger aria-label="Filter by shop" className="h-9 w-full rounded-lg text-sm text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All shops</SelectItem>
                {m.shopOptions.map((shop) => (
                  <SelectItem key={shop} value={shop}>
                    {shop}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 rounded-lg"
            onClick={() => m.setTruckView("all")}
          >
            All Containers
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-9 rounded-lg" onClick={m.resetFilters}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 px-0.5 text-xs text-muted-foreground">
        <span>
          Showing <strong className="font-semibold text-foreground">{m.visibleRows.length}</strong> of{" "}
          {m.allContainers.length} containers
        </span>
        {m.truckView === "all" && <span>All containers · With and without trucks</span>}
      </div>

      {m.visibleRows.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-4 py-12 text-center text-sm text-muted-foreground">
          {m.allContainers.length === 0
            ? "No active containers found."
            : "No containers match the selected view or filters."}
        </div>
      )}

      {/* Phones retain the concise cards, with the same live search, scope and filters. */}
      {m.isPhone && m.visibleRows.length > 0 && (
        <div className="space-y-4" data-testid="git-trucks-cards">
          {m.visibleShops.map((shop, shopIndex) => {
            const shopRows = m.visibleRows.filter((r) => (r.shopName ?? r.companyName ?? "Unknown") === shop);
            const supplierGroups = groupBySupplier(shopRows);
            return (
              <section key={shop} className="space-y-2" data-testid={"git-trucks-shop-" + shop}>
                <h3
                  className={cn(
                    "rounded-xl border px-3 py-3 text-center text-sm font-bold uppercase tracking-wide text-white shadow-sm",
                    shopIndex % 2 === 0
                      ? "border-violet-500/40 bg-gradient-to-r from-violet-800 to-purple-600"
                      : "border-blue-500/40 bg-gradient-to-r from-blue-800 to-blue-600"
                  )}
                >
                  <span className="block">{shop}</span>
                  <span className="mt-1 block text-[11px] font-medium normal-case opacity-85">
                    {shopRows.length} container{shopRows.length !== 1 ? "s" : ""}
                  </span>
                </h3>
                {supplierGroups.map(({ name: supplierName, rows: supplierRows }) => (
                  <div key={supplierName} className="space-y-2">
                    {supplierGroups.length > 1 && (
                      <p className="px-1 text-center text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                        {supplierName} — {supplierRows.length}
                      </p>
                    )}
                    <ErpMobileRecordList>
                      {supplierRows.map((r) => (
                        <ErpMobileRecordCard
                          key={r.id}
                          data-testid={"git-truck-card-" + r.id}
                          title={<span className="font-mono">{r.containerNumber}</span>}
                          subtitle={r.supplierCode ?? supplierName}
                          badges={
                            <span
                              className={cn(
                                "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                                (STATUS_BADGE_MAP as Record<string, string>)[r.status] ?? "bg-muted text-foreground"
                              )}
                            >
                              {r.status}
                            </span>
                          }
                          fields={[
                            {
                              label: "Truck / Plate",
                              value: <span className="font-mono">{r.numberPlate ?? "—"}</span>,
                            },
                            { label: "Location", value: r.trackingLocation ?? "—" },
                            { label: "Agent", value: r.agent ?? "—" },
                            { label: "Transporter", value: r.transporter ?? "—" },
                          ]}
                        />
                      ))}
                    </ErpMobileRecordList>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      )}

      {/* Center the shop names in full-width branded bars; keep the counts off to the right. */}
      {!m.isPhone && m.visibleRows.length > 0 && (
        <div
          className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm"
          data-testid="git-trucks-table"
        >
          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-border bg-slate-100/80 text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:bg-[#20223c] dark:text-slate-200">
                  <th className="px-3 py-3 text-center">Container #</th>
                  <th className="px-3 py-3 text-center">Supplier</th>
                  <th className="px-3 py-3 text-center">Number Plate</th>
                  <th className="px-3 py-3 text-center">Location</th>
                  <th className="px-3 py-3 text-center">Agent</th>
                  <th className="px-3 py-3 text-center">Transporter</th>
                  <th className="px-3 py-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody>
                {m.visibleShops.flatMap((shop, shopIndex) => {
                  const shopRows = m.visibleRows.filter((r) => (r.shopName ?? r.companyName ?? "Unknown") === shop);
                  const supplierGroups = groupBySupplier(shopRows);
                  const shopHeader = (
                    <tr key={"shop-" + shop}>
                      <td colSpan={7} className="px-1.5 py-1.5">
                        <div
                          className={cn(
                            "relative flex min-h-10 items-center rounded-lg border px-3 py-2 text-white shadow-sm",
                            shopIndex % 2 === 0
                              ? "border-violet-500/40 bg-gradient-to-r from-violet-800 via-purple-700 to-violet-700"
                              : "border-blue-500/40 bg-gradient-to-r from-blue-800 via-blue-700 to-indigo-700"
                          )}
                        >
                          <Warehouse className="absolute left-3 h-4 w-4 opacity-85" aria-hidden="true" />
                          <span className="mx-auto px-5 text-center text-sm font-extrabold uppercase tracking-wide">
                            {shop}
                          </span>
                          <span className="absolute right-3 hidden rounded-full border border-white/30 bg-white/10 px-2.5 py-0.5 text-[11px] font-semibold sm:inline-flex">
                            {shopRows.length} container{shopRows.length !== 1 ? "s" : ""}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                  const supplierRows = supplierGroups.flatMap(({ name: supplierName, rows: supplierContainers }) => {
                    const groupHeader =
                      supplierGroups.length > 1 ? (
                        <tr
                          key={"supplier-" + shop + "-" + supplierName}
                          className="border-y border-border/50 bg-muted/40"
                        >
                          <td
                            colSpan={7}
                            className="px-3 py-1.5 text-center text-[11px] font-bold uppercase tracking-widest text-muted-foreground"
                          >
                            {supplierName} — {supplierContainers.length}
                          </td>
                        </tr>
                      ) : null;
                    const dataRows = supplierContainers.map((r) => (
                      <tr
                        key={r.id}
                        className="border-b border-border/50 transition-colors last:border-b-0 hover:bg-violet-50/70 dark:hover:bg-violet-500/10"
                      >
                        <td className="px-3 py-2 text-center font-mono font-semibold tracking-tight">
                          {r.containerNumber}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {r.supplierCode ?? <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2 text-center font-mono">
                          {r.numberPlate ?? <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {r.trackingLocation ?? <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {r.agent ?? <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {r.transporter ?? <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span
                            className={cn(
                              "inline-flex min-w-12 justify-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                              (STATUS_BADGE_MAP as Record<string, string>)[r.status] ?? "bg-muted text-foreground"
                            )}
                          >
                            {r.status}
                          </span>
                        </td>
                      </tr>
                    ));
                    return groupHeader ? [groupHeader, ...dataRows] : dataRows;
                  });
                  return [shopHeader, ...supplierRows];
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Hidden Full-HD print template for WhatsApp image capture */}
      <TabTruckLocationPrintReport m={m} />
    </div>
  );
}
