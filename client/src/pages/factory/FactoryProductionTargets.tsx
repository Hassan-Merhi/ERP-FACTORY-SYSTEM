import { searchAny } from "@shared/searchNormalization";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
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

function SummaryTile({ label, value, icon }: { label: string; value: string | number; icon: React.ReactNode }) {
  return (
    <Card className="h-full shadow-none sm:col-span-1 xl:col-span-1">
      <CardContent className="flex min-h-[108px] items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-2 text-3xl font-semibold leading-none tabular-nums">{value}</p>
        </div>
        <div className="shrink-0 rounded-lg border bg-muted/30 p-2 text-muted-foreground">{icon}</div>
      </CardContent>
    </Card>
  );
}

function SummaryGroupTile({
  label,
  icon,
  metrics,
}: {
  label: string;
  icon: React.ReactNode;
  metrics: Array<{ label: string; value: string | number; title?: string }>;
}) {
  return (
    <Card className="h-full overflow-hidden shadow-none sm:col-span-2 xl:col-span-2">
      <CardContent className="px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <div className="shrink-0 rounded-lg border bg-muted/30 p-2 text-muted-foreground">{icon}</div>
        </div>
        <div className="mt-3 grid w-full grid-cols-3 gap-2">
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className="min-w-0 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2.5 text-center"
              title={metric.title ?? metric.label}
            >
              <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:text-xs">
                {metric.label}
              </p>
              <p className="mt-2 text-2xl font-semibold leading-none tabular-nums sm:text-3xl" title={String(metric.value)}>
                {metric.value}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function FactoryProductionTargets() {
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  const tr = (key: FactoryStaffTrackingTranslationKey) => translateFactoryStaffTrackingText(key, language);
  const [periodType, setPeriodType] = useState<PeriodType>("daily");
  const [referenceDate, setReferenceDate] = useState(() => localDateStr(new Date()));
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<ProductionRow[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [defaultsEditorOpen, setDefaultsEditorOpen] = useState(false);
  const productionReportRef = useRef<HTMLDivElement>(null);
  const period = useMemo(() => periodFor(periodType, referenceDate), [periodType, referenceDate]);

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

  const collapsedRows = useMemo(() => collapseLinkedProductionRows(rows), [rows]);

  const groupedVisibleRows = useMemo<ProductionGroup[]>(() => {
    const needle = search.trim().toLowerCase();
    const visibleRows = collapsedRows.filter((row) => {
      const memberMatch = (row.displayMembers ?? []).some(
        (member) =>
          member.name.toLowerCase().includes(needle) ||
          (member.code || "").toLowerCase().includes(needle)
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
  }, [collapsedRows, search]);

  const productionReportGroups = useMemo(() => groupProductionRows(collapsedRows), [collapsedRows]);

  const totals = useMemo(() => summarizeProductionRows(rows), [rows]);
  const workerTotals = useMemo(
    () => ({
      total: rows.length,
      present: rows.filter((row) => row.status === FACTORY_TRACKING_STATUSES.present).length,
      absent: rows.filter((row) => row.status === FACTORY_TRACKING_STATUSES.absent).length,
    }),
    [rows]
  );

  const busy = sendWhatsappMutation.isPending || endProductionMutation.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Target className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">{tr("productionTargets")}</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{tr("productionSubtitle")}</p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{tr("period")}</p>
            <Select value={periodType} onValueChange={(value) => setPeriodType(value as PeriodType)} disabled={busy}>
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
            <p className="text-xs text-muted-foreground">{tr("referenceDate")}</p>
            <Input
              type="date"
              value={referenceDate}
              onChange={(event) => setReferenceDate(event.target.value)}
              className="w-[155px]"
              disabled={busy}
            />
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
            onClick={() => setEditorOpen(true)}
            disabled={finalized || rows.length === 0 || busy}
            data-testid="button-edit-production-targets"
          >
            <SlidersHorizontal className="mr-2 h-4 w-4" />
            {tr("editTargets")}
          </Button>

          {periodType === "daily" && (
            <Button
              variant="outline"
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

      <div className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <CalendarDays className="mr-1.5 inline h-3.5 w-3.5" />
        {period.start}
        {period.end !== period.start ? ` — ${period.end}` : ""}
        <span className="ml-3">{tr("useEditorToManageTargets")}</span>
      </div>

      {finalized && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <div className="text-sm font-semibold">{tr("productionLocked")}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{tr("productionLockedDetail")}</div>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <SummaryGroupTile
          label={tr("targets")}
          icon={<Target className="h-5 w-5" />}
          metrics={[
            { label: tr("total"), value: totals.target, title: tr("totalTarget") },
            { label: tr("absent"), value: totals.absentTarget, title: tr("totalAbsentTarget") },
            { label: tr("expected"), value: totals.expected, title: tr("totalExpected") },
          ]}
        />
        <SummaryGroupTile
          label={tr("workers")}
          icon={<Users className="h-5 w-5" />}
          metrics={[
            { label: tr("total"), value: workerTotals.total, title: tr("totalWorkers") },
            { label: tr("absent"), value: workerTotals.absent, title: tr("totalAbsent") },
            { label: tr("present"), value: workerTotals.present, title: tr("totalPresent") },
          ]}
        />
        <SummaryTile
          label={tr("totalProduced")}
          value={totals.produced}
          icon={<ClipboardCheck className="h-5 w-5" />}
        />
        <SummaryTile
          label={tr("diff")}
          value={totals.difference > 0 ? `+${totals.difference}` : totals.difference}
          icon={<UserX className="h-5 w-5" />}
        />
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={tr("searchPlaceholder")}
          className="pl-9"
        />
      </div>

      <div className="overflow-x-auto rounded-md border border-border/70">
        <Table>
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
              groupedVisibleRows.map((group) => (
                <Fragment key={group.label.toLocaleLowerCase() || "__blank-group__"}>
                  <TableRow className="border-y border-border/80 bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={6} className="py-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-base font-semibold">{group.label || "—"}</span>
                        <Badge variant="secondary" className="text-sm font-medium tabular-nums">
                          {group.rows.length}
                        </Badge>
                      </div>
                    </TableCell>
                  </TableRow>
                  {group.rows.map((row) => {
                    const members = row.displayMembers ?? [
                      {
                        personId: row.personId,
                        name: row.name,
                        code: row.code,
                        status: row.status,
                        active: row.active,
                      },
                    ];
                    const isAbsent = members.some(
                      (member) => member.status === FACTORY_TRACKING_STATUSES.absent
                    );
                    return (
                      <TableRow
                        key={row.linkGroupId != null ? `link-${row.linkGroupId}` : `worker-${row.personId}`}
                        className={`border-b border-border/70 hover:bg-muted/20 ${
                          isAbsent ? "bg-red-500/5 hover:bg-red-500/10" : ""
                        } ${!row.active ? "opacity-60" : ""}`}
                      >
                        <TableCell className="border-r border-border/70 py-3">
                          <div className="space-y-1" dir="auto">
                            {members.map((member) => (
                              <div
                                key={member.personId}
                                className={`text-base font-semibold leading-6 ${
                                  !member.active ? "opacity-60" : ""
                                }`}
                              >
                                {member.name}
                              </div>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="w-[170px] min-w-[170px] max-w-[170px] border-r border-border/70 text-base font-semibold">
                          {row.category || "—"}
                        </TableCell>
                        <TableCell className="border-r border-border/70 text-right text-base font-semibold tabular-nums">
                          {row.targetBales ?? "—"}
                        </TableCell>
                        <TableCell className="border-r border-border/70 text-right text-base font-semibold tabular-nums">
                          {row.producedBales ?? 0}
                        </TableCell>
                        <TableCell
                          className={`border-r border-border/70 text-right text-base font-semibold tabular-nums ${differenceClass(row.targetBales, row.producedBales)}`}
                        >
                          {differenceText(row.targetBales, row.producedBales)}
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1.5">
                            {members.map((member) => {
                              const memberAbsent = member.status === FACTORY_TRACKING_STATUSES.absent;
                              return (
                                <div
                                  key={member.personId}
                                  className={`flex min-h-8 w-[135px] cursor-not-allowed items-center gap-2 rounded-md border px-3 text-sm font-semibold ${
                                    memberAbsent
                                      ? "border-red-500/50 bg-red-500/15 text-red-500"
                                      : "border-border bg-muted/70 text-muted-foreground"
                                  }`}
                                  aria-disabled="true"
                                  title={`${member.name}: ${tr("statusControlledFromAttendance")}`}
                                >
                                  <LockKeyhole className="h-3.5 w-3.5 shrink-0" />
                                  <span>{tr(statusTranslationKey(member.status))}</span>
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
