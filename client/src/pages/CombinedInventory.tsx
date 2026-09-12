import { useState, useMemo } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Layers, Search, ChevronRight, ArrowLeft, List, FolderOpen, Download, Loader2, RefreshCw } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";
import { PageHeader } from "@/components/PageHeader";

interface ContainerPoItem {
  quantity?: string;
  rate?: string;
  stockItemName?: string;
  itemName?: string;
  stockItemId?: number | null;
  stockGroupId?: number | null;
  stockGroupName?: string;
}

interface ContainerDetailPayload {
  pos?: { items?: ContainerPoItem[] }[];
}

interface Container {
  id: number;
  status: string;
}

interface InventoryRow {
  stockItemId: number;
  stockItemName: string;
  stockItemCode: string;
  quantity: string;
  averageRate: string;
  totalValue: string;
  stockGroupId: number | null;
  stockGroupName: string;
}

interface StockItem {
  id: number;
  name: string;
  code?: string;
  stockGroupId?: number | null;
  stockGroupName?: string;
}

interface CombinedRow {
  stockItemId: number | null;
  stockItemName: string;
  stockGroupId: number | null;
  stockGroupName: string;
  otwQty: number;
  inHandQty: number;
  totalQty: number;
  inHandValue: number;
  otwWeightedCostSum: number;
  avgRate: number;
  combinedValue: number;
}

interface StockGroupSummary {
  stockGroupId: number | null;
  stockGroupName: string;
  itemCount: number;
  otwQty: number;
  inHandQty: number;
  totalQty: number;
  inHandValue: number;
  combinedValue: number;
}

type ViewMode = "groups" | "all";

export default function CombinedInventory() {
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("groups");
  const [selectedGroupId, setSelectedGroupId] = useState<number | null | undefined>(undefined);
  const [includeZero, setIncludeZero] = useState(false);
  const { formatAmount } = useCurrencyContext();
  const appMode = useAppMode();
  const _modeApiRequest = getApiRequest(appMode);
  const { selectedCompany } = useCompany();

  const { data: containers = [], isLoading: loadingContainers } = useQuery<Container[]>({
    queryKey: ["/api/containers"],
  });

  const otwContainers = useMemo(() => containers.filter((c) => c.status === "OTW"), [containers]);

  const containerDetailsQueries = useQueries({
    queries: otwContainers.map((container) => ({
      queryKey: [`/api/containers/${container.id}`],
      enabled: !!container.id,
    })),
  });

  const {
    data: inventoryPage,
    isLoading: loadingInventory,
    isFetching: isFetchingInventory,
    refetch: refetchInventory,
  } = useQuery<{ data: InventoryRow[]; total: number; page: number; pageSize: number; totalPages: number }>({
    // Include company ID so each company's data is cached separately and
    // cross-company cache reuse is impossible when switching companies.
    queryKey: ["/api/inventory", selectedCompany?.id],
    queryFn: async () => {
      const res = await fetch("/api/inventory?page=1&pageSize=100", { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: !!selectedCompany?.id,
    // Long stale time — combined inventory is large; only re-download when the
    // user explicitly clicks Refresh, not on focus / mount / reconnect.
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: false,
  });

  const inventoryRows = useMemo(() => inventoryPage?.data ?? [], [inventoryPage?.data]);
  const inventoryTotal = inventoryPage?.total ?? 0;
  const inventoryTotalPages = inventoryPage?.totalPages ?? 1;

  const { data: allStockItems = [], isLoading: loadingStockItems } = useQuery<StockItem[]>({
    queryKey: ["/api/stock-items/light", selectedCompany?.id],
    enabled: includeZero,
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  // Only block on containers list + inventory — OTW details load progressively
  const isLoading = loadingContainers || loadingInventory || (includeZero && loadingStockItems);
  const isLoadingOtw = containerDetailsQueries.some((q) => q.isLoading);
  const loadedOtwCount = containerDetailsQueries.filter((q) => !q.isLoading && q.data).length;

  const combinedData = useMemo((): CombinedRow[] => {
    // Use string keys so we can handle null stockItemId gracefully.
    // Key strategy:
    //   - stockItemId is set (non-null, non-zero) → "id:N"
    //   - stockItemId is null/0 (legacy rows)     → "name:<normalised name>"
    const map = new Map<string, CombinedRow>();

    const idKey = (id: number | null | undefined) => (id != null && id !== 0 ? `id:${id}` : null);
    const nameKey = (name: string) => `name:${(name || "").toLowerCase().trim()}`;

    containerDetailsQueries.forEach((q) => {
      if (!q.data) return;
      const containerData = q.data as unknown as ContainerDetailPayload;
      containerData?.pos?.forEach((po) => {
        po.items?.forEach((item) => {
          const qty = parseFloat(item.quantity || "0");
          const rate = parseFloat(item.rate || "0");
          const itemName = item.stockItemName || item.itemName || "";
          const key = idKey(item.stockItemId) ?? nameKey(itemName);

          const existing = map.get(key);
          if (existing) {
            existing.otwQty += qty;
            existing.totalQty += qty;
            existing.otwWeightedCostSum += qty * rate;
          } else {
            map.set(key, {
              stockItemId: item.stockItemId ?? null,
              stockItemName: itemName,
              stockGroupId: item.stockGroupId ?? null,
              stockGroupName: item.stockGroupName || "",
              otwQty: qty,
              inHandQty: 0,
              totalQty: qty,
              inHandValue: 0,
              otwWeightedCostSum: qty * rate,
              avgRate: 0,
              combinedValue: 0,
            });
          }
        });
      });
    });

    inventoryRows.forEach((inv) => {
      const qty = parseFloat(inv.quantity || "0");
      const value = parseFloat(inv.totalValue || "0");

      // Try ID key first; if OTW data for this item was stored under a name
      // key (because its stockItemId was null at the time), find it that way.
      const primaryKey = idKey(inv.stockItemId);
      const fallbackKey = nameKey(inv.stockItemName);
      let key = primaryKey ?? fallbackKey;

      if (primaryKey && !map.has(primaryKey) && map.has(fallbackKey)) {
        // The OTW entry exists under the name key — promote it to the ID key.
        const otwEntry = map.get(fallbackKey)!;
        otwEntry.stockItemId = inv.stockItemId;
        if (!otwEntry.stockGroupId && inv.stockGroupId) {
          otwEntry.stockGroupId = inv.stockGroupId;
          otwEntry.stockGroupName = inv.stockGroupName;
        }
        map.set(primaryKey, otwEntry);
        map.delete(fallbackKey);
        key = primaryKey;
      }

      const existing = map.get(key);
      if (existing) {
        existing.inHandQty += qty;
        existing.totalQty += qty;
        existing.inHandValue += value;
        // Backfill group info if the OTW entry lacked it
        if (!existing.stockGroupId && inv.stockGroupId) {
          existing.stockGroupId = inv.stockGroupId;
          existing.stockGroupName = inv.stockGroupName;
        }
        // Prefer the canonical name from inventory (from stockItems.name join)
        if (!existing.stockItemName && inv.stockItemName) {
          existing.stockItemName = inv.stockItemName;
        }
      } else {
        map.set(key, {
          stockItemId: inv.stockItemId,
          stockItemName: inv.stockItemName,
          stockGroupId: inv.stockGroupId ?? null,
          stockGroupName: inv.stockGroupName || "",
          otwQty: 0,
          inHandQty: qty,
          totalQty: qty,
          inHandValue: value,
          otwWeightedCostSum: 0,
          avgRate: 0,
          combinedValue: 0,
        });
      }
    });

    if (includeZero) {
      allStockItems.forEach((item) => {
        const zeroKey = `id:${item.id}`;
        if (!map.has(zeroKey)) {
          map.set(zeroKey, {
            stockItemId: item.id,
            stockItemName: item.name,
            stockGroupId: item.stockGroupId ?? null,
            stockGroupName: item.stockGroupName || "",
            otwQty: 0,
            inHandQty: 0,
            totalQty: 0,
            inHandValue: 0,
            otwWeightedCostSum: 0,
            avgRate: 0,
            combinedValue: 0,
          });
        }
      });
    }

    map.forEach((row) => {
      if (row.inHandQty > 0) {
        row.avgRate = row.inHandValue / row.inHandQty;
      } else if (row.otwQty > 0 && row.otwWeightedCostSum > 0) {
        row.avgRate = row.otwWeightedCostSum / row.otwQty;
      } else {
        row.avgRate = 0;
      }
      row.combinedValue = row.avgRate * row.totalQty;
    });

    return Array.from(map.values()).sort((a, b) => a.stockItemName.localeCompare(b.stockItemName));
  }, [containerDetailsQueries, inventoryRows, allStockItems, includeZero]);

  const searchLower = search.trim().toLowerCase();

  const filteredAll = useMemo(() => {
    if (!searchLower) return combinedData;
    return combinedData.filter((r) => r.stockItemName.toLowerCase().includes(searchLower));
  }, [combinedData, searchLower]);

  const stockGroups = useMemo((): StockGroupSummary[] => {
    const groupMap = new Map<string, StockGroupSummary>();
    const key = (id: number | null) => (id === null ? "__null__" : String(id));

    filteredAll.forEach((row) => {
      const k = key(row.stockGroupId);
      const existing = groupMap.get(k);
      if (existing) {
        existing.itemCount += 1;
        existing.otwQty += row.otwQty;
        existing.inHandQty += row.inHandQty;
        existing.totalQty += row.totalQty;
        existing.inHandValue += row.inHandValue;
        existing.combinedValue += row.combinedValue;
      } else {
        groupMap.set(k, {
          stockGroupId: row.stockGroupId,
          stockGroupName: row.stockGroupName || "Uncategorized",
          itemCount: 1,
          otwQty: row.otwQty,
          inHandQty: row.inHandQty,
          totalQty: row.totalQty,
          inHandValue: row.inHandValue,
          combinedValue: row.combinedValue,
        });
      }
    });

    return Array.from(groupMap.values()).sort((a, b) => a.stockGroupName.localeCompare(b.stockGroupName));
  }, [filteredAll]);

  const groupItems = useMemo(() => {
    if (selectedGroupId === undefined) return [];
    return filteredAll.filter((r) => r.stockGroupId === selectedGroupId);
  }, [filteredAll, selectedGroupId]);

  const totals = useMemo(
    () => ({
      items: filteredAll.length,
      otwQty: filteredAll.reduce((s, r) => s + r.otwQty, 0),
      inHandQty: filteredAll.reduce((s, r) => s + r.inHandQty, 0),
      totalQty: filteredAll.reduce((s, r) => s + r.totalQty, 0),
      combinedValue: filteredAll.reduce((s, r) => s + r.combinedValue, 0),
    }),
    [filteredAll]
  );

  const drillGroup = selectedGroupId !== undefined ? stockGroups.find((g) => g.stockGroupId === selectedGroupId) : null;

  const isDrillMode = viewMode === "groups" && selectedGroupId !== undefined;

  const handleExport = async () => {
    const XLSX = await import("@/lib/excelHelper");
    const exportRows = isDrillMode ? groupItems : filteredAll;
    const wsData = [
      ["Item Name", "Stock Group", "OTW Qty", "In-Hand Qty", "Total Qty", "Avg Rate", "Total Value"],
      ...exportRows.map((r) => [
        r.stockItemName,
        r.stockGroupName || "Uncategorized",
        r.otwQty,
        r.inHandQty,
        r.totalQty,
        parseFloat(r.avgRate.toFixed(2)),
        parseFloat(r.combinedValue.toFixed(2)),
      ]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws["!cols"] = [{ wch: 35 }, { wch: 20 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Combined Inventory");
    const filename = isDrillMode
      ? `combined_inventory_${(drillGroup?.stockGroupName || "group").replace(/\s+/g, "_")}.xlsx`
      : "combined_inventory.xlsx";
    await XLSX.writeFile(wb, filename);
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-10 w-32 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-10 w-full rounded-md" />
        <div className="space-y-2">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      {isDrillMode ? (
        <div className="flex items-center gap-3">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setSelectedGroupId(undefined)}
            data-testid="button-back-to-groups"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-0.5">
              <button className="hover:text-foreground transition-colors" onClick={() => setSelectedGroupId(undefined)}>
                Combined Inventory
              </button>
              <ChevronRight className="h-3 w-3" />
              <span className="text-foreground font-medium">{drillGroup?.stockGroupName}</span>
            </div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <FolderOpen className="h-5 w-5 text-muted-foreground" />
              {drillGroup?.stockGroupName}
            </h1>
          </div>
        </div>
      ) : (
        <PageHeader
          title="Combined Inventory"
          subtitle="In-transit (OTW) + in-hand stock combined per item"
          icon={<Layers className="h-5 w-5" />}
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetchInventory()}
            disabled={isFetchingInventory}
            data-testid="button-refresh-inventory"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5${isFetchingInventory ? " animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={handleExport} data-testid="button-export-excel">
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export Excel
          </Button>
        </PageHeader>
      )}

      {/* Stats bar */}
      <div className="flex flex-wrap gap-3">
        <div className="flex items-center gap-2 bg-muted/60 rounded-lg px-3 py-2">
          <span className="text-sm font-semibold" data-testid="stat-items">
            {totals.items.toLocaleString()}
          </span>
          <span className="text-xs text-muted-foreground">Items</span>
        </div>
        <div className="flex items-center gap-2 bg-blue-500/10 rounded-lg px-3 py-2">
          {isLoadingOtw ? <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" /> : null}
          <span className="text-sm font-semibold font-mono text-blue-700 dark:text-blue-300" data-testid="stat-otw">
            {formatNumber(totals.otwQty, 0)}
          </span>
          <span className="text-xs text-muted-foreground">
            OTW Qty{isLoadingOtw ? ` (${loadedOtwCount}/${otwContainers.length})` : ""}
          </span>
        </div>
        <div className="flex items-center gap-2 bg-muted/60 rounded-lg px-3 py-2">
          <span className="text-sm font-semibold font-mono" data-testid="stat-inhand">
            {formatNumber(totals.inHandQty, 0)}
          </span>
          <span className="text-xs text-muted-foreground">In-Hand Qty</span>
        </div>
        <div className="flex items-center gap-2 bg-muted/60 rounded-lg px-3 py-2">
          <span className="text-sm font-semibold font-mono" data-testid="stat-total">
            {formatNumber(totals.totalQty, 0)}
          </span>
          <span className="text-xs text-muted-foreground">Total Qty</span>
        </div>
        <div className="flex items-center gap-2 bg-primary/10 rounded-lg px-3 py-2">
          <span className="text-sm font-semibold font-mono text-primary">{formatAmount(totals.combinedValue)}</span>
          <span className="text-xs text-muted-foreground">Total Value</span>
        </div>
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={isDrillMode ? "Search items in this group..." : "Search stock items..."}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
            data-testid="input-search-combined"
          />
        </div>
        {!isDrillMode && (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={viewMode === "groups" ? "default" : "outline"}
              onClick={() => {
                setViewMode("groups");
                setSelectedGroupId(undefined);
              }}
              data-testid="button-view-groups"
            >
              <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
              By Group
            </Button>
            <Button
              size="sm"
              variant={viewMode === "all" ? "default" : "outline"}
              onClick={() => setViewMode("all")}
              data-testid="button-view-all"
            >
              <List className="h-3.5 w-3.5 mr-1.5" />
              View All
            </Button>
          </div>
        )}
        <label className="flex items-center gap-2 cursor-pointer select-none" data-testid="toggle-include-zero">
          <Checkbox checked={includeZero} onCheckedChange={(v) => setIncludeZero(!!v)} id="include-zero" />
          <span className="text-sm text-muted-foreground">Include zero stock</span>
        </label>
        {isDrillMode && (
          <Button variant="outline" size="sm" onClick={handleExport} data-testid="button-export-excel">
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export
          </Button>
        )}
      </div>

      {/* Partial-load notice — only shown when total rows exceed the first page */}
      {inventoryTotalPages > 1 && (
        <p className="text-xs text-muted-foreground -mt-2">
          Showing first {inventoryRows.length.toLocaleString()} of {inventoryTotal.toLocaleString()} inventory rows. Use
          search to narrow results, or click Refresh to reload.
        </p>
      )}

      {/* Content */}
      {viewMode === "groups" && !isDrillMode ? (
        <GroupsView
          groups={stockGroups}
          onSelectGroup={setSelectedGroupId}
          formatAmount={formatAmount}
          isLoadingOtw={isLoadingOtw}
        />
      ) : isDrillMode ? (
        <ItemsTable
          rows={groupItems}
          formatAmount={formatAmount}
          emptyMessage="No items match your search in this group."
        />
      ) : (
        <ItemsTable
          rows={filteredAll}
          formatAmount={formatAmount}
          emptyMessage="No stock items found. Try adjusting your search."
        />
      )}
    </div>
  );
}

function GroupsView({
  groups,
  onSelectGroup,
  formatAmount,
  isLoadingOtw: _isLoadingOtw,
}: {
  groups: StockGroupSummary[];
  onSelectGroup: (id: number | null) => void;
  formatAmount: (v: number) => string;
  isLoadingOtw: boolean;
}) {
  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-14 h-14 rounded-xl bg-muted/60 flex items-center justify-center mb-4">
          <Layers className="w-7 h-7 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold mb-1">No stock groups found</h2>
        <p className="text-sm text-muted-foreground">Try adjusting your search.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <div
          key={g.stockGroupId ?? "__null__"}
          className="bg-card border rounded-xl p-4 flex items-center gap-4 cursor-pointer hover-elevate"
          onClick={() => onSelectGroup(g.stockGroupId)}
          data-testid={`row-group-${g.stockGroupId ?? "null"}`}
        >
          {/* Icon */}
          <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <FolderOpen className="h-5 w-5 text-primary" />
          </div>

          {/* Name + item count */}
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm">{g.stockGroupName}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {g.itemCount} item{g.itemCount !== 1 ? "s" : ""}
            </p>
          </div>

          {/* Stats */}
          <div className="hidden sm:flex items-center gap-6 flex-shrink-0">
            <div className="text-right">
              <p className="text-xs text-muted-foreground">OTW</p>
              {g.otwQty > 0 ? (
                <p className="text-sm font-mono font-semibold text-blue-600 dark:text-blue-400">
                  {formatNumber(g.otwQty, 0)}
                </p>
              ) : (
                <p className="text-sm font-mono text-muted-foreground">—</p>
              )}
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">In-Hand</p>
              <p className="text-sm font-mono">{formatNumber(g.inHandQty, 0)}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Total</p>
              <p className="text-sm font-mono font-semibold">{formatNumber(g.totalQty, 0)}</p>
            </div>
            <div className="text-right hidden md:block">
              <p className="text-xs text-muted-foreground">Value</p>
              <p className="text-sm font-mono">{g.combinedValue > 0 ? formatAmount(g.combinedValue) : "—"}</p>
            </div>
          </div>

          {/* Mobile: show total qty only */}
          <div className="sm:hidden text-right flex-shrink-0">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-sm font-mono font-semibold">{formatNumber(g.totalQty, 0)}</p>
          </div>

          <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        </div>
      ))}

      {/* Totals footer */}
      <div className="bg-muted/40 rounded-xl px-4 py-3 flex items-center gap-4">
        <div className="flex-1">
          <span className="text-sm font-semibold">
            Total ({groups.length} group{groups.length !== 1 ? "s" : ""})
          </span>
        </div>
        <div className="hidden sm:flex items-center gap-6 flex-shrink-0">
          <div className="text-right w-16">
            <p className="text-xs text-muted-foreground">OTW</p>
            <p className="text-sm font-mono font-semibold text-blue-600 dark:text-blue-400" data-testid="total-otw-qty">
              {formatNumber(
                groups.reduce((s, g) => s + g.otwQty, 0),
                0
              )}
            </p>
          </div>
          <div className="text-right w-20">
            <p className="text-xs text-muted-foreground">In-Hand</p>
            <p className="text-sm font-mono font-semibold" data-testid="total-inhand-qty">
              {formatNumber(
                groups.reduce((s, g) => s + g.inHandQty, 0),
                0
              )}
            </p>
          </div>
          <div className="text-right w-20">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-sm font-mono font-semibold" data-testid="total-combined-qty">
              {formatNumber(
                groups.reduce((s, g) => s + g.totalQty, 0),
                0
              )}
            </p>
          </div>
          <div className="text-right hidden md:block w-28">
            <p className="text-xs text-muted-foreground">Value</p>
            <p className="text-sm font-mono font-semibold" data-testid="total-combined-value">
              {formatAmount(groups.reduce((s, g) => s + g.combinedValue, 0))}
            </p>
          </div>
        </div>
        <div className="w-4 flex-shrink-0" />
      </div>
    </div>
  );
}

function ItemsTable({
  rows,
  formatAmount,
  emptyMessage,
}: {
  rows: CombinedRow[];
  formatAmount: (v: number) => string;
  emptyMessage: string;
}) {
  const totals = useMemo(
    () => ({
      otwQty: rows.reduce((s, r) => s + r.otwQty, 0),
      inHandQty: rows.reduce((s, r) => s + r.inHandQty, 0),
      totalQty: rows.reduce((s, r) => s + r.totalQty, 0),
      combinedValue: rows.reduce((s, r) => s + r.combinedValue, 0),
    }),
    [rows]
  );

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-14 h-14 rounded-xl bg-muted/60 flex items-center justify-center mb-4">
          <Layers className="w-7 h-7 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold mb-1">No stock items found</h2>
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <>
      {/* Desktop table */}
      <div className="hidden md:block">
        <Table wrapperClassName="max-h-[calc(100vh-300px)]">
          <TableHeader className="bg-muted/40">
            <TableRow>
              <TableHead>Item Name</TableHead>
              <TableHead className="text-right">OTW Qty</TableHead>
              <TableHead className="text-right">In-Hand Qty</TableHead>
              <TableHead className="text-right">Total Qty</TableHead>
              <TableHead className="text-right">Avg Rate</TableHead>
              <TableHead className="text-right">Total Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.stockItemId ?? row.stockItemName}
                data-testid={`row-combined-${row.stockItemId ?? row.stockItemName}`}
              >
                <TableCell className="font-medium">
                  {row.stockItemName}
                  {row.stockGroupName && (
                    <span className="ml-2">
                      <Badge variant="outline" className="text-xs font-normal">
                        {row.stockGroupName}
                      </Badge>
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {row.otwQty > 0 ? (
                    <span className="text-blue-600 dark:text-blue-400 font-semibold">
                      {formatNumber(row.otwQty, 0)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {row.inHandQty > 0 ? (
                    formatNumber(row.inHandQty, 0)
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono font-semibold">{formatNumber(row.totalQty, 0)}</TableCell>
                <TableCell className="text-right font-mono text-muted-foreground">
                  {row.avgRate > 0 ? formatAmount(row.avgRate) : <span>—</span>}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {row.combinedValue > 0 ? (
                    formatAmount(row.combinedValue)
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter className="bg-muted/40">
            <TableRow className="font-semibold">
              <TableCell>
                Total ({rows.length} item{rows.length !== 1 ? "s" : ""})
              </TableCell>
              <TableCell className="text-right font-mono text-blue-600 dark:text-blue-400">
                {formatNumber(totals.otwQty, 0)}
              </TableCell>
              <TableCell className="text-right font-mono">{formatNumber(totals.inHandQty, 0)}</TableCell>
              <TableCell className="text-right font-mono">{formatNumber(totals.totalQty, 0)}</TableCell>
              <TableCell className="text-right font-mono"></TableCell>
              <TableCell className="text-right font-mono">{formatAmount(totals.combinedValue)}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {rows.map((row) => (
          <div
            key={row.stockItemId ?? row.stockItemName}
            className="bg-card border rounded-xl p-4"
            data-testid={`row-combined-${row.stockItemId ?? row.stockItemName}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-sm">{row.stockItemName}</p>
                {row.stockGroupName && <p className="text-xs text-muted-foreground mt-0.5">{row.stockGroupName}</p>}
              </div>
              <p className="text-sm font-mono font-semibold flex-shrink-0">
                {row.combinedValue > 0 ? formatAmount(row.combinedValue) : "—"}
              </p>
            </div>
            <div className="flex gap-4 mt-2 text-xs">
              {row.otwQty > 0 && (
                <div>
                  <span className="text-muted-foreground">OTW </span>
                  <span className="font-mono font-semibold text-blue-600 dark:text-blue-400">
                    {formatNumber(row.otwQty, 0)}
                  </span>
                </div>
              )}
              {row.inHandQty > 0 && (
                <div>
                  <span className="text-muted-foreground">In-Hand </span>
                  <span className="font-mono">{formatNumber(row.inHandQty, 0)}</span>
                </div>
              )}
              <div>
                <span className="text-muted-foreground">Total </span>
                <span className="font-mono font-semibold">{formatNumber(row.totalQty, 0)}</span>
              </div>
            </div>
          </div>
        ))}
        {/* Mobile total */}
        <div className="bg-muted/40 rounded-xl px-4 py-3 flex justify-between items-center">
          <span className="text-sm font-semibold">Total ({rows.length} items)</span>
          <div className="text-right">
            <p className="text-sm font-mono font-semibold">{formatAmount(totals.combinedValue)}</p>
            <p className="text-xs text-muted-foreground font-mono">{formatNumber(totals.totalQty, 0)} units</p>
          </div>
        </div>
      </div>
    </>
  );
}
