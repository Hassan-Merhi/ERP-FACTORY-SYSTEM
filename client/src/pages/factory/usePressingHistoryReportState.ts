// Extracted from ./PressingHistoryReport.tsx to keep that module under the source-size cap.
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import type { PressingReportColumn, PressingReportFilters } from "@shared/pressingReportContracts";
import {
  fetchPressingReport,
  type PressingCondensedRow,
  type PressingDetailRow,
  pressingKpiWorkers,
  type PressingReportOptions,
} from "./pressing-scanner/pressingReportClient";
import { pressingHourlyKpiTotals, type PressingHourlySnapshot } from "./pressing-scanner/pressingHourlyKpi";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translatePressingUiText } from "@/i18n/pressingUiTranslations";

export const ROOT = "/api/factory/pressing-machines/report";

export const DETAIL_COLUMNS: PressingReportColumn[] = [
  "referenceNumber",
  "articleCode",
  "productName",
  "weightKg",
  "operatorName",
  "confirmedAt",
];

export const today = () => {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join(
    "-"
  );
};

export const formatError = (error: unknown) =>
  error instanceof Error ? error.message : "Could not load pressing scans";

export const countText = (value: number | string | null | undefined) => Number(value || 0).toLocaleString();

export const kgText = (value: number | string | null | undefined) =>
  Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 3 });

export const workerName = (name: string | null | undefined) => name?.trim() || "Display name not set";

export function usePressingHistoryReportState({
  active,
  companyId,
  userId,
  simpleMode = false,
}: {
  active: boolean;
  companyId: number;
  userId: string;
  simpleMode?: boolean;
}) {
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  const t = (key: Parameters<typeof translatePressingUiText>[0]) => translatePressingUiText(key, language);
  const [filters, setFilters] = useState<PressingReportFilters>({
    from: simpleMode ? undefined : today(),
    to: simpleMode ? undefined : today(),
    status: "active",
    mode: "condensed",
    page: 1,
    limit: 50,
  });
  const [search, setSearch] = useState("");
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showCorrections, setShowCorrections] = useState(false);
  const [initialDate, setInitialDate] = useState(false);
  const [hourlyDay, setHourlyDay] = useState("");
  const [hourlySnapshot, setHourlySnapshot] = useState<{ companyId: number; data?: PressingHourlySnapshot } | null>(
    null
  );
  const onHourlyData = useCallback((data: PressingHourlySnapshot | undefined, sourceCompanyId: number) => {
    setHourlySnapshot({ companyId: sourceCompanyId, data });
  }, []);
  const invalidDates = Boolean(
    filters.from &&
    filters.to &&
    (filters.from > filters.to ||
      (filters.from === filters.to && !!filters.fromTime && !!filters.toTime && filters.fromTime > filters.toTime))
  );
  const key = [ROOT, "data", companyId, userId];

  const options = useQuery<PressingReportOptions>({
    queryKey: [ROOT, "options", companyId, userId],
    enabled: active,
    queryFn: async () => {
      const response = await fetch(ROOT + "/options", { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("Could not load pressing filter options");
      return response.json();
    },
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const day = options.data?.serverToday;
    if (simpleMode || !day || initialDate) return;
    setInitialDate(true);
    setFilters((current) => ({ ...current, from: day, to: day, page: 1 }));
  }, [options.data?.serverToday, initialDate, simpleMode]);
  useEffect(() => {
    if (options.data?.serverToday) setHourlyDay(options.data.serverToday);
  }, [companyId, options.data?.serverToday]);

  const report = useQuery({
    queryKey: [...key, filters],
    enabled: active && !invalidDates,
    queryFn: () => fetchPressingReport(filters),
    staleTime: 0,
    refetchInterval: active ? 30000 : false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const update = (value: Partial<PressingReportFilters>) =>
    setFilters((current) => ({ ...current, ...value, asOf: undefined, page: 1 }));
  const canSeeEveryone = options.data?.canViewAll === true;
  const canCorrect = options.data?.canCorrect === true;
  const summary = report.data?.summary;
  const kpiSummary = report.data?.overview || summary;
  // The four daily KPI cards are the sum of the exact same 07:00–17:00
  // server-confirmed hourly rows displayed underneath, for the same Beirut date.
  // History filters below remain independent and can cover larger periods.
  const sameHourlyDay =
    hourlySnapshot?.companyId === companyId && hourlySnapshot.data?.day === (hourlyDay || options.data?.serverToday);
  const byOperator = simpleMode
    ? kpiSummary?.byOperator || []
    : pressingHourlyKpiTotals(sameHourlyDay ? hourlySnapshot?.data : undefined);
  const detail = (report.data?.rows || []).filter((row): row is PressingDetailRow => "id" in row);
  const condensed = (report.data?.rows || []).filter((row): row is PressingCondensedRow => !("id" in row));
  const pageCount = Math.max(1, Math.ceil((report.data?.total || 0) / filters.limit));
  const operators = options.data?.operators || [];
  const weightOptions = options.data?.weightsKg || [];

  // The account login identifies the worker; the visible KPI title is the
  // current Factory profile display name, not P1/P2/P3.
  const workers = pressingKpiWorkers(operators, byOperator);

  const allWorkerBales = workers.reduce((sum, worker) => sum + worker.bales, 0);
  const allWorkerKg = workers.reduce((sum, worker) => sum + worker.kg, 0);

  const selectWorker = (selectedId?: string) =>
    update({
      userId: filters.userId === selectedId ? undefined : selectedId,
    });
  return {
    active,
    allWorkerBales,
    allWorkerKg,
    canCorrect,
    canSeeEveryone,
    companyId,
    condensed,
    detail,
    exporting,
    filters,
    historyExpanded,
    hourlyDay,
    invalidDates,
    key,
    onHourlyData,
    operators,
    options,
    pageCount,
    report,
    sameHourlyDay,
    search,
    selectWorker,
    setExporting,
    setFilters,
    setHistoryExpanded,
    setHourlyDay,
    setSearch,
    setShowCorrections,
    showCorrections,
    simpleMode,
    summary,
    t,
    toast,
    update,
    userId,
    weightOptions,
    workers,
  };
}
