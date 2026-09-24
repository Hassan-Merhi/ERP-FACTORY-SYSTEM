import { searchAny } from "@shared/searchNormalization";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import type { ItemGroup, PLBasis, PLFilter, SalesReportItem, VoucherGroup } from "./types";
import { LOCATION_PALETTE } from "./utils";

export function useSalesReportDetailModel() {
  const handleBack = useBackToParent();
  const { formatAmount } = useCurrencyContext();
  const [plFilter, setPlFilter] = useState<PLFilter>("all");
  const [plBasis, setPlBasis] = useState<PLBasis>("config");
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [expandedLocations, setExpandedLocations] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"items" | "bySale">("items");
  const [expandedVouchers, setExpandedVouchers] = useState<Set<number>>(new Set());

  const ITEM_COLUMNS = [
    { id: "qty" as const, label: "Qty" },
    { id: "costPrice" as const, label: "Cost Price" },
    { id: "hassanPrice" as const, label: "Hassan's Price" },
    { id: "pricePerBale" as const, label: "Price / Bale" },
    { id: "costProfitBale" as const, label: "Cost Profit / Bale" },
    { id: "hassanProfitBale" as const, label: "Hassan's Profit / Bale" },
    { id: "costProfitTotal" as const, label: "Cost Profit" },
    { id: "hassanProfitTotal" as const, label: "Hassan's Profit" },
  ];
  type ItemColumnId = (typeof ITEM_COLUMNS)[number]["id"];
  const [hiddenColumns, setHiddenColumns] = useState<Set<ItemColumnId>>(new Set());
  const col = (id: ItemColumnId) => !hiddenColumns.has(id);
  const toggleColumn = (id: ItemColumnId) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useEscapeToParent("/sales-report");

  const params = new URLSearchParams(window.location.search);
  const startDate = params.get("startDate") || "";
  const endDate = params.get("endDate") || "";
  const displayDate = params.get("displayDate") || startDate;
  const locationId = params.get("locationId") || "";
  const stockItemId = params.get("stockItemId") || "";
  const stockGroupId = params.get("stockGroupId") || "";
  const searchTerm = params.get("searchTerm") || "";
  const grouping = params.get("grouping") || "daily";
  const allCompanies = params.get("allCompanies") === "true";
  const companyFilter = params.get("companyFilter") || "";
  const isCreditSaleParam = params.get("isCreditSale");

  const queryParams = new URLSearchParams();
  if (startDate) queryParams.append("startDate", startDate);
  if (endDate) queryParams.append("endDate", endDate);
  if (locationId && locationId !== "all") queryParams.append("locationId", locationId);
  if (stockItemId && stockItemId !== "all") queryParams.append("stockItemId", stockItemId);
  if (stockGroupId && stockGroupId !== "all") queryParams.append("stockGroupId", stockGroupId);
  if (allCompanies && companyFilter) queryParams.append("companyFilter", companyFilter);
  const queryString = queryParams.toString();

  const apiBase = allCompanies ? "/api/dashboard/sales-report-all" : "/api/sales-report";
  const apiUrl = queryString ? `${apiBase}?${queryString}` : apiBase;

  const { data: items = [], isLoading } = useQuery<SalesReportItem[]>({
    queryKey: [apiUrl],
    enabled: !!startDate,
  });

  // Apply P/L filter, credit sale filter, and optional search term filter
  const filteredItems = items.filter((item) => {
    // Separate credit vs cash items based on which row was clicked
    if (isCreditSaleParam === "true" && !item.isCreditSale) return false;
    if (isCreditSaleParam === "false" && item.isCreditSale) return false;
    if (searchTerm) {
      const matches = searchAny(searchTerm, item.stockItemName, item.locationName);
      if (!matches) return false;
    }
    if (plFilter === "all") return true;
    const value = plBasis === "cost" ? parseFloat(item.costProfit) : item.configuredProfit;
    if (plFilter === "gain") return value > 0;
    if (plFilter === "loss") return value < 0;
    return true;
  });

  // Group items by stock item name
  const itemGroupMap = new Map<number, ItemGroup>();
  filteredItems.forEach((item) => {
    if (!itemGroupMap.has(item.stockItemId)) {
      itemGroupMap.set(item.stockItemId, {
        stockItemId: item.stockItemId,
        stockItemName: item.stockItemName,
        stockItemCode: item.stockItemCode,
        totalQty: 0,
        totalSales: 0,
        totalCost: 0,
        totalConfiguredCost: 0,
        costProfit: 0,
        configuredProfit: 0,
        locationBreakdown: [],
      });
    }
    const g = itemGroupMap.get(item.stockItemId)!;
    const qty = parseFloat(item.quantity);
    g.totalQty += qty;
    g.totalSales += parseFloat(item.totalSales || "0");
    g.totalCost += parseFloat(item.totalCost || "0");
    g.totalConfiguredCost += item.totalConfiguredCost || 0;
    g.costProfit += parseFloat(item.costProfit || "0");
    g.configuredProfit += item.configuredProfit || 0;

    // Also track per-location breakdown within this item group
    // In all-companies mode, use composite key so same-named locations across companies are separate
    const locKey = allCompanies
      ? `${item.companyId ?? "?"}-${item.locationId ?? "no-location"}`
      : String(item.locationId ?? "no-location");
    const locDisplayName = item.locationName || "No Location";
    let locSummary = g.locationBreakdown.find((l) => l.locationKey === locKey);
    if (!locSummary) {
      locSummary = {
        locationKey: locKey,
        locationId: item.locationId,
        locationName: locDisplayName,
        totalQty: 0,
        totalSales: 0,
        totalCost: 0,
        totalConfiguredCost: 0,
        costProfit: 0,
        configuredProfit: 0,
        items: [],
      };
      g.locationBreakdown.push(locSummary);
    }
    locSummary.totalQty += qty;
    locSummary.totalSales += parseFloat(item.totalSales || "0");
    locSummary.totalCost += parseFloat(item.totalCost || "0");
    locSummary.totalConfiguredCost += item.totalConfiguredCost || 0;
    locSummary.costProfit += parseFloat(item.costProfit || "0");
    locSummary.configuredProfit += item.configuredProfit || 0;
    locSummary.items.push(item);
  });

  const itemGroups = Array.from(itemGroupMap.values()).sort((a, b) => a.stockItemName.localeCompare(b.stockItemName));

  // Sort location breakdowns alphabetically
  itemGroups.forEach((g) => {
    g.locationBreakdown.sort((a, b) => a.locationName.localeCompare(b.locationName));
  });

  // Build a stable color map for all unique locations (all companies view or multiple locations)
  const allLocKeys = Array.from(
    new Set(
      filteredItems.map((i) =>
        allCompanies ? `${i.companyId ?? "?"}-${i.locationId ?? "no-location"}` : String(i.locationId ?? "no-location")
      )
    )
  );
  const locationColorMap = new Map<string, (typeof LOCATION_PALETTE)[0]>();
  allLocKeys.forEach((key, idx) => {
    locationColorMap.set(key, LOCATION_PALETTE[idx % LOCATION_PALETTE.length]);
  });
  // Apply colors when multiple distinct locations exist (all-companies view or item sold in many locations)
  const multipleLocations = allLocKeys.length > 1;

  const toggleItem = (key: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleLocation = (key: string) => {
    setExpandedLocations((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Compute unique customer name(s) for credit sale badge
  const creditCustomerNames =
    isCreditSaleParam === "true"
      ? [
          ...new Set(
            filteredItems
              .map((item) => item.customerName)
              .filter((n): n is string => !!n)
              .map((n) => n.replace(/ - Customer Account$/i, "").trim())
          ),
        ]
      : [];
  const creditCustomerLabel =
    creditCustomerNames.length === 1
      ? creditCustomerNames[0]
      : creditCustomerNames.length > 1
        ? `${creditCustomerNames.length} customers`
        : null;

  const totalQty = filteredItems.reduce((sum, item) => sum + parseFloat(item.quantity), 0);
  const totalSales = filteredItems.reduce((sum, item) => sum + parseFloat(item.totalSales || "0"), 0);
  const totalCost = filteredItems.reduce((sum, item) => sum + parseFloat(item.totalCost || "0"), 0);
  const totalConfiguredCost = filteredItems.reduce((sum, item) => sum + (item.totalConfiguredCost || 0), 0);
  const costProfit = totalSales - totalCost;
  const configuredProfit = totalSales - totalConfiguredCost;

  // By-Sale view: group items by voucher, applying plFilter at the voucher level
  const baseFilteredItems = items.filter((item) => {
    if (isCreditSaleParam === "true" && !item.isCreditSale) return false;
    if (isCreditSaleParam === "false" && item.isCreditSale) return false;
    if (searchTerm) {
      const matches = searchAny(searchTerm, item.stockItemName, item.locationName);
      if (!matches) return false;
    }
    return true;
  });

  const voucherGroupMap = new Map<number, VoucherGroup>();
  baseFilteredItems.forEach((item) => {
    if (!voucherGroupMap.has(item.voucherId)) {
      voucherGroupMap.set(item.voucherId, {
        voucherId: item.voucherId,
        voucherNumber: item.voucherNumber,
        voucherDate: item.voucherDate,
        createdAt: item.createdAt,
        locationName: item.locationName || "No Location",
        totalQty: 0,
        totalSales: 0,
        totalCost: 0,
        totalConfiguredCost: 0,
        costProfit: 0,
        configuredProfit: 0,
        items: [],
      });
    }
    const g = voucherGroupMap.get(item.voucherId)!;
    g.totalQty += parseFloat(item.quantity);
    g.totalSales += parseFloat(item.totalSales || "0");
    g.totalCost += parseFloat(item.totalCost || "0");
    g.totalConfiguredCost += item.totalConfiguredCost || 0;
    g.costProfit += parseFloat(item.costProfit || "0");
    g.configuredProfit += item.configuredProfit || 0;
    g.items.push(item);
    // Use the most common location name (set from first item, good enough)
    if (g.items.length === 1) g.locationName = item.locationName || "No Location";
  });

  const allVoucherGroups = Array.from(voucherGroupMap.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const voucherGroups = allVoucherGroups.filter((vg) => {
    if (plFilter === "all") return true;
    const value = plBasis === "cost" ? vg.costProfit : vg.configuredProfit;
    if (plFilter === "gain") return value > 0;
    if (plFilter === "loss") return value < 0;
    return true;
  });

  const toggleVoucher = (id: number) => {
    setExpandedVouchers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return {
    handleBack,
    formatAmount,
    plFilter,
    setPlFilter,
    plBasis,
    setPlBasis,
    expandedItems,
    setExpandedItems,
    expandedLocations,
    setExpandedLocations,
    viewMode,
    setViewMode,
    expandedVouchers,
    setExpandedVouchers,
    ITEM_COLUMNS,
    hiddenColumns,
    setHiddenColumns,
    col,
    toggleColumn,
    displayDate,
    grouping,
    allCompanies,
    isCreditSaleParam,
    searchTerm,
    items,
    isLoading,
    filteredItems,
    itemGroups,
    locationColorMap,
    multipleLocations,
    toggleItem,
    toggleLocation,
    creditCustomerLabel,
    totalQty,
    totalSales,
    totalCost,
    totalConfiguredCost,
    costProfit,
    configuredProfit,
    voucherGroups,
    toggleVoucher,
  };
}
