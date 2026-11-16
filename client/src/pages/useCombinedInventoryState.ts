// Extracted from ./CombinedInventory.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import { type ReactNode, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";

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

export interface CombinedRow {
  stockItemId: number | null;
  stockItemName: string;
  stockItemCode?: string | null;
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

export interface StockGroupSummary {
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

export interface CombinedInventoryProps {
  /** Extra page-level actions supplied by a host page (for example the OTW/Combined toggle). */
  headerActions?: ReactNode;
}

export function useCombinedInventoryState({ headerActions }: CombinedInventoryProps = {}) {
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("groups");
  const [selectedGroupId, setSelectedGroupId] = useState<number | null | undefined>(undefined);
  const [includeZero, setIncludeZero] = useState(false);
  const { formatAmount } = useCurrencyContext();
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

  const filteredAll = useMemo(() => {
    if (!search.trim()) return combinedData;
    return combinedData.filter((r) => searchAny(search, r.stockItemName, r.stockItemCode));
  }, [combinedData, search]);

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
  return {
    drillGroup,
    filteredAll,
    formatAmount,
    groupItems,
    handleExport,
    headerActions,
    includeZero,
    inventoryRows,
    inventoryTotal,
    inventoryTotalPages,
    isDrillMode,
    isFetchingInventory,
    isLoading,
    isLoadingOtw,
    loadedOtwCount,
    otwContainers,
    refetchInventory,
    search,
    setIncludeZero,
    setSearch,
    setSelectedGroupId,
    setViewMode,
    stockGroups,
    totals,
    viewMode,
  };
}
