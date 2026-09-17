import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Download,
  Loader2,
  LockKeyhole,
  MessageCircle,
  Save,
  Search,
  Target,
  Upload,
  Users,
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

type PeriodType = "daily" | "weekly" | "monthly";
type TrackingStatus = (typeof FACTORY_TRACKING_STATUSES)[keyof typeof FACTORY_TRACKING_STATUSES];

interface ProductionRow {
  personType: "worker";
  personId: number;
  name: string;
  code: string | null;
  groupName?: string;
  category: string;
  targetBales: number | null;
  producedBales: number | null;
  status: TrackingStatus;
  notes: string;
  active: boolean;
}

interface ProductionResponse {
  page: "production";
  periodType: PeriodType;
  periodStart: string;
  periodEnd: string;
  finalized?: boolean;
  finalizedAt?: string | null;
  rows: ProductionRow[];
}

interface ProductionGroup {
  label: string;
  rows: ProductionRow[];
}

interface ImportedProductionTarget {
  category: string;
  targetBales: number | null;
}

function localDateStr(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addIsoDays(value: string, days: number): string {
  const date = parseLocalDate(value);
  date.setDate(date.getDate() + days);
  return localDateStr(date);
}

function periodFor(type: PeriodType, referenceDate: string) {
  const date = parseLocalDate(referenceDate);
  if (type === "daily") return { start: referenceDate, end: referenceDate };
  if (type === "monthly") {
    return {
      start: localDateStr(new Date(date.getFullYear(), date.getMonth(), 1)),
      end: localDateStr(new Date(date.getFullYear(), date.getMonth() + 1, 0)),
    };
  }

  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(date);
  start.setDate(date.getDate() + mondayOffset);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: localDateStr(start), end: localDateStr(end) };
}

function differenceText(target: number | null, produced: number | null) {
  if (target === null || produced === null) return "—";
  const difference = produced - target;
  return difference > 0 ? `+${difference}` : String(difference);
}

function differenceClass(target: number | null, produced: number | null) {
  if (target === null || produced === null) return "text-muted-foreground";
  const difference = produced - target;
  if (difference > 0) return "text-emerald-600 dark:text-emerald-400";
  if (difference < 0) return "text-red-600 dark:text-red-400";
  return "text-foreground";
}

function statusTranslationKey(status: TrackingStatus): FactoryStaffTrackingTranslationKey {
  if (status === FACTORY_TRACKING_STATUSES.absent) return "absent";
  if (status === FACTORY_TRACKING_STATUSES.new) return "new";
  return "present";
}

function normalizeExcelHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function normalizeWorkerCode(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase();
}

function groupProductionRows(sourceRows: ProductionRow[]): ProductionGroup[] {
  const groups = new Map<string, ProductionGroup>();

  for (const row of sourceRows) {
    const label = row.groupName?.trim() || row.category.trim();
    const key = label.toLocaleLowerCase();
    const existing = groups.get(key);
    if (existing) existing.rows.push(row);
    else groups.set(key, { label, rows: [row] });
  }

  return [...groups.values()]
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base", numeric: true }))
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true })
      ),
    }));
}

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

function CategoryInput({
  value,
  placeholder,
  disabled,
  onCommit,
}: {
  value: string;
  placeholder: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <Input
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      placeholder={placeholder}
      className="h-8 w-full min-w-0"
    />
  );
}

async function fetchProduction(periodType: PeriodType, start: string, end: string): Promise<ProductionResponse> {
  const params = new URLSearchParams({
    page: "production",
    periodType,
    periodStart: start,
    periodEnd: end,
  });
  const response = await factoryApiRequest("GET", `/api/factory/staff-tracking?${params.toString()}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed (${response.status})`);
  }
  return response.json();
}

function waitForReportPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export default function FactoryProductionTargets() {
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  const tr = (key: FactoryStaffTrackingTranslationKey) => translateFactoryStaffTrackingText(key, language);
  const [periodType, setPeriodType] = useState<PeriodType>("daily");
  const [referenceDate, setReferenceDate] = useState(() => localDateStr(new Date()));
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<ProductionRow[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const productionReportRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const period = useMemo(() => periodFor(periodType, referenceDate), [periodType, referenceDate]);

  const { data, isLoading } = useQuery<ProductionResponse>({
    queryKey: ["/api/factory/staff-tracking", "production", periodType, period.start, period.end],
    queryFn: () => fetchProduction(periodType, period.start, period.end),
  });

  useEffect(() => {
    setRows([]);
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

  const saveMutation = useMutation({
    mutationFn: async () => {
      const response = await factoryApiRequest("POST", "/api/factory/staff-tracking/bulk", {
        page: "production",
        periodType,
        periodStart: period.start,
        periodEnd: period.end,
        finalize: false,
        records: buildRecords(),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || tr("saveDataFailed"));
      }
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["/api/factory/staff-tracking"],
        refetchType: "active",
      });
      toast({ title: tr("productionSaved") });
    },
    onError: (error: Error) => {
      toast({ title: tr("saveFailed"), description: error.message, variant: "destructive" });
    },
  });

  const downloadExcelTemplate = async () => {
    try {
      const { ExcelJS, writeFile } = await import("@/lib/excelHelper");
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet(tr("productionTargets"));
      worksheet.columns = [
        { header: "Worker Code", key: "workerCode", width: 20 },
        { header: tr("category"), key: "category", width: 28 },
        { header: tr("target"), key: "target", width: 14 },
      ];
      rows.forEach((row) => {
        worksheet.addRow({
          workerCode: row.code || "",
          category: row.category || "",
          target: row.targetBales ?? "",
        });
      });
      worksheet.getRow(1).font = { bold: true };
      worksheet.views = [{ state: "frozen", ySplit: 1 }];
      await writeFile(workbook, `production-targets-template-${period.start}.xlsx`);
    } catch (error: unknown) {
      toast({
        title: tr("templateDownloadFailed"),
        description: error instanceof Error ? error.message : tr("couldNotCreateExcelTemplate"),
        variant: "destructive",
      });
    }
  };

  const importProductionTargets = async (file: File) => {
    setIsImporting(true);
    try {
      const { readFile, utils } = await import("@/lib/excelHelper");
      const workbook = await readFile(file);
      const worksheet = workbook.worksheets[0];
      if (!worksheet) throw new Error(tr("workbookMissingWorksheet"));

      const headers = new Set<string>();
      worksheet.getRow(1).eachCell((cell) => headers.add(normalizeExcelHeader(cell.text)));
      for (const requiredHeader of ["worker code", "category", "target"]) {
        if (!headers.has(requiredHeader)) {
          throw new Error([tr("missingRequiredColumn"), requiredHeader].join(": "));
        }
      }

      const importedRows = utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: "" });
      if (importedRows.length === 0) throw new Error(tr("excelNoWorkerRows"));

      const importedByCode = new Map<string, ImportedProductionTarget>();
      for (const importedRow of importedRows) {
        const normalizedRow = new Map<string, unknown>();
        Object.entries(importedRow).forEach(([key, value]) => normalizedRow.set(normalizeExcelHeader(key), value));
        const workerCode = normalizeWorkerCode(normalizedRow.get("worker code"));
        if (!workerCode) continue;
        if (importedByCode.has(workerCode)) {
          throw new Error([tr("duplicateWorkerCodeInExcel"), workerCode].join(": "));
        }

        const category = String(normalizedRow.get("category") ?? "").trim();
        const targetValue = normalizedRow.get("target");
        const targetText = String(targetValue ?? "").trim();
        const targetBales = targetText === "" ? null : Number(targetValue);
        if (targetBales !== null && (!Number.isFinite(targetBales) || targetBales < 0)) {
          throw new Error([tr("invalidTargetForWorkerCode"), workerCode].join(" "));
        }
        importedByCode.set(workerCode, { category, targetBales });
      }

      if (importedByCode.size === 0) throw new Error(tr("noWorkerCodesFound"));

      const unmatchedCodes = new Set(importedByCode.keys());
      let matchedCount = 0;
      const nextRows = rows.map((row) => {
        if (!row.code) return row;
        const code = normalizeWorkerCode(row.code);
        const imported = importedByCode.get(code);
        if (!imported) return row;
        unmatchedCodes.delete(code);
        matchedCount += 1;
        return { ...row, category: imported.category, targetBales: imported.targetBales };
      });

      if (matchedCount === 0) throw new Error(tr("noMatchingWorkerCodes"));

      const response = await factoryApiRequest("POST", "/api/factory/staff-tracking/bulk", {
        page: "production",
        periodType,
        periodStart: period.start,
        periodEnd: period.end,
        finalize: false,
        records: buildRecords(nextRows),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || tr("couldNotSaveImportedProductionTargets"));
      }

      setRows(nextRows);
      void queryClient.invalidateQueries({
        queryKey: ["/api/factory/staff-tracking"],
        refetchType: "active",
      });
      toast({
        title: [tr("productionTargetsImported"), matchedCount].join(": "),
        description:
          unmatchedCodes.size > 0
            ? `${unmatchedCodes.size} ${tr("workerCodesNotFoundSkipped")}`
            : tr("categoryTargetSaved"),
      });
    } catch (error: unknown) {
      toast({
        title: tr("excelImportFailed"),
        description: error instanceof Error ? error.message : tr("couldNotImportProductionTargets"),
        variant: "destructive",
      });
    } finally {
      setIsImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

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

  const setRow = (index: number, patch: Partial<ProductionRow>) => {
    if (finalized) return;
    setRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  };

  const busy =
    saveMutation.isPending || isImporting || sendWhatsappMutation.isPending || endProductionMutation.isPending;

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
            variant="outline"
            onClick={() => void downloadExcelTemplate()}
            disabled={rows.length === 0 || busy}
            data-testid="button-production-excel-template"
          >
            <Download className="mr-2 h-4 w-4" />
            {tr("excelTemplate")}
          </Button>

          <input
            ref={importInputRef}
            type="file"
            accept=".xlsx,.csv"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importProductionTargets(file);
            }}
          />
          <Button
            variant="outline"
            onClick={() => importInputRef.current?.click()}
            disabled={finalized || rows.length === 0 || busy}
            data-testid="button-import-production-excel"
          >
            {isImporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            {isImporting ? tr("importing") : tr("importExcel")}
          </Button>

          <Button
            onClick={() => saveMutation.mutate()}
            disabled={finalized || rows.length === 0 || busy}
            data-testid="button-save-production"
          >
            {saveMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {saveMutation.isPending ? tr("saving") : tr("save")}
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

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryTile label={tr("totalTarget")} value={totals.target} icon={<Target className="h-5 w-5" />} />
        <SummaryTile label={tr("balesProduced")} value={totals.produced} icon={<CheckCircle2 className="h-5 w-5" />} />
        <SummaryTile
          label={tr("difference")}
          value={totals.difference > 0 ? `+${totals.difference}` : totals.difference}
          icon={<ClipboardCheck className="h-5 w-5" />}
        />
        <SummaryTile label={tr("people")} value={rows.length} icon={<Users className="h-5 w-5" />} />
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
                    const sourceIndex = rows.findIndex((item) => item.personId === row.personId);
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
                        <TableCell className="w-[150px] min-w-[150px] max-w-[150px]">
                          <CategoryInput
                            value={row.category}
                            disabled={finalized}
                            onCommit={(category) => setRow(sourceIndex, { category })}
                            placeholder={tr("categoryStation")}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min="0"
                            step="1"
                            disabled={finalized}
                            className="h-8 text-right tabular-nums"
                            value={row.targetBales ?? ""}
                            onChange={(event) =>
                              setRow(sourceIndex, {
                                targetBales: event.target.value === "" ? null : Number(event.target.value),
                              })
                            }
                          />
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
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "12px",
            marginBottom: "20px",
          }}
        >
          {[
            [tr("totalTarget"), totals.target],
            [tr("balesProduced"), totals.produced],
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
