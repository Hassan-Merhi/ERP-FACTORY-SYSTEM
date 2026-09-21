import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  ClipboardCheck,
  Loader2,
  LockKeyhole,
  MessageCircle,
  Search,
  SlidersHorizontal,
  Target,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
  differenceClass,
  differenceText,
  fetchProduction,
  groupProductionRows,
  localDateStr,
  periodFor,
  statusTranslationKey,
  waitForReportPaint,
  type PeriodType,
  type ProductionGroup,
  type ProductionResponse,
  type ProductionRow,
} from "./factoryProductionTargetsModel";
import { ProductionTargetsEditorDialog } from "./productiontargets/ProductionTargetsEditorDialog";

function SummaryTile({ label, value, icon }: { label: string; value: string | number; icon: React.ReactNode }) {
  return (
    <Card className="shadow-none">
      <CardContent className="flex items-center justify-between px-4 py-3">
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold tabular-nums">{value}</p>
        </div>
        <div className="text-muted-foreground">{icon}</div>
      </CardContent>
    </Card>
  );
}

function TargetProducedTile({
  targetLabel,
  producedLabel,
  target,
  produced,
}: {
  targetLabel: string;
  producedLabel: string;
  target: number;
  produced: number;
}) {
  return (
    <Card className="shadow-none" data-testid="kpi-production-target-produced">
      <CardContent className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-5">
          <div className="min-w-0">
            <p className="truncate text-xs text-muted-foreground">{targetLabel}</p>
            <p className="text-xl font-semibold tabular-nums">{target}</p>
          </div>
          <div className="min-w-0 border-l pl-5">
            <p className="truncate text-xs text-muted-foreground">{producedLabel}</p>
            <p className="text-xl font-semibold tabular-nums">{produced}</p>
          </div>
        </div>
        <div className="shrink-0 text-muted-foreground">
          <Target className="h-5 w-5" />
        </div>
      </CardContent>
    </Card>
  );
}

function PeopleSummaryTile({
  label,
  value,
  presentLabel,
  absentLabel,
  newLabel,
  present,
  absent,
  newlyJoined,
}: {
  label: string;
  value: number;
  presentLabel: string;
  absentLabel: string;
  newLabel: string;
  present: number;
  absent: number;
  newlyJoined: number;
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="cursor-help" tabIndex={0} data-testid="kpi-production-people">
            <SummaryTile label={label} value={value} icon={<Users className="h-5 w-5" />} />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="min-w-[180px] space-y-1.5 px-3 py-2" data-testid="tooltip-production-people">
          <div className="flex items-center justify-between gap-5">
            <span>{presentLabel}</span>
            <span className="font-semibold tabular-nums">{present}</span>
          </div>
          <div className="flex items-center justify-between gap-5">
            <span>{absentLabel}</span>
            <span className="font-semibold tabular-nums">{absent}</span>
          </div>
          {newlyJoined > 0 && (
            <div className="flex items-center justify-between gap-5">
              <span>{newLabel}</span>
              <span className="font-semibold tabular-nums">{newlyJoined}</span>
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
  const productionReportRef = useRef<HTMLDivElement>(null);
  const period = useMemo(() => periodFor(periodType, referenceDate), [periodType, referenceDate]);

  const { data, isLoading } = useQuery<ProductionResponse>({
    queryKey: ["/api/factory/staff-tracking", "production", periodType, period.start, period.end],
    queryFn: () => fetchProduction(periodType, period.start, period.end),
  });

  useEffect(() => {
    setRows([]);
    setEditorOpen(false);
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
      targetBales: row.targetBales,
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

  const groupedVisibleRows = useMemo<ProductionGroup[]>(() => {
    const needle = search.trim().toLowerCase();
    const visibleRows = rows.filter((row) => {
      return (
        !needle ||
        row.name.toLowerCase().includes(needle) ||
        row.category.toLowerCase().includes(needle) ||
        (row.groupName || "").toLowerCase().includes(needle) ||
        (row.code || "").toLowerCase().includes(needle)
      );
    });
    return groupProductionRows(visibleRows);
  }, [rows, search]);

  const productionReportGroups = useMemo(() => groupProductionRows(rows), [rows]);

  const totals = useMemo(() => {
    const target = rows.reduce((sum, row) => sum + (row.targetBales ?? 0), 0);
    const produced = rows.reduce((sum, row) => sum + (row.producedBales ?? 0), 0);
    return { target, produced, difference: produced - target };
  }, [rows]);

  const peopleBreakdown = useMemo(() => {
    const absent = rows.filter((row) => row.status === FACTORY_TRACKING_STATUSES.absent).length;
    const newlyJoined = rows.filter((row) => row.status === FACTORY_TRACKING_STATUSES.new).length;
    const present = rows.length - absent - newlyJoined;
    return { present, absent, newlyJoined };
  }, [rows]);

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

      <div className="grid gap-3 md:grid-cols-3">
        <TargetProducedTile
          targetLabel={tr("totalTarget")}
          producedLabel={tr("balesProduced")}
          target={totals.target}
          produced={totals.produced}
        />
        <SummaryTile
          label={tr("difference")}
          value={totals.difference > 0 ? `+${totals.difference}` : totals.difference}
          icon={<ClipboardCheck className="h-5 w-5" />}
        />
        <PeopleSummaryTile
          label={tr("people")}
          value={rows.length}
          presentLabel={tr("present")}
          absentLabel={tr("absent")}
          newLabel={tr("new")}
          present={peopleBreakdown.present}
          absent={peopleBreakdown.absent}
          newlyJoined={peopleBreakdown.newlyJoined}
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

      <div className="overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/60 hover:bg-muted/60">
              <TableHead className="min-w-[220px]">{tr("person")}</TableHead>
              <TableHead className="w-[150px] min-w-[150px] max-w-[150px]">{tr("category")}</TableHead>
              <TableHead className="w-[120px] text-right">{tr("target")}</TableHead>
              <TableHead className="w-[110px] text-right">{tr("produced")}</TableHead>
              <TableHead className="w-[110px] text-right">{tr("difference")}</TableHead>
              <TableHead className="w-[145px]">{tr("status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="py-12 text-center text-muted-foreground">
                  {tr("loadingStaff")}
                </TableCell>
              </TableRow>
            ) : groupedVisibleRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-12 text-center text-muted-foreground">
                  {tr("noMatchingStaff")}
                </TableCell>
              </TableRow>
            ) : (
              groupedVisibleRows.map((group) => (
                <Fragment key={group.label.toLocaleLowerCase() || "__blank-group__"}>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={6} className="border-y py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold">{group.label || "—"}</span>
                        <Badge variant="secondary" className="font-normal tabular-nums">
                          {group.rows.length}
                        </Badge>
                      </div>
                    </TableCell>
                  </TableRow>
                  {group.rows.map((row) => {
                    return (
                      <TableRow key={row.personId} className={!row.active ? "opacity-60" : undefined}>
                        <TableCell>
                          <div className="font-medium" dir="auto">
                            {row.name}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{tr("worker")}</span>
                            {row.code && <span>· {row.code}</span>}
                            {!row.active && (
                              <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                                {tr("inactive")}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="w-[150px] min-w-[150px] max-w-[150px] font-medium">
                          {row.category || "—"}
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {row.targetBales ?? "—"}
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {row.producedBales ?? 0}
                        </TableCell>
                        <TableCell
                          className={`text-right font-semibold tabular-nums ${differenceClass(row.targetBales, row.producedBales)}`}
                        >
                          {differenceText(row.targetBales, row.producedBales)}
                        </TableCell>
                        <TableCell>
                          <div
                            className="flex h-8 w-[125px] cursor-not-allowed items-center gap-2 rounded-md border bg-muted/70 px-3 text-sm text-muted-foreground"
                            aria-disabled="true"
                            title={tr("statusControlledFromAttendance")}
                          >
                            <LockKeyhole className="h-3.5 w-3.5 shrink-0" />
                            <span>{tr(statusTranslationKey(row.status))}</span>
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

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "12px",
            marginBottom: "20px",
          }}
        >
          {[
            [`${tr("totalTarget")} / ${tr("balesProduced")}`, `${totals.target} / ${totals.produced}`],
            [tr("difference"), totals.difference > 0 ? `+${totals.difference}` : totals.difference],
            [tr("people"), rows.length],
          ].map(([label, value]) => (
            <div
              key={String(label)}
              style={{ border: "1px solid #34383e", borderRadius: "10px", padding: "14px 16px", background: "#181a1e" }}
            >
              <div
                style={{
                  color: "#a1a1aa",
                  fontSize: "13px",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                {label}
              </div>
              <div style={{ marginTop: "5px", fontSize: "25px", fontWeight: 800 }}>{value}</div>
            </div>
          ))}
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", fontSize: "15px" }}>
          <thead>
            <tr style={{ background: "#292c31", color: "#f4f4f5" }}>
              <th style={{ width: "115px", padding: "13px 10px", textAlign: "left", border: "1px solid #3f444b" }}>
                {tr("code")}
              </th>
              <th style={{ width: "245px", padding: "13px 10px", textAlign: "left", border: "1px solid #3f444b" }}>
                {tr("worker")}
              </th>
              <th style={{ width: "180px", padding: "13px 10px", textAlign: "left", border: "1px solid #3f444b" }}>
                {tr("group")}
              </th>
              <th style={{ width: "190px", padding: "13px 10px", textAlign: "left", border: "1px solid #3f444b" }}>
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
                  <td colSpan={8} style={{ padding: "11px 12px", border: "1px solid #3f444b", fontWeight: 700 }}>
                    {group.label || "—"}{" "}
                    <span style={{ marginLeft: "8px", color: "#a1a1aa", fontWeight: 400 }}>({group.rows.length})</span>
                  </td>
                </tr>
                {group.rows.map((row, index) => {
                  const statusColor =
                    row.status === FACTORY_TRACKING_STATUSES.absent
                      ? "#f87171"
                      : row.status === FACTORY_TRACKING_STATUSES.new
                        ? "#fbbf24"
                        : "#34d399";
                  return (
                    <tr
                      key={`production-report-${row.personId}`}
                      style={{ background: index % 2 === 0 ? "#111315" : "#181a1e" }}
                    >
                      <td style={{ padding: "12px 10px", border: "1px solid #34383e", color: "#d4d4d8" }}>
                        {row.code || "—"}
                      </td>
                      <td dir="auto" style={{ padding: "12px 10px", border: "1px solid #34383e", fontWeight: 600 }}>
                        {row.name}
                      </td>
                      <td style={{ padding: "12px 10px", border: "1px solid #34383e", color: "#d4d4d8" }}>
                        {row.groupName || "—"}
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
                          color: statusColor,
                          fontWeight: 700,
                        }}
                      >
                        {tr(statusTranslationKey(row.status))}
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
            <tr style={{ background: "#292c31" }}>
              <td
                colSpan={4}
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
