import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Loader2,
  LockKeyhole,
  Save,
  Search,
  Target,
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

function statusClass(status: TrackingStatus) {
  if (status === FACTORY_TRACKING_STATUSES.absent)
    return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
  if (status === FACTORY_TRACKING_STATUSES.new)
    return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
}

function statusTranslationKey(status: TrackingStatus): FactoryStaffTrackingTranslationKey {
  if (status === FACTORY_TRACKING_STATUSES.absent) return "absent";
  if (status === FACTORY_TRACKING_STATUSES.new) return "new";
  return "present";
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

export default function FactoryProductionTargets() {
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  const tr = (key: FactoryStaffTrackingTranslationKey) => translateFactoryStaffTrackingText(key, language);
  const [periodType, setPeriodType] = useState<PeriodType>("daily");
  const [referenceDate, setReferenceDate] = useState(() => localDateStr(new Date()));
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<ProductionRow[]>([]);
  const period = useMemo(() => periodFor(periodType, referenceDate), [periodType, referenceDate]);

  const { data, isLoading, isFetching, refetch } = useQuery<ProductionResponse>({
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

  const buildRecords = () =>
    rows.map((row) => ({
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/factory/staff-tracking"] });
      await refetch();
      toast({ title: tr("productionSaved") });
    },
    onError: (error: Error) => {
      toast({ title: tr("saveFailed"), description: error.message, variant: "destructive" });
    },
  });

  const copyYesterdayMutation = useMutation({
    mutationFn: async () => {
      const yesterday = addIsoDays(referenceDate, -1);
      return fetchProduction("daily", yesterday, yesterday);
    },
    onSuccess: (previous) => {
      if (previous.rows.length === 0) {
        toast({ title: tr("noYesterdayProduction"), variant: "destructive" });
        return;
      }
      const previousByWorker = new Map(previous.rows.map((row) => [row.personId, row]));
      setRows((current) =>
        current.map((row) => {
          const prior = previousByWorker.get(row.personId);
          if (!prior) return row;
          return {
            ...row,
            category: prior.category,
            targetBales: prior.targetBales,
            status: prior.status,
          };
        })
      );
      toast({ title: tr("yesterdayCopied") });
    },
    onError: (error: Error) => {
      toast({ title: tr("copyYesterdayFailed"), description: error.message, variant: "destructive" });
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/factory/staff-tracking"] });
      toast({ title: tr("productionEnded") });
      setReferenceDate((current) => addIsoDays(current, 1));
    },
    onError: (error: Error) => {
      toast({ title: tr("endProductionFailed"), description: error.message, variant: "destructive" });
    },
  });

  const groupedVisibleRows = useMemo<ProductionGroup[]>(() => {
    const needle = search.trim().toLowerCase();
    const groups = new Map<string, ProductionGroup>();

    for (const row of rows) {
      const matches =
        !needle ||
        row.name.toLowerCase().includes(needle) ||
        row.category.toLowerCase().includes(needle) ||
        (row.groupName || "").toLowerCase().includes(needle) ||
        (row.code || "").toLowerCase().includes(needle);
      if (!matches) continue;

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
  }, [rows, search]);

  const totals = useMemo(() => {
    const target = rows.reduce((sum, row) => sum + (row.targetBales ?? 0), 0);
    const produced = rows.reduce((sum, row) => sum + (row.producedBales ?? 0), 0);
    return { target, produced, difference: produced - target };
  }, [rows]);

  const setRow = (index: number, patch: Partial<ProductionRow>) => {
    if (finalized) return;
    setRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  };

  const busy = saveMutation.isPending || copyYesterdayMutation.isPending || endProductionMutation.isPending;

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
              onClick={() => copyYesterdayMutation.mutate()}
              disabled={finalized || rows.length === 0 || isFetching || busy}
              data-testid="button-copy-yesterday-production"
            >
              {copyYesterdayMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Copy className="mr-2 h-4 w-4" />
              )}
              {copyYesterdayMutation.isPending ? tr("copyingYesterday") : tr("copyYesterday")}
            </Button>
          )}

          <Button
            onClick={() => saveMutation.mutate()}
            disabled={finalized || rows.length === 0 || isFetching || busy}
            data-testid="button-save-production"
          >
            {saveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            {saveMutation.isPending ? tr("saving") : tr("save")}
          </Button>

          {periodType === "daily" && (
            <Button
              variant="outline"
              onClick={() => endProductionMutation.mutate()}
              disabled={finalized || rows.length === 0 || isFetching || busy}
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
        {isFetching && !isLoading ? ` · ${tr("refreshing")}` : ""}
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
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tr("searchPlaceholder")} className="pl-9" />
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
                          <div className="font-medium" dir="auto">{row.name}</div>
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
                        <TableCell className="text-right font-semibold tabular-nums">{row.producedBales ?? 0}</TableCell>
                        <TableCell
                          className={`text-right font-semibold tabular-nums ${differenceClass(row.targetBales, row.producedBales)}`}
                        >
                          {differenceText(row.targetBales, row.producedBales)}
                        </TableCell>
                        <TableCell>
                          <Select
                            value={row.status}
                            disabled={finalized}
                            onValueChange={(value) => setRow(sourceIndex, { status: value as TrackingStatus })}
                          >
                            <SelectTrigger className="w-[125px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={FACTORY_TRACKING_STATUSES.present}>{tr("present")}</SelectItem>
                              <SelectItem value={FACTORY_TRACKING_STATUSES.absent}>{tr("absent")}</SelectItem>
                              <SelectItem value={FACTORY_TRACKING_STATUSES.new}>{tr("new")}</SelectItem>
                            </SelectContent>
                          </Select>
                          <Badge className={`mt-1.5 border-0 ${statusClass(row.status)}`}>
                            {tr(statusTranslationKey(row.status))}
                          </Badge>
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
    </div>
  );
}
