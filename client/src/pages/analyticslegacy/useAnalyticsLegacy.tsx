import { useState, useEffect, useRef } from "react";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { useQuery } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import {
  TrendingDown,
  DollarSign,
  Wallet,
  Package,
  FileText,
  ShoppingCart,
  Container as ContainerIcon,
  Landmark,
  type LucideIcon,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";

import type {
  Account,
  ContainerData,
  FactoryContainerSalesData,
  FactoryPosSummary,
  FactorySalesByCustomer,
  Location,
  LocationSales,
  NetProfitStatementData,
  OpeningStockItemsData,
  OpeningStockSummaryData,
  POSTransaction,
  StockGroup,
  StockMovementData,
  Supplier,
} from "./types";
import { calculatePLTotal } from "./accountMath";

import { useAccountRenderers } from "./useAccountRenderers";

/**
 * State, queries and derived values for the legacy Analytics page.
 *
 * Extracted so the page is a layout shell and each section panel is its own
 * file. Panels take this hook's return as one prop typed via ReturnType, which
 * avoids both a hand-maintained props interface that drifts and the
 * `props: any` shortcut that would raise the type-escape ceiling.
 */
export function useAnalyticsLegacy() {
  const { formatDisplayDate } = useDateFormat();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const { formatAmount } = useCurrencyContext();
  const [, navigate] = useLocation();
  const { data: myErpPages } = useQuery<{ hiddenErpCostFields?: string[] }>({ queryKey: ["/api/my-erp-pages"] });
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

  // Factory-specific filters
  const [factoryContainerCustomerId, setFactoryContainerCustomerId] = useState("all");
  const [factoryContainerStartDate, setFactoryContainerStartDate] = useState("");
  const [factoryContainerEndDate, setFactoryContainerEndDate] = useState("");
  const [factoryContainerPaymentStatus, setFactoryContainerPaymentStatus] = useState("all");
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
  const { data: _locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations", selectedCompany?.id],
    queryFn: async ({ queryKey }) => {
      const response = await fetch(queryKey[0] as string, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch locations");
      return response.json();
    },
    enabled: !!selectedCompany,
    staleTime: 5 * 60 * 1000,
  });
  const { data: _stockGroups = [] } = useQuery<StockGroup[]>({
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
  const { data: _suppliers = [] } = useQuery<Supplier[]>({
    queryKey: ["/api/suppliers"],
    queryFn: async () => {
      const response = await fetch("/api/suppliers", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch suppliers");
      return response.json();
    },
    enabled: !!selectedCompany && activeSection === "containers",
    staleTime: 5 * 60 * 1000,
  });

  // Fetch all accounts (with optional date filter for balance sections)
  const { data: accounts = [], isLoading: accountsLoading } = useQuery<Account[]>({
    queryKey: ["/api/accounts/all", selectedCompany?.id, balStartDate, balEndDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (balStartDate) params.append("startDate", balStartDate);
      if (balEndDate) params.append("endDate", balEndDate);
      const url = `/api/accounts/all${params.toString() ? `?${params.toString()}` : ""}`;
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch accounts");
      return response.json();
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

  const {
    data: _stockMovementData,
    refetch: _refetchStockMovement,
    isLoading: _loadingStock,
  } = useQuery<StockMovementData>({
    queryKey: [buildStockMovementUrl(), selectedCompany?.id],
    queryFn: async ({ queryKey }) => {
      const response = await fetch(queryKey[0] as string, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch stock movement");
      return response.json();
    },
    enabled: true,
  });

  // Fetch user's accessible companies for the Container Report company filter
  const { data: userCompanies = [] } = useQuery<{ companyId: number; companyName: string }[]>({
    queryKey: ["/api/user/companies"],
    queryFn: async () => {
      const res = await fetch("/api/user/companies", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  // Fetch container report
  const buildContainerUrl = () => {
    const params = new URLSearchParams();
    if (containerPeriodFilter.fromDate) params.append("startDate", containerPeriodFilter.fromDate);
    if (containerPeriodFilter.toDate) params.append("endDate", containerPeriodFilter.toDate);
    // supplier filtering is done client-side so multi-select works without extra API params
    // Status is always set (Offloaded or OTW)
    params.append("status", reportContainerStatus);
    if (reportAllCompanies === "all") {
      params.append("allCompanies", "true");
    } else {
      params.append("specificCompanyId", reportAllCompanies);
    }
    return `/api/reports/containers?${params}`;
  };

  const {
    data: containerData,
    refetch: _refetchContainers,
    isLoading: loadingContainers,
  } = useQuery<ContainerData>({
    queryKey: [buildContainerUrl(), selectedCompany?.id],
    queryFn: async ({ queryKey }) => {
      const response = await fetch(queryKey[0] as string, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch containers");
      return response.json();
    },
    enabled: !!selectedCompany,
  });

  // ── Factory Analytics Queries ───────────────────────────────────────────
  const [factorySalesStartDate, setFactorySalesStartDate] = useState("");
  const [factorySalesEndDate, setFactorySalesEndDate] = useState("");

  const buildFactorySalesUrl = (base: string) => {
    const params = new URLSearchParams();
    if (factorySalesStartDate) params.append("startDate", factorySalesStartDate);
    if (factorySalesEndDate) params.append("endDate", factorySalesEndDate);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };

  const { data: factorySalesByCustomer = [], isLoading: loadingFactorySales } = useQuery<FactorySalesByCustomer[]>({
    queryKey: [
      "/api/factory/analytics/sales-by-customer",
      selectedCompany?.id,
      factorySalesStartDate,
      factorySalesEndDate,
    ],
    queryFn: async () => {
      const res = await fetch(buildFactorySalesUrl("/api/factory/analytics/sales-by-customer"), {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch factory sales");
      return res.json();
    },
    enabled: !!selectedCompany && appMode === "factory",
  });

  const { data: factoryPosSummary, isLoading: loadingFactoryPos } = useQuery<FactoryPosSummary>({
    queryKey: ["/api/factory/analytics/pos-summary", selectedCompany?.id, factorySalesStartDate, factorySalesEndDate],
    queryFn: async () => {
      const res = await fetch(buildFactorySalesUrl("/api/factory/analytics/pos-summary"), { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch factory POS summary");
      return res.json();
    },
    enabled: !!selectedCompany && appMode === "factory",
  });

  const buildFactoryContainerSalesUrl = () => {
    const params = new URLSearchParams();
    if (factoryContainerStartDate) params.append("startDate", factoryContainerStartDate);
    if (factoryContainerEndDate) params.append("endDate", factoryContainerEndDate);
    if (factoryContainerCustomerId && factoryContainerCustomerId !== "all")
      params.append("customerId", factoryContainerCustomerId);
    if (factoryContainerPaymentStatus && factoryContainerPaymentStatus !== "all")
      params.append("paymentStatus", factoryContainerPaymentStatus);
    return `/api/factory/analytics/container-sales-report?${params}`;
  };

  const {
    data: factoryContainerSales,
    refetch: _refetchFactoryContainerSales,
    isLoading: loadingFactoryContainerSales,
  } = useQuery<FactoryContainerSalesData>({
    queryKey: [buildFactoryContainerSalesUrl(), selectedCompany?.id],
    queryFn: async ({ queryKey }) => {
      const res = await fetch(queryKey[0] as string, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch factory container sales");
      return res.json();
    },
    enabled: appMode === "factory",
  });

  // Fetch Opening Stock Summary
  const buildOpeningStockUrl = () => {
    const params = new URLSearchParams();
    if (openingStockLocationId && openingStockLocationId !== "all") {
      params.append("locationId", openingStockLocationId);
    }
    return `/api/reports/opening-stock-summary?${params}`;
  };

  const { data: openingStockData, isLoading: loadingOpeningStock } = useQuery<OpeningStockSummaryData>({
    queryKey: [buildOpeningStockUrl(), selectedCompany?.id],
    queryFn: async ({ queryKey }) => {
      const response = await fetch(queryKey[0] as string, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch opening stock summary");
      return response.json();
    },
    enabled: !!selectedCompany,
  });

  // Fetch Net Profit Statement
  const { data: netProfitData, isLoading: loadingNetProfit } = useQuery<NetProfitStatementData>({
    queryKey: ["/api/reports/net-profit-statement", selectedCompany?.id, plStartDate, plEndDate],
    queryFn: async ({ queryKey }) => {
      const [base, , startDate, endDate] = queryKey as [string, unknown, string, string];
      const params = new URLSearchParams();
      if (startDate) params.append("startDate", startDate);
      if (endDate) params.append("endDate", endDate);
      const url = `${base}${params.toString() ? `?${params.toString()}` : ""}`;
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch net profit statement");
      return response.json();
    },
    enabled: !!selectedCompany,
  });

  // Toggle Net Profit section expansion
  const toggleNetProfitSection = (section: string) => {
    const newExpanded = new Set(expandedNetProfitSections);
    if (newExpanded.has(section)) {
      newExpanded.delete(section);
    } else {
      newExpanded.add(section);
    }
    setExpandedNetProfitSections(newExpanded);
  };

  // Toggle stock group expansion and fetch items
  const toggleStockGroup = async (groupId: number) => {
    const newExpanded = new Set(expandedStockGroups);
    if (newExpanded.has(groupId)) {
      newExpanded.delete(groupId);
    } else {
      newExpanded.add(groupId);
      // Fetch items if not already loaded
      if (!stockGroupItems.has(groupId)) {
        try {
          const params = new URLSearchParams();
          if (openingStockLocationId && openingStockLocationId !== "all") {
            params.append("locationId", openingStockLocationId);
          }
          const response = await fetch(`/api/reports/opening-stock-summary/${groupId}/items?${params}`, {
            credentials: "include",
          });
          if (response.ok) {
            const data = await response.json();
            setStockGroupItems(new Map(stockGroupItems).set(groupId, data));
          }
        } catch (error) {
          console.error("Failed to fetch stock group items:", error);
        }
      }
    }
    setExpandedStockGroups(newExpanded);
  };

  // Helper functions
  const toggleAccount = (accountId: number) => {
    const newExpanded = new Set(expandedAccounts);
    if (newExpanded.has(accountId)) {
      newExpanded.delete(accountId);
    } else {
      newExpanded.add(accountId);
    }
    setExpandedAccounts(newExpanded);
  };

  // Filter accounts - Cash accounts are ledger accounts with accountType="Cash"
  // Also include bank-entity accounts whose name/code contains "cash"
  const cashAccounts = accounts.filter(
    (acc) =>
      (acc.type === "ledger" && acc.accountType === "Cash") ||
      (acc.type === "bank" &&
        ((acc.name || "").toLowerCase().includes("cash") || (acc.code || "").toLowerCase().includes("cash")))
  );

  // Ledger accounts typed as "Bank" (e.g. "Roukaya Cash") — shown in Loans/Banks section
  // These are separate from bank-entity accounts (acc.type === "bank")
  const bankTypeLedgerAccounts = accounts.filter((acc) => acc.type === "ledger" && acc.accountType === "Bank");

  const assetAccounts = accounts.filter(
    (acc) => acc.type === "fixedAsset" || (acc.type === "ledger" && acc.accountType === "Asset") || acc.type === "bank"
  );

  // Include all expense accounts in P&L calculations (no exclusions)
  const expenseAccounts = accounts.filter((acc) => {
    if (acc.type !== "ledger") return false;

    // Support both correct format (accountType="Expense") and legacy format
    // (accountType="Indirect Expense" or "Direct Expense")
    const isExpenseAccount =
      acc.accountType === "Expense" || acc.accountType === "Indirect Expense" || acc.accountType === "Direct Expense";

    return isExpenseAccount;
  });

  const directExpenseAccounts = expenseAccounts.filter(
    (acc) => acc.subType === "Direct Expense" || acc.accountType === "Direct Expense"
  );

  const indirectExpenseAccounts = expenseAccounts.filter(
    (acc) => acc.subType === "Indirect Expense" || acc.accountType === "Indirect Expense"
  );

  const liabilityAccounts = accounts.filter(
    (acc) =>
      acc.type === "ledger" &&
      // Exclude per-worker insurance liability accounts ("Insurance - [name]").
      // These belong to the Insurance section, not the balance-sheet liabilities list.
      !/^Insurance\s*[-–]/i.test(acc.name) &&
      (acc.accountType === "Liability" ||
        acc.accountType === "Accounts Payable" ||
        acc.accountType === "Loans" ||
        acc.accountType === "Duty Agent" ||
        acc.accountType === "Transporter Agent")
  );

  const loansBanksAccounts = accounts.filter(
    (acc) =>
      acc.type === "bank" || (acc.type === "ledger" && (acc.accountType === "Loans" || acc.accountType === "Bank"))
  );

  const directIncomeAccounts = accounts.filter(
    (acc) => acc.type === "ledger" && acc.accountType === "Income" && acc.subType === "Direct Income"
  );

  const indirectIncomeAccounts = accounts.filter(
    (acc) => acc.type === "ledger" && acc.accountType === "Income" && acc.subType === "Indirect Income"
  );

  // P&L calculations
  const totalDirectIncome = calculatePLTotal(directIncomeAccounts);
  const totalIndirectIncome = calculatePLTotal(indirectIncomeAccounts);
  const totalIncome = totalDirectIncome + totalIndirectIncome;
  const totalDirectExpense = Math.abs(calculatePLTotal(directExpenseAccounts));
  const totalIndirectExpense = Math.abs(calculatePLTotal(indirectExpenseAccounts));
  const totalExpenses = totalDirectExpense + totalIndirectExpense;

  // Render hierarchical NetProfitAccounts (groups collapse/expand)

  const netProfit = totalIncome - totalExpenses;

  const goToStatement = (accountId: number, customerId?: number, _accountType?: string) => {
    if (customerId && appMode === "factory") {
      window.open(`/factory/customers/${customerId}`, "_blank");
      return;
    }
    if (appMode === "factory") {
      // Same-tab SPA navigation keeps the factory session/company context intact.
      // window.open(_blank) opens a fresh tab without factory context → guard
      // redirects to home.
      navigate(`/factory/accounts?accountId=${accountId}&accountType=ledger`);
      return;
    }
    window.open(`/ledger-monthly/${accountId}`, "_blank");
  };

  const { renderNetProfitAccountsList, renderHierarchicalAccounts, renderPLAccountTable } = useAccountRenderers({
    accountsLoading,
    appMode,
    expandedAccounts,
    navigate,
    goToStatement,
    toggleAccount,
    totalExpenses,
    totalIncome,
  });

  return {
    formatDisplayDate,
    appMode,
    modeApiRequest,
    selectedCompany,
    toast,
    formatAmount,
    myErpPages,
    selectedPeriod,
    setSelectedPeriod,
    rangeStart,
    setRangeStart,
    rangeEnd,
    setRangeEnd,
    detailsPeriod,
    setDetailsPeriod,
    periodFilter,
    setPeriodFilter,
    selectedLocationForDetails,
    setSelectedLocationForDetails,
    expandedAccounts,
    setExpandedAccounts,
    reportStartDate,
    setReportStartDate,
    reportEndDate,
    setReportEndDate,
    reportLocationId,
    setReportLocationId,
    reportStockGroupId,
    setReportStockGroupId,
    reportSupplierIds,
    setReportSupplierIds,
    reportContainerStatus,
    setReportContainerStatus,
    reportAllCompanies,
    setReportAllCompanies,
    containerPeriodFilter,
    setContainerPeriodFilter,
    containerCompanyInitialized,
    openingStockLocationId,
    setOpeningStockLocationId,
    expandedStockGroups,
    setExpandedStockGroups,
    stockGroupItems,
    setStockGroupItems,
    expandedNetProfitSections,
    setExpandedNetProfitSections,
    plStartDate,
    plEndDate,
    balStartDate,
    balEndDate,
    factoryContainerCustomerId,
    setFactoryContainerCustomerId,
    factoryContainerStartDate,
    setFactoryContainerStartDate,
    factoryContainerEndDate,
    setFactoryContainerEndDate,
    factoryContainerPaymentStatus,
    setFactoryContainerPaymentStatus,
    expandedCustomerRows,
    setExpandedCustomerRows,
    activeSection,
    setActiveSection,
    sidebarGroups,
    handleOpeningStockLocationChange,
    accountsLoading,
    getDateRange,
    dateRange,
    salesLoading,
    getDetailsDateRange,
    detailsDateRange,
    transactionsLoading,
    buildStockMovementUrl,
    buildContainerUrl,
    factorySalesStartDate,
    setFactorySalesStartDate,
    factorySalesEndDate,
    setFactorySalesEndDate,
    buildFactorySalesUrl,
    loadingFactorySales,
    factoryPosSummary,
    loadingFactoryPos,
    buildFactoryContainerSalesUrl,
    buildOpeningStockUrl,
    openingStockData,
    loadingOpeningStock,
    netProfitData,
    loadingNetProfit,
    toggleNetProfitSection,
    toggleStockGroup,
    toggleAccount,
    cashAccounts,
    bankTypeLedgerAccounts,
    assetAccounts,
    expenseAccounts,
    directExpenseAccounts,
    indirectExpenseAccounts,
    liabilityAccounts,
    loansBanksAccounts,
    directIncomeAccounts,
    indirectIncomeAccounts,
    totalDirectIncome,
    totalIndirectIncome,
    totalIncome,
    totalDirectExpense,
    totalIndirectExpense,
    totalExpenses,
    renderNetProfitAccountsList,
    netProfit,
    goToStatement,
    renderHierarchicalAccounts,
    renderPLAccountTable,
    containerData,
    factoryContainerSales,
    factorySalesByCustomer,
    loadingContainers,
    loadingFactoryContainerSales,
    navigate,
    salesData,
    transactions,
    userCompanies,
  };
}

export type AnalyticsLegacyState = ReturnType<typeof useAnalyticsLegacy>;
