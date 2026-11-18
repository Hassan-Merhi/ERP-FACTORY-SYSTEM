// Extracted from ./FactoryProductionTargets.tsx to keep that module under the source-size cap.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useToast } from "@/hooks/use-toast";
import {
  FACTORY_TRACKING_STATUSES,
  type FactoryStaffTrackingTranslationKey,
  translateFactoryStaffTrackingText,
} from "@/i18n/factoryStaffTrackingTranslations";
import { factoryApiRequest } from "@/lib/factoryApi";
import { factoryActionCapabilities } from "@shared/factoryActionCapabilities";
import { queryClient } from "@/lib/queryClient";
import {
  addIsoDays,
  collapseLinkedProductionRows,
  fetchProduction,
  groupProductionRows,
  localDateStr,
  periodFor,
  type PeriodType,
  type ProductionGroup,
  type ProductionResponse,
  type ProductionRow,
  summarizeProductionRows,
  waitForReportPaint,
} from "./factoryProductionTargetsModel";
import type { ProductionExportDates } from "./productiontargets/ProductionExcelRangeDialog";
import type { ProductionTargetsDateRange } from "./productiontargets/ProductionTargetsDateRangeDialog";
import { useLocation } from "wouter";
import type { AuthMe, FactoryMyAccess } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { exportWeeklyProductionExcel, ProductionDateRangeError } from "./productiontargets/productionWeeklyExcel";

export function useFactoryProductionTargetsState() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { selectedCompany } = useCompany();
  const { data: access } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });
  const { data: session } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"], staleTime: 60000 });
  const bonusRole = session?.currentRole ?? session?.role;
  const canManageBonuses = factoryActionCapabilities({
    role: bonusRole,
    hasFactoryAccess: access?.companyId === selectedCompany?.id && access?.hasFactoryAccess === true,
  })["production.manage-bonuses"];
  const { language } = useApplicationLanguage();
  const tr = (key: FactoryStaffTrackingTranslationKey) => translateFactoryStaffTrackingText(key, language);
  const [periodType, setPeriodType] = useState<PeriodType>("daily");
  const [referenceDate, setReferenceDate] = useState(() => localDateStr(new Date()));
  const [customRange, setCustomRange] = useState<ProductionTargetsDateRange | null>(null);
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [rows, setRows] = useState<ProductionRow[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [defaultsEditorOpen, setDefaultsEditorOpen] = useState(false);
  const [excelRangeOpen, setExcelRangeOpen] = useState(false);
  const productionReportRef = useRef<HTMLDivElement>(null);
  const period = useMemo(
    () =>
      periodType === "daily"
        ? periodFor("daily", referenceDate)
        : (customRange ?? periodFor(periodType, referenceDate)),
    [periodType, referenceDate, customRange]
  );

  const { data, isLoading } = useQuery<ProductionResponse>({
    queryKey: companyQueryKey(
      "/api/factory/staff-tracking",
      selectedCompany?.id,
      "production",
      periodType,
      period.start,
      period.end
    ),
    enabled: Boolean(selectedCompany?.id),
    queryFn: () => fetchProduction(periodType, period.start, period.end),
  });

  useEffect(() => {
    setRows([]);
    setEditorOpen(false);
    setDefaultsEditorOpen(false);
  }, [selectedCompany?.id, periodType, period.start, period.end]);

  useEffect(() => {
    if (data) setRows(data.rows);
  }, [data]);

  const finalized = Boolean(data?.finalized);

  const buildRecords = (sourceRows: ProductionRow[] = rows) =>
    sourceRows.map((row) => ({
      personType: row.personType,
      personId: row.personId,
      groupName: row.groupName || "",
      category: row.category,
      categoryOverridden: row.categoryOverridden === true,
      targetBales: row.targetBales,
      targetBalesOverridden: row.targetBalesOverridden === true,
      producedBales: null,
      status: row.status,
      notes: "",
    }));

  const sendProductionWhatsappImage = async (reportDate: string) => {
    // Always refresh first so each manual send reflects the latest available production
    // counts, targets/categories, and Attendance Register-driven statuses for that day.
    const latestSnapshot = await fetchProduction("daily", reportDate, reportDate);
    setRows(latestSnapshot.rows);
    await waitForReportPaint();

    if (!productionReportRef.current) throw new Error(tr("productionWhatsappImageFailed"));

    const html2canvas = (await import("html2canvas")).default;
    const canvas = await html2canvas(productionReportRef.current, {
      backgroundColor: "#111315",
      scale: 2,
      logging: false,
    });
    const title = `${tr("productionTargets")} — ${reportDate}`;
    const response = await factoryApiRequest("POST", "/api/factory/send-mix-batch-image-whatsapp", {
      imageBase64: canvas.toDataURL("image/png"),
      date: reportDate,
      fileName: `Production_${reportDate}.png`,
      caption: title,
      reportLabel: title,
      recipient: "production",
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || tr("productionWhatsappImageFailed"));
    }
  };

  const sendWhatsappMutation = useMutation({
    mutationFn: () => sendProductionWhatsappImage(referenceDate),
    onSuccess: () => {
      toast({ title: tr("productionWhatsappImageSent") });
    },
    onError: (error: Error) => {
      toast({
        title: tr("productionWhatsappImageFailed"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const endProductionMutation = useMutation({
    mutationFn: async () => {
      const response = await factoryApiRequest("POST", "/api/factory/staff-tracking/bulk", {
        page: "production",
        periodType: "daily",
        periodStart: referenceDate,
        periodEnd: referenceDate,
        finalize: true,
        records: buildRecords(),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || tr("endProductionFailed"));
      }
      return response.json();
    },
    onSuccess: () => {
      const endedDate = referenceDate;
      toast({ title: tr("productionEnded") });
      void queryClient.invalidateQueries({
        queryKey: ["/api/factory/staff-tracking"],
        refetchType: "active",
      });
      setReferenceDate(addIsoDays(endedDate, 1));
    },
    onError: (error: Error) => {
      toast({ title: tr("endProductionFailed"), description: error.message, variant: "destructive" });
    },
  });

  const exportWeeklyMutation = useMutation({
    mutationFn: (dates: ProductionExportDates) => exportWeeklyProductionExcel(dates.start, dates.end),
    onSuccess: ({ start, end }) => {
      setExcelRangeOpen(false);
      toast({
        title: tr("weeklyExcelExported"),
        description: tr("weeklyExcelRange") + " " + start + " — " + end,
      });
    },
    onError: (error: Error) => {
      const description =
        error instanceof ProductionDateRangeError
          ? error.code === "tooLong"
            ? tr("exportRangeTooLong")
            : error.code === "future"
              ? tr("exportFutureDate")
              : tr("exportInvalidRange")
          : error.message;
      toast({ title: tr("weeklyExcelExportFailed"), description, variant: "destructive" });
    },
  });

  const collapsedRows = useMemo(() => collapseLinkedProductionRows(rows), [rows]);

  const categoryOptions = useMemo(
    () => Array.from(new Set(collapsedRows.map((row) => row.category || "—"))).sort((a, b) => a.localeCompare(b)),
    [collapsedRows]
  );

  const groupedVisibleRows = useMemo<ProductionGroup[]>(() => {
    const needle = search.trim().toLowerCase();
    const visibleRows = collapsedRows.filter((row) => {
      if (categoryFilter !== "all" && (row.category || "—") !== categoryFilter) return false;
      const absent =
        periodType === "daily"
          ? (row.displayMembers ?? [row]).some((member) => member.status === FACTORY_TRACKING_STATUSES.absent)
          : (row.absentDays ?? 0) > 0;
      if (statusFilter === "absent" && !absent) return false;
      if (statusFilter === "present" && absent) return false;
      const memberMatch = (row.displayMembers ?? []).some(
        (member) => member.name.toLowerCase().includes(needle) || (member.code || "").toLowerCase().includes(needle)
      );
      return (
        !needle ||
        memberMatch ||
        row.name.toLowerCase().includes(needle) ||
        row.category.toLowerCase().includes(needle) ||
        (row.groupName || "").toLowerCase().includes(needle) ||
        (row.code || "").toLowerCase().includes(needle)
      );
    });
    return groupProductionRows(visibleRows);
  }, [collapsedRows, search, categoryFilter, statusFilter, periodType]);

  const productionReportGroups = useMemo(() => groupProductionRows(collapsedRows), [collapsedRows]);

  const totals = useMemo(() => summarizeProductionRows(rows), [rows]);
  const missingTargetDays = useMemo(
    () => (periodType === "daily" ? 0 : rows.reduce((sum, row) => sum + (row.missingTargetDays ?? 0), 0)),
    [rows, periodType]
  );
  const workerTotals = useMemo(
    () => ({
      total: rows.length,
      present: rows.filter((row) =>
        periodType === "daily" ? row.status === FACTORY_TRACKING_STATUSES.present : (row.absentDays ?? 0) === 0
      ).length,
      absent: rows.filter((row) =>
        periodType === "daily" ? row.status === FACTORY_TRACKING_STATUSES.absent : (row.absentDays ?? 0) > 0
      ).length,
    }),
    [rows, periodType]
  );

  const busy = sendWhatsappMutation.isPending || endProductionMutation.isPending || exportWeeklyMutation.isPending;
  return {
    busy,
    canManageBonuses,
    categoryFilter,
    categoryOptions,
    collapsedGroups,
    customRange,
    dateRangeOpen,
    defaultsEditorOpen,
    editorOpen,
    endProductionMutation,
    excelRangeOpen,
    exportWeeklyMutation,
    finalized,
    groupedVisibleRows,
    isLoading,
    missingTargetDays,
    navigate,
    period,
    periodType,
    productionReportGroups,
    productionReportRef,
    referenceDate,
    rows,
    search,
    sendWhatsappMutation,
    setCategoryFilter,
    setCollapsedGroups,
    setCustomRange,
    setDateRangeOpen,
    setDefaultsEditorOpen,
    setEditorOpen,
    setExcelRangeOpen,
    setPeriodType,
    setReferenceDate,
    setSearch,
    setStatusFilter,
    statusFilter,
    totals,
    tr,
    workerTotals,
  };
}
