// Extracted from ./useAnalyticsLegacy.tsx to keep that module under the source-size cap.
import { useEffect, useRef, useState } from "react";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { useQuery } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { erpPageAccessQueryOptions } from "@/app/erpAccessQuery";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { getDefaultPeriodValue, PeriodFilterValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import {
  Container as ContainerIcon,
  DollarSign,
  FileText,
  Landmark,
  type LucideIcon,
  Package,
  ShoppingCart,
  TrendingDown,
  Wallet,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import type {
  Account,
  Location,
  LocationSales,
  OpeningStockItemsData,
  POSTransaction,
  StockGroup,
  Supplier,
} from "./types";

export function useAnalyticsLegacyPart1() {
  const { formatDisplayDate } = useDateFormat();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const { formatAmount } = useCurrencyContext();
  const [, navigate] = useLocation();
  const { data: myErpPages } = useQuery<{ hiddenErpCostFields?: string[] }>({
    ...erpPageAccessQueryOptions(selectedCompany?.id, true),
  });
  const [selectedPeriod, setSelectedPeriod] = useState("month");
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [detailsPeriod, setDetailsPeriod] = useState("all");
  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("all_time"));
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));
  const [selectedLocationForDetails, setSelectedLocationForDetails] = useState<number | null>(null);
  const [expandedAccounts, setExpandedAccounts] = useState<Set<number>>(new Set());

  // Report filters
  const [reportStartDate, setReportStartDate] = useState("");
  const [reportEndDate, setReportEndDate] = useState("");
  const [reportLocationId, setReportLocationId] = useState("all");
  const [reportStockGroupId, setReportStockGroupId] = useState("all");
  const [reportSupplierIds, setReportSupplierIds] = useState<number[]>([]);
  const [reportContainerStatus, setReportContainerStatus] = useState("Offloaded");
  const [reportAllCompanies, setReportAllCompanies] = useState("all");
  const [containerPeriodFilter, setContainerPeriodFilter] = useState<PeriodFilterValue>(() =>
    getDefaultPeriodValue("this_month")
  );
  const containerCompanyInitialized = useRef(false);
  useEffect(() => {
    if (!containerCompanyInitialized.current && selectedCompany?.id) {
      setReportAllCompanies(String(selectedCompany.id));
      containerCompanyInitialized.current = true;
    }
  }, [selectedCompany?.id]);

  // Opening Stock Summary state
  const [openingStockLocationId, setOpeningStockLocationId] = useState("all");
  const [expandedStockGroups, setExpandedStockGroups] = useState<Set<number>>(new Set());
  const [stockGroupItems, setStockGroupItems] = useState<Map<number, OpeningStockItemsData>>(new Map());

  // Net Profit Report state
  const [expandedNetProfitSections, setExpandedNetProfitSections] = useState<Set<string>>(new Set());

  // Derive P&L and Balance date filters from the global period filter
  const plStartDate = periodFilter.fromDate;
  const plEndDate = periodFilter.toDate;
  const balStartDate = periodFilter.fromDate;
  const balEndDate = periodFilter.toDate;

  // Factory sales analytics drilldowns
  const [expandedCustomerRows, setExpandedCustomerRows] = useState<Set<number>>(new Set());

  const [activeSection, setActiveSection] = useState("assets");
  useEscapeBack(activeSection !== "assets" ? () => setActiveSection("assets") : null);

  const sidebarGroups: { label: string; items: { key: string; label: string; icon: LucideIcon }[] }[] = [
    {
      label: "Account Balances",
      items: [
        { key: "assets", label: "Assets", icon: Package },
        { key: "liabilities", label: "Liabilities", icon: FileText },
        { key: "cash", label: "Cash", icon: Wallet },
        { key: "loans-banks", label: "Loans / Banks", icon: Landmark },
      ],
    },
    {
      label: "Expenses",
      items: [
        { key: "expenses", label: "All Expenses", icon: TrendingDown },
        { key: "direct-expenses", label: "Direct Expenses", icon: DollarSign },
        { key: "indirect-expenses", label: "Indirect Expenses", icon: FileText },
      ],
    },
    {
      label: "Sales & Containers",
      items: [
        { key: "sales", label: "Sales Analytics", icon: ShoppingCart },
        { key: "containers", label: "Container Report", icon: ContainerIcon },
      ],
    },
  ];

  // Clear cached items when location filter changes
  const handleOpeningStockLocationChange = (newLocationId: string) => {
    setOpeningStockLocationId(newLocationId);
    setExpandedStockGroups(new Set());
    setStockGroupItems(new Map());
  };

  // Fetch reference data — locations and stock groups are shared across sections.
  // staleTime avoids redundant refetches when the user navigates between sections.
  useQuery<Location[]>({
    queryKey: ["/api/locations", selectedCompany?.id],
    queryFn: async ({ queryKey }) => {
      const response = await fetch(queryKey[0] as string, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch locations");
      return response.json();
    },
    enabled: !!selectedCompany,
    staleTime: 5 * 60 * 1000,
  });
  useQuery<StockGroup[]>({
    queryKey: ["/api/stock-groups", selectedCompany?.id],
    queryFn: async ({ queryKey }) => {
      const response = await fetch(queryKey[0] as string, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch stock groups");
      return response.json();
    },
    enabled: !!selectedCompany,
    staleTime: 5 * 60 * 1000,
  });
  // Suppliers are only used in the Container Report filter — defer until that section opens.
  useQuery<Supplier[]>({
    queryKey: ["/api/suppliers"],
    queryFn: async () => {
      const response = await fetch("/api/suppliers", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch suppliers");
      return response.json();
    },
    enabled: !!selectedCompany && activeSection === "containers",
    staleTime: 5 * 60 * 1000,
  });

  // Factory mode must use a factory-namespaced endpoint so account balances
  // follow the server-pinned factoryCompanyId instead of the shared ERP
  // currentCompanyId (which another browser tab can legitimately change).
  const analyticsAccountsPath = appMode === "factory" ? "/api/factory/analytics/accounts" : "/api/accounts/all";

  // Fetch all accounts (with optional date filter for balance sections).
  const { data: accounts = [], isLoading: accountsLoading } = useQuery<Account[]>({
    queryKey: [analyticsAccountsPath, selectedCompany?.id, balStartDate, balEndDate],
    queryFn: async () => {
      const params = new URLSearchParams({ profile: "analytics" });
      if (balStartDate) params.append("startDate", balStartDate);
      if (balEndDate) params.append("endDate", balEndDate);
      const url = `${analyticsAccountsPath}?${params.toString()}`;
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch accounts");

      const payload: unknown = await response.json();
      if (Array.isArray(payload)) return payload as Account[];
      if (payload && typeof payload === "object" && "accounts" in payload) {
        const accountList = (payload as { accounts?: unknown }).accounts;
        if (Array.isArray(accountList)) return accountList as Account[];
      }
      return [];
    },
    enabled: !!selectedCompany,
  });

  // Fetch sales data
  const getDateRange = () => {
    const today = new Date();
    let startDate = "";
    let endDate = today.toLocaleDateString("en-CA");
    if (selectedPeriod === "today") {
      startDate = endDate;
    } else if (selectedPeriod === "month") {
      const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      startDate = firstDayOfMonth.toLocaleDateString("en-CA");
      endDate = lastDayOfMonth.toLocaleDateString("en-CA");
    } else if (selectedPeriod === "year") {
      const firstDayOfYear = new Date(today.getFullYear(), 0, 1);
      startDate = firstDayOfYear.toLocaleDateString("en-CA");
    } else if (selectedPeriod === "range") {
      if (!rangeStart || !rangeEnd) return {};
      return { startDate: rangeStart, endDate: rangeEnd };
    }
    return selectedPeriod === "all" ? {} : { startDate, endDate };
  };

  const dateRange = getDateRange();
  const { data: salesData = [], isLoading: salesLoading } = useQuery<LocationSales[]>({
    queryKey: ["/api/financial/sales", selectedCompany?.id, dateRange],
    queryFn: async () => {
      const params = new URLSearchParams(dateRange as Record<string, string>);
      const response = await fetch(`/api/financial/sales?${params}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch sales data");
      return response.json();
    },
    enabled: !!selectedCompany,
  });

  // Fetch detail transactions
  const getDetailsDateRange = () => {
    const today = new Date();
    let startDate = "";
    let endDate = today.toLocaleDateString("en-CA");
    if (detailsPeriod === "today") {
      startDate = endDate;
    } else if (detailsPeriod === "month") {
      const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      startDate = firstDayOfMonth.toLocaleDateString("en-CA");
      endDate = lastDayOfMonth.toLocaleDateString("en-CA");
    } else if (detailsPeriod === "year") {
      const firstDayOfYear = new Date(today.getFullYear(), 0, 1);
      startDate = firstDayOfYear.toLocaleDateString("en-CA");
    }
    return detailsPeriod === "all" ? {} : { startDate, endDate };
  };

  const detailsDateRange = getDetailsDateRange();
  const { data: transactions = [], isLoading: transactionsLoading } = useQuery<POSTransaction[]>({
    queryKey: ["/api/financial/sales", selectedLocationForDetails, "transactions", detailsDateRange],
    queryFn: async () => {
      const params = new URLSearchParams(detailsDateRange as Record<string, string>);
      const response = await fetch(`/api/financial/sales/${selectedLocationForDetails}/transactions?${params}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch transactions");
      return response.json();
    },
    enabled: !!selectedLocationForDetails,
  });

  // Fetch stock movement report
  const buildStockMovementUrl = () => {
    const params = new URLSearchParams();
    if (reportStartDate) params.append("startDate", reportStartDate);
    if (reportEndDate) params.append("endDate", reportEndDate);
    if (reportLocationId && reportLocationId !== "all") params.append("locationId", reportLocationId);
    if (reportStockGroupId && reportStockGroupId !== "all") params.append("stockGroupId", reportStockGroupId);
    return `/api/reports/stock-movement?${params}`;
  };
  return {
    accounts,
    accountsLoading,
    activeSection,
    appMode,
    balEndDate,
    balStartDate,
    buildStockMovementUrl,
    containerCompanyInitialized,
    containerPeriodFilter,
    dateRange,
    detailsDateRange,
    detailsPeriod,
    expandedAccounts,
    expandedCustomerRows,
    expandedNetProfitSections,
    expandedStockGroups,
    formatAmount,
    formatDisplayDate,
    getDateRange,
    getDetailsDateRange,
    handleOpeningStockLocationChange,
    modeApiRequest,
    myErpPages,
    navigate,
    openingStockLocationId,
    periodFilter,
    plEndDate,
    plStartDate,
    rangeEnd,
    rangeStart,
    reportAllCompanies,
    reportContainerStatus,
    reportEndDate,
    reportLocationId,
    reportStartDate,
    reportStockGroupId,
    reportSupplierIds,
    salesData,
    salesLoading,
    selectedCompany,
    selectedLocationForDetails,
    selectedPeriod,
    setActiveSection,
    setContainerPeriodFilter,
    setDetailsPeriod,
    setExpandedAccounts,
    setExpandedCustomerRows,
    setExpandedNetProfitSections,
    setExpandedStockGroups,
    setOpeningStockLocationId,
    setPeriodFilter,
    setRangeEnd,
    setRangeStart,
    setReportAllCompanies,
    setReportContainerStatus,
    setReportEndDate,
    setReportLocationId,
    setReportStartDate,
    setReportStockGroupId,
    setReportSupplierIds,
    setSelectedLocationForDetails,
    setSelectedPeriod,
    setStockGroupItems,
    sidebarGroups,
    stockGroupItems,
    toast,
    transactions,
    transactionsLoading,
  };
}
