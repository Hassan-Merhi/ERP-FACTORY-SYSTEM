import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertCircle,
  Truck,
  Loader2,
  MessageCircle,
  Search,
  SlidersHorizontal,
  Building2,
  Layers3,
  MapPin,
  RotateCcw,
  Warehouse,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { gitContainersUrl, groupBySupplier } from "./helpers";
import type { GitContainersResponse, EnrichedContainerApi, CompanyViewMode } from "./types";
import { STATUS_BADGE as STATUS_BADGE_MAP } from "./types";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { ErpMobileRecordCard, ErpMobileRecordList } from "@/components/ui/erp-mobile-records";
import { isExistingRecordReadOnlyRole } from "@shared/createOnlyRolePolicy";

export function TabTruckLocation() {
  const { data: viewer } = useQuery(authenticatedUserQueryOptions());
  const role = viewer?.currentRole ?? viewer?.role;
  const isTester = role === "ERP Tester";
  const isViewer = isExistingRecordReadOnlyRole(role);
  const restrictedViewer = isTester || isViewer;
  const [companyMode, setCompanyMode] = useState<CompanyViewMode>("session");
  const [waSending, setWaSending] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [truckView, setTruckView] = useState<"with" | "without" | "all">("with");
  const [statusFilter, setStatusFilter] = useState("all");
  const [shopFilter, setShopFilter] = useState("all");
  const [showFilters, setShowFilters] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const isPhone = useErpPhoneLayout();

  const queryUrl = gitContainersUrl({ allCompanies: companyMode === "all", includeOffloaded: true });

  const { data, isLoading, isError, error } = useQuery<GitContainersResponse>({
    queryKey: [queryUrl],
    staleTime: 60_000,
    retry: 1,
  });

  const allContainers: EnrichedContainerApi[] = data?.containers ?? [];
  const withTruck = allContainers.filter((r) => !!(r.numberPlate ?? "").trim());
  const noTruck = allContainers.filter((r) => !(r.numberPlate ?? "").trim());
  const shops = [...new Set(withTruck.map((r) => r.shopName ?? r.companyName ?? "Unknown"))].sort();
  const shopOptions = [...new Set(allContainers.map((r) => r.shopName ?? r.companyName ?? "Unknown"))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
  );
  const statusOptions = [...new Set(allContainers.map((r) => r.status))].filter(Boolean).sort();
  const search = searchQuery.trim().toLocaleLowerCase();
  const visibleRows = allContainers.filter((row) => {
    const hasTruck = Boolean((row.numberPlate ?? "").trim());
    if (truckView === "with" && !hasTruck) return false;
    if (truckView === "without" && hasTruck) return false;
    if (statusFilter !== "all" && row.status !== statusFilter) return false;
    const shop = row.shopName ?? row.companyName ?? "Unknown";
    if (shopFilter !== "all" && shop !== shopFilter) return false;
    if (!search) return true;
    return [
      row.containerNumber,
      row.supplierCode,
      row.numberPlate,
      row.trackingLocation,
      row.agent,
      row.transporter,
      row.status,
      shop,
    ].some((value) =>
      String(value ?? "")
        .toLocaleLowerCase()
        .includes(search)
    );
  });
  const visibleShops = [...new Set(visibleRows.map((r) => r.shopName ?? r.companyName ?? "Unknown"))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
  );
  const activeFilterCount = Number(statusFilter !== "all") + Number(shopFilter !== "all");

  function resetFilters() {
    setSearchQuery("");
    setTruckView("with");
    setStatusFilter("all");
    setShopFilter("all");
  }

  async function sendToWhatsApp() {
    if (!printRef.current) return;
    setWaSending(true);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const el = printRef.current;
      const sourceCanvas = await html2canvas(el, {
        scale: 1,
        useCORS: true,
        allowTaint: true,
        backgroundColor: "#f8fafc",
        logging: false,
        width: el.scrollWidth,
        height: el.scrollHeight,
        windowWidth: el.scrollWidth,
        windowHeight: el.scrollHeight,
      });

      const today = new Date().toISOString().substring(0, 10);
      const fileName = `TruckLocation_${today}.jpg`;
      // The API has a 2 MB JSON body limit. Base64 expands binary data by ~33%,
      // so enforce the actual serialized request size instead of estimating only
      // the decoded JPEG size. Keep headroom for middleware/proxy overhead.
      const MAX_JSON_BYTES = 1.55 * 1024 * 1024;
      const dimensionScales = [1, 0.86, 0.72, 0.6, 0.5];
      const qualities = [0.78, 0.64, 0.52, 0.42, 0.34];
      let imageBase64 = "";

      outer: for (const scale of dimensionScales) {
        let candidateCanvas = sourceCanvas;
        if (scale !== 1) {
          candidateCanvas = document.createElement("canvas");
          candidateCanvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
          candidateCanvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));
          const context = candidateCanvas.getContext("2d");
          if (!context) continue;
          context.drawImage(sourceCanvas, 0, 0, candidateCanvas.width, candidateCanvas.height);
        }

        for (const quality of qualities) {
          const candidate = candidateCanvas.toDataURL("image/jpeg", quality);
          const payloadBytes = new TextEncoder().encode(
            JSON.stringify({ imageBase64: candidate, fileName })
          ).byteLength;
          if (payloadBytes <= MAX_JSON_BYTES) {
            imageBase64 = candidate;
            break outer;
          }
        }
      }

      if (!imageBase64) {
        toast({
          title: "Failed to send",
          description: "The tracking report is too large to fit in one WhatsApp image even after compression.",
          variant: "destructive",
        });
        return;
      }

      try {
        await apiRequest("POST", "/api/git/send-containers-whatsapp", {
          imageBase64,
          fileName,
        });
      } catch (apiErr) {
        const msg =
          getErrorDetails(apiErr).status === 413 ||
          String(getErrorDetails(apiErr).optionalMessage).toLowerCase().includes("too large")
            ? "Tracking report is still too large to send to WhatsApp."
            : (getErrorDetails(apiErr).optionalMessage ?? "Failed to send");
        toast({ title: "Failed to send", description: msg, variant: "destructive" });
        return;
      }

      toast({ title: "Sent", description: "Truck / Location report sent to WhatsApp group." });
    } catch (err) {
      toast({ title: "Failed to send", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setWaSending(false);
    }
  }

  const modeSelector = (
    <div className="flex min-w-0 flex-wrap items-center gap-2 max-sm:grid max-sm:grid-cols-2 max-sm:[&>button]:h-auto max-sm:[&>button]:whitespace-normal max-sm:[&>button]:py-2">
      <span className="mr-1 hidden text-xs font-medium text-muted-foreground sm:inline">Viewing</span>
      <Button
        size="sm"
        variant={companyMode === "session" ? "default" : "outline"}
        className={cn(
          "rounded-lg shadow-none",
          companyMode === "session" &&
            "bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-600 dark:hover:bg-violet-500"
        )}
        onClick={() => setCompanyMode("session")}
        data-testid="btn-truck-mode-session"
      >
        <Building2 className="mr-1.5 h-3.5 w-3.5" />
        My Company
      </Button>
      {!restrictedViewer && (
        <Button
          size="sm"
          variant={companyMode === "all" ? "default" : "outline"}
          className={cn(
            "rounded-lg shadow-none",
            companyMode === "all" &&
              "bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-600 dark:hover:bg-violet-500"
          )}
          onClick={() => setCompanyMode("all")}
          data-testid="btn-truck-mode-all"
        >
          <Layers3 className="mr-1.5 h-3.5 w-3.5" />
          All Accessible Companies
        </Button>
      )}
    </div>
  );

  if (isLoading)
    return (
      <div className="space-y-4">
        {modeSelector}
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-60 w-full rounded-2xl" />
      </div>
    );

  if (isError)
    return (
      <div className="space-y-3">
        {modeSelector}
        <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-semibold">Failed to load container data</div>
            <div className="mt-0.5 text-xs">{(error as Error)?.message ?? "Network or server error."}</div>
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
          {modeSelector}
        </div>
        <button
          type="button"
          aria-pressed={truckView === "with"}
          onClick={() => setTruckView("with")}
          data-testid="git-trucks-view-with"
          className={cn(
            "flex items-center gap-3 rounded-xl border p-3 text-left shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            truckView === "with"
              ? "border-violet-400/60 bg-violet-50 dark:border-violet-500/50 dark:bg-violet-500/15"
              : "border-border/70 bg-card hover:bg-muted/50"
          )}
        >
          <span className="rounded-lg bg-violet-500/10 p-2 text-violet-600 dark:text-violet-300">
            <Truck className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-[11px] text-muted-foreground">With Truck</span>
            <strong className="block text-xl leading-tight tabular-nums">{withTruck.length}</strong>
          </span>
        </button>
        <button
          type="button"
          aria-pressed={truckView === "without"}
          onClick={() => setTruckView("without")}
          data-testid="git-trucks-view-without"
          className={cn(
            "flex items-center gap-3 rounded-xl border p-3 text-left shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            truckView === "without"
              ? "border-sky-400/60 bg-sky-50 dark:border-sky-500/50 dark:bg-sky-500/15"
              : "border-border/70 bg-card hover:bg-muted/50"
          )}
        >
          <span className="rounded-lg bg-sky-500/10 p-2 text-sky-600 dark:text-sky-300">
            <Truck className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-[11px] text-muted-foreground">No Truck</span>
            <strong className="block text-xl leading-tight tabular-nums">{noTruck.length}</strong>
          </span>
        </button>
        <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-card p-3 shadow-sm">
          <span className="rounded-lg bg-emerald-500/10 p-2 text-emerald-600 dark:text-emerald-300">
            <Warehouse className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-[11px] text-muted-foreground">Shops</span>
            <strong className="block text-xl leading-tight tabular-nums">{shops.length}</strong>
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card p-2.5 shadow-sm">
        <div className="relative min-w-[210px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search container, plate, supplier, location..."
            aria-label="Search tracking containers"
            data-testid="git-trucks-search"
            className="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={showFilters}
          onClick={() => setShowFilters(!showFilters)}
          className="h-9 rounded-lg"
          data-testid="git-trucks-filters-toggle"
        >
          <SlidersHorizontal className="mr-1.5 h-4 w-4" />
          Filters{activeFilterCount > 0 ? " (" + activeFilterCount + ")" : ""}
        </Button>
        {!restrictedViewer && (
          <Button
            size="sm"
            onClick={sendToWhatsApp}
            disabled={waSending || withTruck.length === 0}
            data-testid="button-send-wa-truck-location"
            className="h-9 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500"
          >
            {waSending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <MessageCircle className="mr-1.5 h-4 w-4" />
            )}
            {waSending ? "Sending…" : "Send to WhatsApp"}
          </Button>
        )}
      </div>

      {showFilters && (
        <div
          className="flex flex-wrap items-end gap-3 rounded-xl border border-border/70 bg-muted/20 p-3"
          data-testid="git-trucks-filters"
        >
          <label className="min-w-[160px] flex-1 space-y-1 text-xs font-medium text-muted-foreground">
            Status
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              aria-label="Filter by status"
              className="block h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground"
            >
              <option value="all">All statuses</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-[160px] flex-1 space-y-1 text-xs font-medium text-muted-foreground">
            Shop
            <select
              value={shopFilter}
              onChange={(event) => setShopFilter(event.target.value)}
              aria-label="Filter by shop"
              className="block h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground"
            >
              <option value="all">All shops</option>
              {shopOptions.map((shop) => (
                <option key={shop} value={shop}>
                  {shop}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 rounded-lg"
            onClick={() => setTruckView("all")}
          >
            All Containers
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-9 rounded-lg" onClick={resetFilters}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 px-0.5 text-xs text-muted-foreground">
        <span>
          Showing <strong className="font-semibold text-foreground">{visibleRows.length}</strong> of{" "}
          {allContainers.length} containers
        </span>
        {truckView === "all" && <span>All containers · With and without trucks</span>}
      </div>

      {visibleRows.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-4 py-12 text-center text-sm text-muted-foreground">
          {allContainers.length === 0
            ? "No active containers found."
            : "No containers match the selected view or filters."}
        </div>
      )}

      {/* Phones retain the concise cards, with the same live search, scope and filters. */}
      {isPhone && visibleRows.length > 0 && (
        <div className="space-y-4" data-testid="git-trucks-cards">
          {visibleShops.map((shop, shopIndex) => {
            const shopRows = visibleRows.filter((r) => (r.shopName ?? r.companyName ?? "Unknown") === shop);
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
      {!isPhone && visibleRows.length > 0 && (
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
                {visibleShops.flatMap((shop, shopIndex) => {
                  const shopRows = visibleRows.filter((r) => (r.shopName ?? r.companyName ?? "Unknown") === shop);
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
      <div
        ref={printRef}
        style={{
          position: "absolute",
          left: "-9999px",
          top: 0,
          backgroundColor: "#f8fafc",
          color: "#1e293b",
          fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
          fontSize: "22px",
          width: "1600px",
          padding: "44px 48px 36px",
          boxSizing: "border-box",
        }}
        aria-hidden="true"
      >
        <div
          style={{
            textAlign: "center",
            marginBottom: "32px",
            paddingBottom: "24px",
            borderBottom: "5px solid #f59e0b",
          }}
        >
          <div
            style={{ fontSize: "52px", fontWeight: 900, color: "#0f172a", letterSpacing: "-0.5px", lineHeight: 1.15 }}
          >
            HMD International Group
          </div>
          <div
            style={{
              fontSize: "26px",
              fontWeight: 700,
              color: "#b45309",
              marginTop: "10px",
              letterSpacing: "1.2px",
              textTransform: "uppercase",
            }}
          >
            Truck / Location Status — Live Tracking Report
          </div>
          <div style={{ fontSize: "22px", color: "#475569", marginTop: "12px", fontWeight: 500 }}>
            {new Date().toLocaleDateString("en-GB", {
              weekday: "long",
              day: "2-digit",
              month: "long",
              year: "numeric",
            })}
            {" · "}
            {new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}
          </div>
          <div
            style={{
              display: "inline-block",
              marginTop: "16px",
              padding: "10px 28px",
              backgroundColor: "#fef3c7",
              border: "2px solid #f59e0b",
              borderRadius: "28px",
              fontSize: "22px",
              fontWeight: 800,
              color: "#78350f",
            }}
          >
            {withTruck.length} Container{withTruck.length !== 1 ? "s" : ""} on the road
          </div>
        </div>

        {(() => {
          const allShops = [...new Set(withTruck.map((r) => r.shopName ?? r.companyName ?? "Unknown"))].sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
          );
          const cell: React.CSSProperties = {
            padding: "16px 14px",
            fontSize: "22px",
            overflow: "hidden",
            whiteSpace: "nowrap",
            borderBottom: "1px solid #cbd5e1",
            color: "#1e293b",
          };
          const hdrCols = [
            { label: "#", align: "center" as const },
            { label: "Container #", align: "center" as const },
            { label: "Supplier", align: "center" as const },
            { label: "Truck #", align: "center" as const },
            { label: "Location", align: "center" as const },
            { label: "Agent", align: "center" as const },
            { label: "Transporter", align: "center" as const },
            { label: "Status", align: "center" as const },
          ];
          return (
            <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: "52px" }} />
                <col style={{ width: "270px" }} />
                <col style={{ width: "230px" }} />
                <col style={{ width: "210px" }} />
                <col style={{ width: "240px" }} />
                <col style={{ width: "180px" }} />
                <col style={{ width: "230px" }} />
                <col style={{ width: "92px" }} />
              </colgroup>
              <thead>
                <tr style={{ backgroundColor: "#1e3a5f" }}>
                  {hdrCols.map((h) => (
                    <th
                      key={h.label}
                      style={{
                        padding: "18px 14px",
                        textAlign: h.align,
                        color: "#ffffff",
                        fontWeight: 700,
                        fontSize: "20px",
                        textTransform: "uppercase",
                        letterSpacing: "0.8px",
                      }}
                    >
                      {h.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allShops.flatMap((shop) => {
                  const shopRows = withTruck.filter((r) => (r.shopName ?? r.companyName ?? "Unknown") === shop);
                  let idx = 0;
                  return [
                    <tr key={`hd-shop-${shop}`}>
                      <td
                        colSpan={8}
                        style={{
                          padding: "14px 16px",
                          backgroundColor: "#fef3c7",
                          fontWeight: 800,
                          color: "#78350f",
                          fontSize: "22px",
                          letterSpacing: "0.5px",
                          textAlign: "center",
                          textTransform: "uppercase",
                          borderTop: "3px solid #f59e0b",
                          borderBottom: "3px solid #f59e0b",
                        }}
                      >
                        {shop}
                        <span
                          style={{
                            fontWeight: 500,
                            color: "#92400e",
                            marginLeft: "14px",
                            fontSize: "19px",
                            textTransform: "none",
                          }}
                        >
                          ({shopRows.length} container{shopRows.length !== 1 ? "s" : ""})
                        </span>
                      </td>
                    </tr>,
                    ...shopRows.map((r) => {
                      idx++;
                      const rowBg = idx % 2 === 0 ? "#f1f5f9" : "#f8fafc";
                      return (
                        <tr key={`hd-row-${r.id}`} style={{ backgroundColor: rowBg }}>
                          <td style={{ ...cell, textAlign: "center", color: "#94a3b8", fontSize: "18px" }}>{idx}</td>
                          <td
                            style={{
                              ...cell,
                              textAlign: "center",
                              fontFamily: "monospace",
                              fontWeight: 700,
                              color: "#1d4ed8",
                            }}
                          >
                            {r.containerNumber}
                          </td>
                          <td style={{ ...cell, textAlign: "center", fontWeight: 500 }}>{r.supplierCode ?? "—"}</td>
                          <td
                            style={{
                              ...cell,
                              textAlign: "center",
                              fontFamily: "monospace",
                              fontWeight: 700,
                              color: "#6d28d9",
                            }}
                          >
                            {r.numberPlate ?? "—"}
                          </td>
                          <td style={{ ...cell, textAlign: "center", fontWeight: 700, color: "#065f46" }}>
                            {r.trackingLocation ?? "—"}
                          </td>
                          <td style={{ ...cell, textAlign: "center", fontWeight: 500 }}>{r.agent ?? "—"}</td>
                          <td style={{ ...cell, textAlign: "center", color: "#92400e", fontWeight: 700 }}>
                            {r.transporter ?? "—"}
                          </td>
                          <td style={{ ...cell, textAlign: "center" }}>
                            <span
                              style={{
                                display: "inline-block",
                                padding: "6px 10px",
                                borderRadius: "5px",
                                fontSize: "17px",
                                fontWeight: 800,
                                backgroundColor: "#dbeafe",
                                color: "#1e40af",
                                textTransform: "uppercase",
                                letterSpacing: "0.6px",
                              }}
                            >
                              {r.status}
                            </span>
                          </td>
                        </tr>
                      );
                    }),
                  ];
                })}
              </tbody>
            </table>
          );
        })()}

        <div
          style={{
            marginTop: "28px",
            paddingTop: "18px",
            borderTop: "1px solid #cbd5e1",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ fontSize: "16px", color: "#64748b" }}>
            HMD International Group — ERP System — Auto-generated report
          </div>
          <div style={{ fontSize: "16px", color: "#64748b" }}>
            {new Date().toISOString().replace("T", " ").substring(0, 16)} UTC
          </div>
        </div>
      </div>
    </div>
  );
}
