// Extracted from ./SpReports.tsx to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";

const REPORT_TABS = ["profit", "sales-form"] as const;

export type ReportTab = (typeof REPORT_TABS)[number];

type CashAccount = {
  id: string | number;
  name: string;
};

type AccountsResponse = {
  accounts?: CashAccount[];
};

interface SpProfitReport {
  saleCount?: number;
  totalRevenue?: number;
  totalCogs?: number;
  grossProfit?: number;
  totalSharedCharges?: number;
  netProfit?: number;
}

type DeveloperProfitCorrection = {
  sourceNetProfit: string;
  effectiveNetProfit: string;
  adjustment: string;
  finalized: boolean;
  correction: { reason: string; actorName: string | null } | null;
};

interface SpProfitSplit {
  id: number;
  periodMonth?: string;
  grossProfit?: number;
  ourShare?: number;
  supplierShare?: number;
}

interface LocationOption {
  id: number;
  name: string;
}

function extractAccounts(payload: AccountsResponse | CashAccount[] | undefined): CashAccount[] {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.accounts) ? payload.accounts : [];
}

export function fmt(v: number | string | undefined, dec = 2) {
  const n = parseFloat(String(v ?? "0"));
  return isNaN(n)
    ? `$0.${"0".repeat(dec)}`
    : `$${n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
}

function toLocalDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCurrentMonthRange(now = new Date()) {
  const year = now.getFullYear();
  const monthIndex = now.getMonth();
  const firstDay = new Date(year, monthIndex, 1);
  const lastDay = new Date(year, monthIndex + 1, 0);

  return {
    key: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
    from: toLocalDateInputValue(firstDay),
    to: toLocalDateInputValue(lastDay),
  };
}

export function useSpReportsState() {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const queryClient = useQueryClient();
  const { selectedCompany } = useCompany();
  const { data: currentUser } = useQuery<{ role?: string; currentRole?: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = currentUser?.role === "Developer";
  const [tab, setTab] = useHubQueryState<ReportTab>({
    key: "tab",
    allowedValues: REPORT_TABS,
    defaultValue: "profit",
    omitDefault: true,
  });
  const [startDate, setStartDate] = useState(() => getCurrentMonthRange().from);
  const [endDate, setEndDate] = useState(() => getCurrentMonthRange().to);
  const [exportFrom, setExportFrom] = useState(() => getCurrentMonthRange().from);
  const [exportTo, setExportTo] = useState(() => getCurrentMonthRange().to);
  const [exportLocationId, setExportLocationId] = useState<string>("all");
  const [exportCashAccountId, setExportCashAccountId] = useState<string>("none");
  const [exporting, setExporting] = useState(false);
  const [exportingV2, setExportingV2] = useState(false);
  const [editProfitOpen, setEditProfitOpen] = useState(false);
  const [correctedProfit, setCorrectedProfit] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionConfirmation, setCorrectionConfirmation] = useState("");

  useEffect(() => {
    let activeMonthKey = getCurrentMonthRange().key;

    const syncReportRangesToCurrentMonth = () => {
      const currentMonth = getCurrentMonthRange();
      if (currentMonth.key === activeMonthKey) return;

      activeMonthKey = currentMonth.key;
      setStartDate(currentMonth.from);
      setEndDate(currentMonth.to);
      setExportFrom(currentMonth.from);
      setExportTo(currentMonth.to);
    };

    const intervalId = window.setInterval(syncReportRangesToCurrentMonth, 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  const profitUrl = `/api/sp/report/profit${
    startDate || endDate
      ? `?${new URLSearchParams({ ...(startDate && { startDate }), ...(endDate && { endDate }) })}`
      : ""
  }`;
  const splitsUrl = "/api/sp/profit-splits";
  const selectedMonth = endDate.slice(0, 7);
  const [yearOfMonth, monthOfYear] = selectedMonth.split("-").map(Number);
  const completeMonth =
    Number.isInteger(yearOfMonth) &&
    Number.isInteger(monthOfYear) &&
    startDate === `${selectedMonth}-01` &&
    endDate ===
      `${selectedMonth}-${String(new Date(Date.UTC(yearOfMonth, monthOfYear, 0)).getUTCDate()).padStart(2, "0")}`;
  const correctionUrl = `/api/sp/golden-coast/profit-correction?periodMonth=${encodeURIComponent(selectedMonth)}`;
  const { data: developerCorrection } = useQuery<DeveloperProfitCorrection>({
    queryKey: [correctionUrl, selectedCompany?.id],
    enabled: isDeveloper && completeMonth,
    retry: false,
  });
  const saveProfitCorrection = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const response = await apiRequest("POST", "/api/sp/golden-coast/profit-correction", {
        periodMonth: selectedMonth,
        targetNetProfit: correctedProfit,
        reason: correctionReason,
        confirmation: correctionConfirmation,
        idempotencyKey: `sp-profit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      return response.json();
    },
    onSuccess: () => {
      setEditProfitOpen(false);
      setCorrectionReason("");
      setCorrectionConfirmation("");
      void queryClient.invalidateQueries({ queryKey: [correctionUrl, selectedCompany?.id] });
      void queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
          typeof queryKey[0] === "string" &&
          (queryKey[0].startsWith("/api/sp/report/profit") ||
            queryKey[0].includes("/phase11/profit-splits/monthly-close/readiness")),
      });
      toast({ title: "Profit correction saved", description: "The correction will be included in the split Journal." });
    },
    onError: (error) =>
      toast({
        title: "Profit correction failed",
        description: getErrorDetails(error).message,
        variant: "destructive",
      }),
  });

  const { data: profit, isLoading: profitLoading } = useQuery<SpProfitReport>({ queryKey: [profitUrl] });
  const { data: splits = [], isLoading: splitsLoading } = useQuery<SpProfitSplit[]>({ queryKey: [splitsUrl] });
  const { data: locations = [] } = useQuery<LocationOption[]>({ queryKey: ["/api/locations"] });
  const { data: accountsResponse } = useQuery<AccountsResponse | CashAccount[]>({
    queryKey: ["/api/accounts/all", selectedCompany?.id],
  });
  const accounts = extractAccounts(accountsResponse);

  useEffect(() => {
    const gcSalesCash = accounts.find((account) => account.name.trim().toLowerCase() === "gc sales cash");
    if (!gcSalesCash) return;

    setExportCashAccountId((current) => {
      const currentAccountStillExists = accounts.some((account) => String(account.id) === current);
      return currentAccountStillExists ? current : String(gcSalesCash.id);
    });
  }, [accounts, selectedCompany?.id]);

  const handleExportSalesForm = async () => {
    if (!exportFrom || !exportTo) {
      toast({ title: "Please select both From and To dates", variant: "destructive" });
      return;
    }
    setExporting(true);
    try {
      const params = new URLSearchParams({ fromDate: exportFrom, toDate: exportTo });
      if (exportLocationId && exportLocationId !== "all") params.set("locationId", exportLocationId);
      const filename = await downloadFromUrl(`/api/sp/sales-form/export?${params}`, {
        fileName: exportFileName("sales form", "xlsx", { from: exportFrom, to: exportTo }),
      });
      toast({ title: "Sales form exported", description: filename });
    } catch (e) {
      toast({ title: "Export failed", description: getErrorDetails(e).message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const handleExportSalesFormV2 = async () => {
    if (!exportFrom || !exportTo) {
      toast({ title: "Please select both From and To dates", variant: "destructive" });
      return;
    }
    setExportingV2(true);
    try {
      const params = new URLSearchParams({ fromDate: exportFrom, toDate: exportTo });
      if (exportLocationId && exportLocationId !== "all") params.set("locationId", exportLocationId);
      if (exportCashAccountId && exportCashAccountId !== "none") params.set("cashAccountId", exportCashAccountId);
      const filename = await downloadFromUrl(`/api/sp/sales-form/export-v2?${params}`, {
        fileName: exportFileName("system sales form", "xlsx", { from: exportFrom, to: exportTo }),
      });
      toast({ title: "System sales form exported", description: filename });
    } catch (e) {
      toast({ title: "Export failed", description: getErrorDetails(e).message, variant: "destructive" });
    } finally {
      setExportingV2(false);
    }
  };
  return {
    accounts,
    completeMonth,
    correctedProfit,
    correctionConfirmation,
    correctionReason,
    developerCorrection,
    editProfitOpen,
    endDate,
    exportCashAccountId,
    exportFrom,
    exportLocationId,
    exportTo,
    exporting,
    exportingV2,
    handleExportSalesForm,
    handleExportSalesFormV2,
    isDeveloper,
    locations,
    profit,
    profitLoading,
    recordChanges,
    saveProfitCorrection,
    selectedCompany,
    selectedMonth,
    setCorrectedProfit,
    setCorrectionConfirmation,
    setCorrectionReason,
    setEditProfitOpen,
    setEndDate,
    setExportCashAccountId,
    setExportFrom,
    setExportLocationId,
    setExportTo,
    setStartDate,
    setTab,
    splits,
    splitsLoading,
    startDate,
    tab,
  };
}
