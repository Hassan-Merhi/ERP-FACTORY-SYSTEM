// Extracted from ./StockOTW.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isBlockingQueryError } from "@/lib/abortError";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import type { Container } from "@shared/schema";
import { useCompany } from "@/contexts/CompanyContext";
import type { SpContainerWithLines } from "./containers/types";
import { exportStockOtwExcel } from "./stockotw/exportStockOtwExcel";
import {
  expandStockOtwWirePayload,
  type GroupedStockItem,
  type StockItem,
  type StockOtwWirePayload,
} from "@/lib/stockOtwWirePayload";

export function useStockOTWContentState({
  showCombined,
  onToggleCombined,
}: {
  showCombined: boolean;
  onToggleCombined: () => void;
}) {
  const { formatAmount } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const isSupplierPartner = selectedCompany?.companyType === "supplier_partner";
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedGrade, setSelectedGrade] = useState<string>("all");
  const [selectedCategory, setSelectedCategory] = useState<string[]>([]);
  const [selectedSupplier, setSelectedSupplier] = useState<string[]>([]);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [isExporting, setIsExporting] = useState(false);

  const {
    data: containers = [],
    isLoading: loadingContainers,
    error: containersError,
    refetch: refetchContainers,
  } = useQuery<Container[]>({
    // This page only needs OTW id/status/grandTotal. Keep the compact profile
    // in queryKey[0] because the shared React Query fetcher uses that element
    // as the literal request URL.
    queryKey: ["/api/containers?profile=otw-summary"],
  });

  // Single bulk query replaces the N-per-container useQueries fan-out
  const {
    data: otwItemsRaw = [],
    isLoading: loadingOtwItems,
    error: otwItemsError,
    refetch: refetchOtwItems,
  } = useQuery<StockOtwWirePayload, Error, StockItem[]>({
    // Request the dictionary-compressed contract explicitly. Production data
    // has thousands of item/container pairs, so even the older flat compact
    // profile can exceed the operational response budget.
    queryKey: ["/api/containers/otw-items?profile=stock-otw-v2"],
    select: expandStockOtwWirePayload,
  });

  // Native SP containers live outside regular ERP container/PO tables.
  const {
    data: spContainers = [],
    isLoading: loadingSpContainers,
    error: spContainersError,
    refetch: refetchSpContainers,
  } = useQuery<SpContainerWithLines[]>({
    queryKey: ["/api/sp/containers"],
    queryFn: async () => {
      const response = await fetch("/api/sp/containers", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load Supplier Partner containers");
      return response.json();
    },
    enabled: !!selectedCompany?.id && isSupplierPartner,
  });
  const otwContainers = useMemo(() => containers.filter((c) => c.status === "OTW"), [containers]);
  const spOtwContainers = useMemo(() => {
    const erpNumbers = new Set(otwContainers.map((c) => c.containerNumber?.trim().toUpperCase()).filter(Boolean));
    // An imported PO may have both a native SP and an ERP representation.
    return spContainers.filter(
      (c) => c.status === "open" && (!c.containerNumber || !erpNumbers.has(c.containerNumber.trim().toUpperCase()))
    );
  }, [otwContainers, spContainers]);
  const otwContainerCount = otwContainers.length + spOtwContainers.length;
  const isLoading = loadingContainers || loadingOtwItems || (isSupplierPartner && loadingSpContainers);
  // A failed background refetch leaves the last good data on screen and an error
  // beside it, and a cancelled request is not a failure at all. Report only what
  // actually left the page without data.
  const containersFailed = isBlockingQueryError(containersError, containers.length > 0);
  const otwItemsFailed = isBlockingQueryError(otwItemsError, otwItemsRaw.length > 0);
  const spContainersFailed = isSupplierPartner && isBlockingQueryError(spContainersError, spContainers.length > 0);
  const hasErrors = containersFailed || otwItemsFailed || spContainersFailed;

  const retryFailedQueries = () => {
    if (containersFailed) void refetchContainers();
    if (otwItemsFailed) void refetchOtwItems();
    if (spContainersFailed) void refetchSpContainers();
  };

  const stockItems: StockItem[] = useMemo(() => {
    const nativeLines: StockItem[] = [];
    for (const container of spOtwContainers) {
      const factor = 1 - Number(container.discountPct || 0) / 100;
      for (const line of container.lines ?? []) {
        const qty = Number(line.qty || 0);
        const rate = Number(line.unitRateUsd || 0) * factor;
        nativeLines.push({
          stockItemCode: line.articleCode || "",
          stockItemName: line.description || line.articleCode || "Unnamed item",
          quantity: String(qty),
          totalCost: String(qty * rate),
          rate: String(rate),
          containerNumber: container.containerNumber || container.invoiceNumber || "SP #" + container.id,
          supplierName: container.supplierName || "",
          importDate: container.invoiceDate || "",
          gradeId: null,
          gradeName: null,
          categoryId: null,
          categoryName: null,
        });
      }
    }
    return [...otwItemsRaw, ...nativeLines];
  }, [otwItemsRaw, spOtwContainers]);

  const groupedItems: GroupedStockItem[] = useMemo(() => {
    const grouped = new Map<string, GroupedStockItem>();
    stockItems.forEach((item) => {
      const name = item.stockItemName;
      const qty = parseFloat(item.quantity || "0");
      const cost = parseFloat(item.totalCost || "0");
      if (!grouped.has(name)) {
        grouped.set(name, {
          stockItemName: name,
          totalQuantity: 0,
          totalCost: 0,
          containerCount: 0,
          gradeName: item.gradeName ?? null,
          categoryName: item.categoryName ?? null,
          containers: [],
        });
      }
      const group = grouped.get(name)!;
      if (!group.gradeName && item.gradeName) group.gradeName = item.gradeName;
      if (!group.categoryName && item.categoryName) group.categoryName = item.categoryName;
      group.totalQuantity += isNaN(qty) ? 0 : qty;
      group.totalCost += isNaN(cost) ? 0 : cost;
      const existingContainer = group.containers.find((c) => c.containerNumber === item.containerNumber);
      const itemRate = parseFloat(item.rate || "0");
      if (existingContainer) {
        existingContainer.quantity += isNaN(qty) ? 0 : qty;
        existingContainer.cost += isNaN(cost) ? 0 : cost;
      } else {
        group.containers.push({
          containerNumber: item.containerNumber,
          quantity: isNaN(qty) ? 0 : qty,
          cost: isNaN(cost) ? 0 : cost,
          rate: isNaN(itemRate) ? 0 : itemRate,
          supplierName: item.supplierName,
        });
      }
    });
    grouped.forEach((group) => {
      group.containerCount = group.containers.length;
    });
    return Array.from(grouped.values()).sort((a, b) => a.stockItemName.localeCompare(b.stockItemName));
  }, [stockItems]);

  const gradeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    groupedItems.forEach((item) => {
      if (item.gradeName) seen.set(item.gradeName, item.gradeName);
    });
    return Array.from(seen.values()).sort();
  }, [groupedItems]);

  const categoryOptions = useMemo(() => {
    const seen = new Map<string, string>();
    groupedItems.forEach((item) => {
      if (item.categoryName) seen.set(item.categoryName, item.categoryName);
    });
    return Array.from(seen.values()).sort();
  }, [groupedItems]);

  const supplierOptions = useMemo(() => {
    const seen = new Set<string>();
    groupedItems.forEach((item) => {
      item.containers.forEach((c) => {
        if (c.supplierName) seen.add(c.supplierName);
      });
    });
    return Array.from(seen).sort();
  }, [groupedItems]);

  const filteredItems = groupedItems.filter((item) => {
    if (selectedGrade !== "all" && item.gradeName !== selectedGrade) return false;
    if (selectedCategory.length > 0 && !selectedCategory.includes(item.categoryName ?? "")) return false;
    if (selectedSupplier.length > 0 && !item.containers.some((c) => selectedSupplier.includes(c.supplierName)))
      return false;
    if (searchTerm === "") return true;
    return (
      searchAny(searchTerm, item.stockItemName, item.gradeName, item.categoryName) ||
      item.containers.some((c) => searchAny(searchTerm, c.containerNumber, c.supplierName))
    );
  });

  const toggleItemExpanded = (itemName: string) => {
    setExpandedItems((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(itemName)) {
        newSet.delete(itemName);
      } else {
        newSet.add(itemName);
      }
      return newSet;
    });
  };

  const totalQuantity = filteredItems.reduce((sum, item) => sum + item.totalQuantity, 0);
  const totalValue = filteredItems.reduce((sum, item) => sum + item.totalCost, 0);
  const uniqueItemCount = filteredItems.length;

  const containerGrandTotal =
    otwContainers.reduce((sum, c) => sum + parseFloat(c.grandTotal || "0"), 0) +
    spOtwContainers.reduce((sum, c) => sum + parseFloat(c.invoiceTotalUsd || "0"), 0);
  const isFiltered =
    searchTerm.trim() !== "" || selectedGrade !== "all" || selectedCategory.length > 0 || selectedSupplier.length > 0;
  const displayTotal = isFiltered ? totalValue : containerGrandTotal;

  const hasActiveFilters =
    searchTerm !== "" || selectedGrade !== "all" || selectedCategory.length > 0 || selectedSupplier.length > 0;

  const clearFilters = () => {
    setSearchTerm("");
    setSelectedGrade("all");
    setSelectedCategory([]);
    setSelectedSupplier([]);
  };

  const exportToExcel = async () => {
    if (isExporting || filteredItems.length === 0) return;
    setIsExporting(true);
    try {
      await exportStockOtwExcel({
        filteredItems,
        otwContainerCount,
        totalQuantity,
        displayTotal,
        formatAmount,
        searchTerm,
        selectedGrade,
        selectedCategory,
        selectedSupplier,
      });
    } finally {
      setIsExporting(false);
    }
  };
  return {
    categoryOptions,
    clearFilters,
    containerGrandTotal,
    containersFailed,
    displayTotal,
    expandedItems,
    exportToExcel,
    filteredItems,
    formatAmount,
    gradeOptions,
    groupedItems,
    hasActiveFilters,
    hasErrors,
    isExporting,
    isLoading,
    onToggleCombined,
    otwContainerCount,
    otwItemsFailed,
    retryFailedQueries,
    searchTerm,
    selectedCategory,
    selectedGrade,
    selectedSupplier,
    setSearchTerm,
    setSelectedCategory,
    setSelectedGrade,
    setSelectedSupplier,
    showCombined,
    spContainersFailed,
    stockItems,
    supplierOptions,
    toggleItemExpanded,
    totalQuantity,
    uniqueItemCount,
  };
}
