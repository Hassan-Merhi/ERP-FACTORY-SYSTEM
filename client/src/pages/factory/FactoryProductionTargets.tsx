import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
  FileDown,
  Loader2,
  LockKeyhole,
  MessageCircle,
  Search,
  SlidersHorizontal,
  Target,
  Users,
  UserX,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useToast } from "@/hooks/use-toast";
import {
  FACTORY_TRACKING_STATUSES,
  translateFactoryStaffTrackingText,
  type FactoryStaffTrackingTranslationKey,
} from "@/i18n/factoryStaffTrackingTranslations";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import {
  addIsoDays,
  collapseLinkedProductionRows,
  differenceClass,
  differenceText,
  fetchProduction,
  groupProductionRows,
  localDateStr,
  periodFor,
  statusTranslationKey,
  summarizeProductionRows,
  waitForReportPaint,
  type PeriodType,
  type ProductionGroup,
  type ProductionResponse,
  type ProductionRow,
} from "./factoryProductionTargetsModel";
import { ProductionTargetDefaultsDialog } from "./productiontargets/ProductionTargetDefaultsDialog";
import { ProductionTargetsEditorDialog } from "./productiontargets/ProductionTargetsEditorDialog";
import { ProductionExcelRangeDialog, type ProductionExportDates } from "./productiontargets/ProductionExcelRangeDialog";
import { ProductionTargetsDateRangeDialog, type ProductionTargetsDateRange } from "./productiontargets/ProductionTargetsDateRangeDialog";
import { ChevronDown, Coins } from "lucide-react";
import "./productiontargets/productionTargetsPremium.css";
import { useLocation } from "wouter";
import type { AuthMe } from "@shared/apiTypes";


import { exportWeeklyProductionExcel, ProductionDateRangeError } from "./productiontargets/productionWeeklyExcel";

function PremiumKpiCard({
  label,
  value,
  icon,
  tone,
  subline,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  tone: "violet" | "green" | "blue" | "amber" | "red";
  subline: React.ReactNode;
}) {
  return (
    <div className={`pt-kpi pt-kpi--${tone}`}>
      <div className="pt-kpi-top">
        <span className="pt-kpi-icon" aria-hidden="true">{icon}</span>
        <div className="min-w-0">
          <div className="pt-kpi-label">{label}</div>
          <div className="pt-kpi-value" title={String(value)}>{value}</div>
        </div>
      </div>
      <div>
        <div className="pt-kpi-rule" aria-hidden="true" />
        <div className="pt-kpi-foot">{subline}</div>
      </div>
    </div>
  );
}

export default function FactoryProductionTargets() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { data: session } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"], staleTime: 60000 });
  const bonusRole = session?.currentRole ?? session?.role;
  const canManageBonuses = bonusRole === "Admin" || bonusRole === "Owner";
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
  const period = useMemo(() =>
    periodType === "daily" ? periodFor("daily", referenceDate) : (customRange ?? periodFor(periodType, referenceDate)),
  [periodType, referenceDate, customRange]);

  const { data, isLoading } = useQuery<ProductionResponse>({
    queryKey: ["/api/factory/staff-tracking", "production", periodType, period.start, period.end],
    queryFn: () => fetchProduction(periodType, period.start, period.end),
  });

  useEffect(() => {
    setRows([]);
    setEditorOpen(false);
    setDefaultsEditorOpen(false);
  }, [periodType, period.start, period.end]);

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
      const absent = periodType === "daily"
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
    () => periodType === "daily"
      ? 0
      : rows.reduce((sum, row) => sum + (row.missingTargetDays ?? 0), 0),
    [rows, periodType],
  );
  const workerTotals = useMemo(
    () => ({
      total: rows.length,
      present: rows.filter((row) => periodType === "daily"
        ? row.status === FACTORY_TRACKING_STATUSES.present
        : (row.absentDays ?? 0) === 0).length,
      absent: rows.filter((row) => periodType === "daily"
        ? row.status === FACTORY_TRACKING_STATUSES.absent
        : (row.absentDays ?? 0) > 0).length,
    }),
    [rows, periodType]
  );

  const busy = sendWhatsappMutation.isPending || endProductionMutation.isPending || exportWeeklyMutation.isPending;

  return (
    <div className="production-targets-modern space-y-4">
      <div className="pt-hero">
        <div className="pt-hero-intro">
          <div className="pt-hero-icon" aria-hidden="true"><Target className="h-8 w-8" /></div>
          <div>
            <h2>{tr("productionTargets")}</h2>
          </div>
          <p className="pt-hero-description">{tr("productionSubtitle")}</p>
          </div>
        </div>

        <div className="pt-hero-controls">
          <div className="space-y-1">
            <p className="pt-control-label">{tr("period")}</p>
            <Select value={periodType} onValueChange={(value) => {
              setPeriodType(value as PeriodType);
              setCustomRange(null);
            }} disabled={busy}>
              <SelectTrigger className="w-[130px]" data-testid="select-production-period-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">{tr("daily")}</SelectItem>
                <SelectItem value="weekly">{tr("weekly")}</SelectItem>
                <SelectItem value="monthly">{tr("monthly")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <p className="pt-control-label">{periodType === "daily" ? tr("referenceDate") : "Date range"}</p>
            {periodType === "daily" ? (
              <Input
                type="date"
                value={referenceDate}
                onChange={(event) => setReferenceDate(event.target.value)}
                className="w-[155px]"
                disabled={busy}
              />
            ) : (
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 gap-2 tabular-nums"
                  onClick={() => setDateRangeOpen(true)}
                  disabled={busy}
                  title="Choose start and end dates from the calendar"
                  data-testid="button-production-targets-date-range"
                >
                  <CalendarDays className="h-4 w-4" />
                  {period.start} — {period.end}
                </Button>
                {customRange && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setCustomRange(null)}
                    disabled={busy}
                    data-testid="button-reset-production-targets-date-range"
                    title={periodType === "weekly" ? "Restore full week" : "Restore full month"}
                  >
                    Reset
                  </Button>
                )}
              </div>
            )}
          </div>

          {periodType === "daily" && (
            <Button
              variant="outline"
              onClick={() => setDefaultsEditorOpen(true)}
              disabled={rows.length === 0 || busy}
              data-testid="button-edit-production-default-targets"
            >
              <CalendarClock className="mr-2 h-4 w-4" />
              {tr("defaultTargets")}
            </Button>
          )}

          <Button
            variant="outline"
            onClick={() => setExcelRangeOpen(true)}
            disabled={busy}
            title={tr("weeklyExcelTooltip")}
            data-testid="button-export-production-weekly-excel"
          >
            {exportWeeklyMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileDown className="mr-2 h-4 w-4" />
            )}
            {exportWeeklyMutation.isPending ? tr("exportingWeeklyExcel") : tr("exportProductionExcel")}
          </Button>

          <Button
            className="pt-btn-primary"
            onClick={() => {
              if (periodType !== "daily") {
                setPeriodType("daily");
                return;
              }
              setEditorOpen(true);
            }}
            disabled={finalized || rows.length === 0 || busy}
            title={periodType === "daily" ? undefined : "Period targets are a sum of daily targets. Switch to Daily to edit."}
            data-testid="button-edit-production-targets"
          >
            <SlidersHorizontal className="mr-2 h-4 w-4" />
            {periodType === "daily" ? tr("editTargets") : "Edit Daily Targets"}
          </Button>

          {periodType === "daily" && (
            <Button
              variant="outline"
              className="pt-btn-wa"
              onClick={() => sendWhatsappMutation.mutate()}
              disabled={rows.length === 0 || busy}
              data-testid="button-send-production-whatsapp"
            >
              {sendWhatsappMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <MessageCircle className="mr-2 h-4 w-4" />
              )}
              {sendWhatsappMutation.isPending ? tr("sendingWhatsappImage") : tr("sendWhatsappImage")}
            </Button>
          )}

          {periodType === "daily" && (
            <Button
              variant="outline"
              className="pt-btn-gold"
              onClick={() => endProductionMutation.mutate()}
              disabled={finalized || rows.length === 0 || busy}
              data-testid="button-end-production"
            >
              {endProductionMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <LockKeyhole className="mr-2 h-4 w-4" />
              )}
              {endProductionMutation.isPending ? tr("endingProduction") : tr("endProduction")}
            </Button>
          )}
        </div>
      </div>

      <div className="pt-note">
        <CalendarDays className="mr-1.5 inline h-3.5 w-3.5" />
        {period.start}
        {period.end !== period.start ? ` — ${period.end}` : ""}
        <span className="ml-3">{periodType === "daily" ? tr("useEditorToManageTargets")
          : "Targets and attendance are summed from each date in this period; edit individual days in Daily view."}</span>
      </div>

      {periodType !== "daily" && missingTargetDays > 0 && !isLoading && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300" role="status">
          {missingTargetDays} worker-day targets are not configured in this range.
          The target and expected totals include only recorded daily targets;
          differences are withheld until the missing targets are set.
        </div>
      )}

      {finalized && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <div className="text-sm font-semibold">{tr("productionLocked")}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{tr("productionLockedDetail")}</div>
          </div>
        </div>
      )}

      <div className="pt-kpi-grid">
        <PremiumKpiCard tone="violet" label={tr("totalTarget")} value={totals.target}
          icon={<Target className="h-6 w-6" />}
          subline={<span>{tr("absent")}: {totals.absentTarget}</span>} />
        <PremiumKpiCard tone="green" label={tr("totalWorkers")} value={workerTotals.total}
          icon={<Users className="h-6 w-6" />}
          subline={<><span>{tr("present")}: {workerTotals.present}</span><span>·</span><span>{tr("absent")}: {workerTotals.absent}</span></>} />
        <PremiumKpiCard tone="blue" label={tr("totalExpected")} value={totals.expected}
          icon={<ClipboardCheck className="h-6 w-6" />}
          subline={<span>{tr("expected")}</span>} />
        <PremiumKpiCard tone="amber" label={tr("totalProduced")} value={totals.produced}
          icon={<ClipboardCheck className="h-6 w-6" />}
          subline={<span>{tr("produced")}</span>} />
        <PremiumKpiCard tone={missingTargetDays > 0 ? "amber" : totals.difference < 0 ? "red" : "green"}
          label={tr("diff")}
          value={missingTargetDays > 0 ? "—" : totals.difference > 0 ? `+${totals.difference}` : totals.difference}
          icon={<UserX className="h-6 w-6" />}
          subline={<span>{missingTargetDays > 0 ? "Missing targets in selected period" : "Produced versus expected"}</span>} />
      </div>

      {periodType === "daily" && canManageBonuses && (
        <div className="pt-bonus-banner" data-testid="production-bonuses-launcher">
          <div className="flex items-center gap-3">
            <div className="pt-bonus-icon"><Coins className="h-6 w-6" /></div>
            <div>
              <p className="font-semibold">Production Bonuses</p>
              <p className="text-xs text-muted-foreground">
                Set rates, review calculations, approve worker bonuses and pay from Cash / Bank.
              </p>
            </div>
          </div>
          <Button type="button" className="pt-btn-violet" onClick={() => navigate("/factory/production-bonuses?date=" + referenceDate)}
            data-testid="button-open-production-bonuses">Open Production Bonuses</Button>
        </div>
      )}

      <div className="pt-filters">
        <div className="pt-filter-search relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder={tr("searchPlaceholder")} className="pl-9" aria-label={tr("searchPlaceholder")} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-[180px]" aria-label="Filter category" data-testid="select-production-category-filter">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categoryOptions.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[160px]" aria-label="Filter attendance" data-testid="select-production-attendance-filter">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="present">{tr("present")}</SelectItem>
              <SelectItem value="absent">{tr("absent")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="pt-staff-table">
        <Table mobileLayout="cards">
          <TableHeader>
            <TableRow className="border-b border-border/80 bg-muted/60 hover:bg-muted/60">
              <TableHead className="min-w-[240px] border-r border-border/70 text-sm font-semibold">
                {tr("person")}
              </TableHead>
              <TableHead className="w-[170px] min-w-[170px] max-w-[170px] border-r border-border/70 text-sm font-semibold">
                {tr("category")}
              </TableHead>
              <TableHead className="w-[125px] border-r border-border/70 text-right text-sm font-semibold">
                {tr("target")}
              </TableHead>
              <TableHead className="w-[120px] border-r border-border/70 text-right text-sm font-semibold">
                {tr("produced")}
              </TableHead>
              <TableHead className="w-[120px] border-r border-border/70 text-right text-sm font-semibold">
                {tr("difference")}
              </TableHead>
              <TableHead className="w-[155px] text-sm font-semibold">{tr("status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="py-12 text-center text-base text-muted-foreground">
                  {tr("loadingStaff")}
                </TableCell>
              </TableRow>
            ) : groupedVisibleRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-12 text-center text-base text-muted-foreground">
                  {tr("noMatchingStaff")}
                </TableCell>
              </TableRow>
            ) : (
              groupedVisibleRows.map((group, groupIndex) => (
                <Fragment key={group.label.toLocaleLowerCase() || "__blank-group__"}>
                  <TableRow className={`pt-category-row pt-category-row--${groupIndex % 4}`}>
                    <TableCell colSpan={6} className="py-2">
                      <button type="button" className="pt-category-toggle"
                        aria-expanded={!collapsedGroups.has(group.label)}
                        aria-label={`${collapsedGroups.has(group.label) ? "Expand" : "Collapse"} ${group.label || "Uncategorized"}`}
                        onClick={() => setCollapsedGroups((previous) => {
                          const next = new Set(previous);
                          if (next.has(group.label)) next.delete(group.label);
                          else next.add(group.label);
                          return next;
                        })}>
                        <span className="flex items-center gap-2.5">
                          <ChevronDown className={`h-4 w-4 transition-transform ${collapsedGroups.has(group.label) ? "-rotate-90" : ""}`} />
                          <span className="text-sm font-bold">{group.label || "—"}</span>
                        </span>
                        <span className="pt-category-count">{group.rows.length}</span>
                      </button>
                    </TableCell>
                  </TableRow>
                  {!collapsedGroups.has(group.label) && group.rows.map((row) => {
                    const members = row.displayMembers ?? [
                      {
                        personId: row.personId,
                        name: row.name,
                        code: row.code,
                        status: row.status,
                        active: row.active,
                      },
                    ];
                    const isAbsent = periodType !== "daily"
                      ? (row.absentDays ?? 0) > 0
                      : members.some((member) => member.status === FACTORY_TRACKING_STATUSES.absent);
                    const comparisonTarget = periodType === "daily"
                      ? row.targetBales
                      : (row.missingTargetDays ?? 0) > 0 || row.targetBales == null
                        ? null
                        : row.targetBales - (row.absentTargetBales ?? 0);
                    return (
                      <TableRow
                        key={row.linkGroupId != null ? `link-${row.linkGroupId}` : `worker-${row.personId}`}
                        className={`pt-worker-row border-b ${
                          isAbsent ? "bg-red-500/5 hover:bg-red-500/10" : ""
                        } ${!row.active ? "opacity-60" : ""}`}
                      >
                        <TableCell className="border-r border-border/70 py-3">
                          <div className="space-y-1" dir="auto">
                            {members.map((member) => (
                              <div
                                key={member.personId}
                                className={`text-base font-semibold leading-6 ${!member.active ? "opacity-60" : ""}`}
                              >
                                {member.name}
                              </div>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="w-[170px] min-w-[170px] max-w-[170px] border-r border-border/70">
                          <span className="pt-category-pill">{row.category || "—"}</span>
                        </TableCell>
                        <TableCell className="border-r border-border/70 text-right text-base font-semibold tabular-nums">
                          {row.targetBales ?? "—"}
                        </TableCell>
                        <TableCell className="border-r border-border/70 text-right text-base font-semibold tabular-nums">
                          {row.producedBales ?? 0}
                        </TableCell>
                        <TableCell
                          className={`border-r border-border/70 text-right text-base font-semibold tabular-nums ${differenceClass(comparisonTarget, row.producedBales)}`}
                        >
                          {differenceText(comparisonTarget, row.producedBales)}
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1.5">
                            {members.map((member) => {
                              const memberAbsent = periodType !== "daily"
                                ? (row.absentDays ?? 0) > 0
                                : member.status === FACTORY_TRACKING_STATUSES.absent;
                              return (
                                <div
                                  key={member.personId}
                                  className={`pt-status-pill ${memberAbsent ? "pt-status-pill--absent" : ""}`}
                                  aria-disabled="true"
                                  title={periodType === "daily"
                                    ? `${member.name}: ${tr("statusControlledFromAttendance")}`
                                    : `${member.name}: ${row.absentDays ?? 0} absent out of ${row.periodDays ?? 0} roster days`}
                                >
                                  <LockKeyhole className="h-3.5 w-3.5 shrink-0" />
                                  <span>{periodType === "daily"
                                    ? tr(statusTranslationKey(member.status))
                                    : (row.absentDays ?? 0) > 0
                                      ? `${tr("absent")} ${row.absentDays}/${row.periodDays ?? 0}`
                                      : tr("present")}</span>
                                </div>
                              );
                            })}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {periodType !== "daily" && (
        <ProductionTargetsDateRangeDialog
          open={dateRangeOpen}
          onOpenChange={setDateRangeOpen}
          range={period}
          onApply={(nextRange) => {
            setCustomRange(nextRange);
            setDateRangeOpen(false);
          }}
        />
      )}

      <ProductionExcelRangeDialog
        open={excelRangeOpen}
        onOpenChange={setExcelRangeOpen}
        exporting={exportWeeklyMutation.isPending}
        onExport={(dates) => exportWeeklyMutation.mutate(dates)}
      />

      <ProductionTargetDefaultsDialog
        open={defaultsEditorOpen}
        onOpenChange={setDefaultsEditorOpen}
        rows={rows}
        effectiveFrom={referenceDate}
      />

      <ProductionTargetsEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        rows={rows}
        periodType={periodType}
        periodStart={period.start}
        periodEnd={period.end}
        finalized={finalized}
      />

      <div
        ref={productionReportRef}
        aria-hidden="true"
        style={{
          position: "fixed",
          left: "-12000px",
          top: 0,
          width: "1280px",
          background: "#111315",
          color: "#f4f4f5",
          padding: "30px",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div style={{ marginBottom: "20px", display: "flex", justifyContent: "space-between", alignItems: "end" }}>
          <div>
            <div style={{ fontSize: "28px", fontWeight: 700 }}>{tr("productionTargets")}</div>
            <div style={{ marginTop: "6px", color: "#a1a1aa", fontSize: "16px" }}>{referenceDate}</div>
          </div>
          <div style={{ color: "#a1a1aa", fontSize: "15px" }}>
            {rows.length} {tr("people")}
          </div>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", fontSize: "15px" }}>
          <thead>
            <tr style={{ background: "#292c31", color: "#f4f4f5" }}>
              <th style={{ width: "360px", padding: "13px 10px", textAlign: "left", border: "1px solid #3f444b" }}>
                {tr("worker")}
              </th>
              <th style={{ width: "260px", padding: "13px 10px", textAlign: "left", border: "1px solid #3f444b" }}>
                {tr("category")}
              </th>
              <th style={{ width: "110px", padding: "13px 10px", textAlign: "right", border: "1px solid #3f444b" }}>
                {tr("target")}
              </th>
              <th style={{ width: "110px", padding: "13px 10px", textAlign: "right", border: "1px solid #3f444b" }}>
                {tr("produced")}
              </th>
              <th style={{ width: "110px", padding: "13px 10px", textAlign: "right", border: "1px solid #3f444b" }}>
                {tr("difference")}
              </th>
              <th style={{ width: "130px", padding: "13px 10px", textAlign: "center", border: "1px solid #3f444b" }}>
                {tr("status")}
              </th>
            </tr>
          </thead>
          <tbody>
            {productionReportGroups.map((group) => (
              <Fragment key={`report-${group.label.toLocaleLowerCase() || "blank"}`}>
                <tr style={{ background: "#202328" }}>
                  <td colSpan={6} style={{ padding: "11px 12px", border: "1px solid #3f444b", fontWeight: 700 }}>
                    {group.label || "—"}{" "}
                    <span style={{ marginLeft: "8px", color: "#a1a1aa", fontWeight: 400 }}>({group.rows.length})</span>
                  </td>
                </tr>
                {group.rows.map((row, index) => {
                  const members = row.displayMembers ?? [
                    {
                      personId: row.personId,
                      name: row.name,
                      code: row.code,
                      status: row.status,
                      active: row.active,
                    },
                  ];
                  return (
                    <tr
                      key={
                        row.linkGroupId != null
                          ? `production-report-link-${row.linkGroupId}`
                          : `production-report-worker-${row.personId}`
                      }
                      style={{ background: index % 2 === 0 ? "#111315" : "#181a1e" }}
                    >
                      <td dir="auto" style={{ padding: "12px 10px", border: "1px solid #34383e", fontWeight: 600 }}>
                        {members.map((member) => (
                          <div key={member.personId}>{member.name}</div>
                        ))}
                      </td>
                      <td style={{ padding: "12px 10px", border: "1px solid #34383e", color: "#d4d4d8" }}>
                        {row.category || "—"}
                      </td>
                      <td
                        style={{
                          padding: "12px 10px",
                          textAlign: "right",
                          border: "1px solid #34383e",
                          fontWeight: 700,
                        }}
                      >
                        {row.targetBales ?? "—"}
                      </td>
                      <td
                        style={{
                          padding: "12px 10px",
                          textAlign: "right",
                          border: "1px solid #34383e",
                          fontWeight: 700,
                        }}
                      >
                        {row.producedBales ?? 0}
                      </td>
                      <td
                        style={{
                          padding: "12px 10px",
                          textAlign: "right",
                          border: "1px solid #34383e",
                          fontWeight: 700,
                        }}
                      >
                        {differenceText(row.targetBales, row.producedBales)}
                      </td>
                      <td
                        style={{
                          padding: "12px 10px",
                          textAlign: "center",
                          border: "1px solid #34383e",
                          fontWeight: 700,
                        }}
                      >
                        {members.map((member) => {
                          const statusColor =
                            member.status === FACTORY_TRACKING_STATUSES.absent
                              ? "#f87171"
                              : member.status === FACTORY_TRACKING_STATUSES.new
                                ? "#fbbf24"
                                : "#34d399";
                          return (
                            <div key={member.personId} style={{ color: statusColor }}>
                              {tr(statusTranslationKey(member.status))}
                            </div>
                          );
                        })}
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
            <tr style={{ background: "#292c31" }}>
              <td
                colSpan={2}
                style={{ padding: "16px 12px", border: "1px solid #3f444b", fontWeight: 800, fontSize: "17px" }}
              >
                {tr("dailyTotal")}
              </td>
              <td
                style={{
                  padding: "14px 10px",
                  textAlign: "right",
                  border: "1px solid #3f444b",
                  fontWeight: 800,
                  fontSize: "18px",
                }}
              >
                {totals.target}
              </td>
              <td
                style={{
                  padding: "14px 10px",
                  textAlign: "right",
                  border: "1px solid #3f444b",
                  fontWeight: 800,
                  fontSize: "18px",
                }}
              >
                {totals.produced}
              </td>
              <td
                style={{
                  padding: "14px 10px",
                  textAlign: "right",
                  border: "1px solid #3f444b",
                  fontWeight: 800,
                  fontSize: "18px",
                }}
              >
                {totals.difference > 0 ? `+${totals.difference}` : totals.difference}
              </td>
              <td
                style={{
                  padding: "14px 10px",
                  textAlign: "center",
                  border: "1px solid #3f444b",
                  fontWeight: 800,
                  fontSize: "18px",
                }}
              >
                {rows.length}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
