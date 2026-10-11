import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, CheckCircle2, Clock3, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { InventoryLocation } from "./locationInventoryTypes";

type ScheduleFrequency = "daily" | "selected_days";

interface ScheduleConfig {
  locationId: number;
  enabled: boolean;
  frequency: ScheduleFrequency;
  daysOfWeek: number[];
  sendTime: string;
  timezone: string;
  includeCost: boolean;
  includeZeroStock: boolean;
  includeNegativeStock: boolean;
  stockGroupId: number | null;
  categoryId: number | null;
  lastAttemptAt: string | null;
  lastSentAt: string | null;
  lastScheduledFor: string | null;
  lastStatus: string | null;
  lastError: string | null;
  nextSendAt: string | null;
}

interface LookupRow {
  id: number;
  name: string;
  active?: boolean;
}

interface LocationWhatsappScheduleDialogProps {
  location: InventoryLocation;
  companyId?: number;
  canSendWithCost: boolean;
}

const DAYS = [
  { value: 1, label: releaseDebtEnglish("Mon") },
  { value: 2, label: releaseDebtEnglish("Tue") },
  { value: 3, label: releaseDebtEnglish("Wed") },
  { value: 4, label: releaseDebtEnglish("Thu") },
  { value: 5, label: releaseDebtEnglish("Fri") },
  { value: 6, label: releaseDebtEnglish("Sat") },
  { value: 0, label: releaseDebtEnglish("Sun") },
];

const COMMON_TIMEZONES = [
  "Africa/Lubumbashi",
  "Africa/Johannesburg",
  "Africa/Kinshasa",
  "Asia/Beirut",
  "Europe/London",
  "America/New_York",
  "UTC",
];

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function scheduleStatus(status: string | null) {
  if (status === "sent")
    return { label: releaseDebtEnglish("Sent"), Icon: CheckCircle2, className: "text-green-600 dark:text-green-400" };
  if (status === "failed") return { label: "Failed", Icon: XCircle, className: "text-destructive" };
  if (status === "skipped_empty")
    return {
      label: releaseDebtEnglish("No matching stock"),
      Icon: AlertTriangle,
      className: "text-amber-600 dark:text-amber-400",
    };
  if (status === "running")
    return { label: releaseDebtEnglish("Sending"), Icon: Clock3, className: "text-blue-600 dark:text-blue-400" };
  return null;
}

export function LocationWhatsappScheduleDialog({
  location,
  companyId,
  canSendWithCost,
}: LocationWhatsappScheduleDialogProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [frequency, setFrequency] = useState<ScheduleFrequency>("daily");
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [sendTime, setSendTime] = useState("18:00");
  const [timezone, setTimezone] = useState("Africa/Lubumbashi");
  const [includeCost, setIncludeCost] = useState(false);
  const [includeZeroStock, setIncludeZeroStock] = useState(false);
  const [includeNegativeStock, setIncludeNegativeStock] = useState(true);
  const [stockGroupId, setStockGroupId] = useState<string>("all");
  const [categoryId, setCategoryId] = useState<string>("all");

  const whatsappReady = Boolean(location.whatsappGroupChatId && location.whatsappStockReportsEnabled);

  const scheduleQuery = useQuery<ScheduleConfig>({
    queryKey: ["/api/locations", location.id, "whatsapp-schedule", companyId],
    queryFn: async () => {
      const response = await fetch(`/api/locations/${location.id}/whatsapp-schedule`, { credentials: "include" });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message || `Failed to load schedule: ${response.status}`);
      }
      return response.json();
    },
    enabled: open && !!companyId,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const stockGroupsQuery = useQuery<LookupRow[]>({
    queryKey: companyId ? ["/api/stock-groups", companyId, "location-stock-schedule"] : [],
    queryFn: async () => {
      const response = await fetch("/api/stock-groups", { credentials: "include" });
      if (!response.ok) throw new Error(releaseDebtEnglish("Failed to load stock groups"));
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    },
    enabled: open && !!companyId,
    staleTime: 5 * 60 * 1000,
  });

  const categoriesQuery = useQuery<LookupRow[]>({
    queryKey: companyId ? ["/api/stock-categories", companyId, "location-stock-schedule"] : [],
    queryFn: async () => {
      const response = await fetch("/api/stock-categories", { credentials: "include" });
      if (!response.ok) throw new Error(releaseDebtEnglish("Failed to load stock categories"));
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    },
    enabled: open && !!companyId,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    const schedule = scheduleQuery.data;
    if (!open || !schedule) return;
    setEnabled(schedule.enabled);
    setFrequency(schedule.frequency);
    setDaysOfWeek(schedule.daysOfWeek?.length ? schedule.daysOfWeek : [0, 1, 2, 3, 4, 5, 6]);
    setSendTime(schedule.sendTime || "18:00");
    setTimezone(schedule.timezone || "Africa/Lubumbashi");
    // Preserve a sensitive existing configuration; a viewer without cost access
    // must explicitly downgrade it before they can save other schedule changes.
    setIncludeCost(schedule.includeCost);
    setIncludeZeroStock(schedule.includeZeroStock);
    setIncludeNegativeStock(schedule.includeNegativeStock);
    setStockGroupId(schedule.stockGroupId == null ? "all" : String(schedule.stockGroupId));
    setCategoryId(schedule.categoryId == null ? "all" : String(schedule.categoryId));
  }, [open, scheduleQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("PUT", `/api/locations/${location.id}/whatsapp-schedule`, {
        enabled,
        frequency,
        daysOfWeek: frequency === "daily" ? [0, 1, 2, 3, 4, 5, 6] : daysOfWeek,
        sendTime,
        timezone,
        includeCost,
        includeZeroStock,
        includeNegativeStock,
        stockGroupId: stockGroupId === "all" ? null : Number(stockGroupId),
        categoryId: categoryId === "all" ? null : Number(categoryId),
      });
      return response.json();
    },
    onSuccess: (saved: ScheduleConfig) => {
      queryClient.setQueryData(["/api/locations", location.id, "whatsapp-schedule", companyId], saved);
      toast({
        title: saved.enabled ? "Automatic stock report scheduled" : "Automatic stock report disabled",
        description: saved.enabled
          ? `${location.name} will send ${saved.includeCost ? "WITH COST" : "WITHOUT COST"} at ${saved.sendTime} (${saved.timezone}).`
          : `The automatic WhatsApp stock report for ${location.name} is off.`,
      });
      setOpen(false);
    },
    onError: (error: Error) => {
      toast({ title: "Schedule save failed", description: error.message, variant: "destructive" });
    },
  });

  const daySelectionValid = frequency === "daily" || daysOfWeek.length > 0;
  const saveDisabled =
    saveMutation.isPending ||
    scheduleQuery.isLoading ||
    !sendTime ||
    !timezone.trim() ||
    !daySelectionValid ||
    (enabled && !whatsappReady) ||
    (includeCost && !canSendWithCost);

  const activeGroupName = useMemo(
    () => stockGroupsQuery.data?.find((row) => String(row.id) === stockGroupId)?.name ?? null,
    [stockGroupsQuery.data, stockGroupId]
  );
  const activeCategoryName = useMemo(
    () => categoriesQuery.data?.find((row) => String(row.id) === categoryId)?.name ?? null,
    [categoriesQuery.data, categoryId]
  );

  const toggleDay = (day: number) => {
    setDaysOfWeek((current) =>
      current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort((a, b) => a - b)
    );
  };

  const operationalStatus = scheduleStatus(scheduleQuery.data?.lastStatus ?? null);
  const OperationalIcon = operationalStatus?.Icon;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-2"
        onClick={() => setOpen(true)}
        data-testid="button-location-stock-schedule"
      >
        <CalendarClock className="h-4 w-4" />
        <span>{releaseDebtEnglish("Schedule")}</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[calc(100vw-1.5rem)] sm:max-w-[620px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5" /> Automatic WhatsApp Stock Report
            </DialogTitle>
            <DialogDescription>
              Schedule a fresh live-stock PDF for <strong>{location.name}</strong>
              <span>{releaseDebtEnglish("to its linked WhatsApp group.")}</span>
            </DialogDescription>
          </DialogHeader>

          {scheduleQuery.isLoading ? (
            <div className="py-10 flex items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              <span>{releaseDebtEnglish("Loading schedule…")}</span>
            </div>
          ) : scheduleQuery.isError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              <p>
                {scheduleQuery.error instanceof Error
                  ? scheduleQuery.error.message
                  : releaseDebtEnglish("Could not load this schedule.")}
              </p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => scheduleQuery.refetch()}>
                {releaseDebtEnglish("Retry loading")}
              </Button>
            </div>
          ) : (
            <div className="space-y-5 py-2">
              <div className="rounded-md border p-3 space-y-1">
                <p className="text-xs text-muted-foreground">{releaseDebtEnglish("WhatsApp destination")}</p>
                <p className="text-sm font-medium">
                  {location.whatsappGroupName ||
                    (location.whatsappGroupChatId ? "Linked WhatsApp group" : "No group linked")}
                </p>
                {!whatsappReady && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    Link and enable a WhatsApp group from the location WhatsApp settings before turning automatic
                    sending on.
                  </p>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">{releaseDebtEnglish("Next automatic send")}</p>
                  <p className="text-sm font-medium mt-1">
                    {scheduleQuery.data?.enabled
                      ? formatDateTime(scheduleQuery.data.nextSendAt)
                      : "Automatic sending off"}
                  </p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">{releaseDebtEnglish("Last attempt")}</p>
                  <p className="text-sm font-medium mt-1">
                    {formatDateTime(scheduleQuery.data?.lastAttemptAt ?? null)}
                  </p>
                  {operationalStatus && OperationalIcon && (
                    <p className={cn("text-xs mt-1 inline-flex items-center gap-1", operationalStatus.className)}>
                      <OperationalIcon className="h-3.5 w-3.5" /> {operationalStatus.label}
                    </p>
                  )}
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">{releaseDebtEnglish("Last successful auto-send")}</p>
                  <p className="text-sm font-medium mt-1">{formatDateTime(scheduleQuery.data?.lastSentAt ?? null)}</p>
                </div>
              </div>

              {scheduleQuery.data?.lastError && (
                <div className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive wrap-break-word">
                  <span className="font-medium">{releaseDebtEnglish("Last automatic send error" + ":")}</span>{" "}
                  {scheduleQuery.data.lastError}
                </div>
              )}

              <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                <div>
                  <Label htmlFor="location-stock-auto-send">{releaseDebtEnglish("Automatic sending")}</Label>
                  <p className="text-xs text-muted-foreground">
                    {releaseDebtEnglish("Generate from live inventory when the scheduled time arrives.")}
                  </p>
                </div>
                <Switch
                  id="location-stock-auto-send"
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  disabled={!whatsappReady}
                  data-testid="switch-location-stock-auto-send"
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>{releaseDebtEnglish("Frequency")}</Label>
                  <Select value={frequency} onValueChange={(value) => setFrequency(value as ScheduleFrequency)}>
                    <SelectTrigger data-testid="select-location-stock-frequency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">{releaseDebtEnglish("Every day")}</SelectItem>
                      <SelectItem value="selected_days">{releaseDebtEnglish("Selected days")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="location-stock-send-time">{releaseDebtEnglish("Send time")}</Label>
                  <Input
                    id="location-stock-send-time"
                    type="time"
                    value={sendTime}
                    onChange={(event) => setSendTime(event.target.value)}
                    data-testid="input-location-stock-send-time"
                  />
                </div>
              </div>

              {frequency === "selected_days" && (
                <div className="space-y-2">
                  <Label>{releaseDebtEnglish("Days")}</Label>
                  <div className="flex flex-wrap gap-2">
                    {DAYS.map((day) => (
                      <Button
                        key={day.value}
                        type="button"
                        variant={daysOfWeek.includes(day.value) ? "default" : "outline"}
                        size="sm"
                        className="h-8 min-w-12"
                        onClick={() => toggleDay(day.value)}
                        data-testid={`button-location-stock-day-${day.value}`}
                      >
                        {day.label}
                      </Button>
                    ))}
                  </div>
                  {!daysOfWeek.length && <p className="text-xs text-destructive">Select at least one day.</p>}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="location-stock-timezone">{releaseDebtEnglish("Timezone")}</Label>
                <Input
                  id="location-stock-timezone"
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  list="location-stock-timezones"
                  placeholder={releaseDebtEnglish("Africa/Lubumbashi")}
                  data-testid="input-location-stock-timezone"
                />
                <datalist id="location-stock-timezones">
                  {COMMON_TIMEZONES.map((value) => (
                    <option key={value} value={value} />
                  ))}
                </datalist>
                <p className="text-xs text-muted-foreground">
                  {releaseDebtEnglish("Use an IANA timezone such as Africa/Lubumbashi.")}
                </p>
              </div>

              <div className="space-y-2">
                <Label>Report type</Label>
                <Select
                  value={includeCost ? "with_cost" : "no_cost"}
                  onValueChange={(value) => setIncludeCost(value === "with_cost")}
                >
                  <SelectTrigger data-testid="select-location-stock-report-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="no_cost">{releaseDebtEnglish("WITHOUT COST")}</SelectItem>
                    <SelectItem value="with_cost" disabled={!canSendWithCost}>
                      WITH COST{canSendWithCost ? "" : " — permission required"}
                    </SelectItem>
                  </SelectContent>
                </Select>
                {!canSendWithCost && (
                  <p className="text-xs text-muted-foreground">
                    WITH COST requires both Cost Price / Avg Rate and Total Inventory Value permission. Existing WITH
                    COST schedules remain visible but cannot be modified until changed to WITHOUT COST by an authorized
                    user.
                  </p>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex items-center justify-between gap-3 rounded-md border p-3">
                  <div>
                    <Label htmlFor="location-stock-zero">{releaseDebtEnglish("Include zero stock")}</Label>
                    <p className="text-xs text-muted-foreground">
                      {releaseDebtEnglish("Add items whose current quantity is zero.")}
                    </p>
                  </div>
                  <Switch
                    id="location-stock-zero"
                    checked={includeZeroStock}
                    onCheckedChange={setIncludeZeroStock}
                    data-testid="switch-location-stock-zero"
                  />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-md border p-3">
                  <div>
                    <Label htmlFor="location-stock-negative">{releaseDebtEnglish("Include negative stock")}</Label>
                    <p className="text-xs text-muted-foreground">
                      {releaseDebtEnglish("Include negative quantities in the PDF.")}
                    </p>
                  </div>
                  <Switch
                    id="location-stock-negative"
                    checked={includeNegativeStock}
                    onCheckedChange={setIncludeNegativeStock}
                    data-testid="switch-location-stock-negative"
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>{releaseDebtEnglish("Stock group filter")}</Label>
                  <Select value={stockGroupId} onValueChange={setStockGroupId}>
                    <SelectTrigger data-testid="select-location-stock-group-filter">
                      <SelectValue placeholder={releaseDebtEnglish("All stock groups")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{releaseDebtEnglish("All stock groups")}</SelectItem>
                      {(stockGroupsQuery.data ?? [])
                        .filter((row) => row.active !== false)
                        .map((row) => (
                          <SelectItem key={row.id} value={String(row.id)}>
                            {row.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{releaseDebtEnglish("Category filter")}</Label>
                  <Select value={categoryId} onValueChange={setCategoryId}>
                    <SelectTrigger data-testid="select-location-stock-category-filter">
                      <SelectValue placeholder={releaseDebtEnglish("All categories")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{releaseDebtEnglish("All categories")}</SelectItem>
                      {(categoriesQuery.data ?? [])
                        .filter((row) => row.active !== false)
                        .map((row) => (
                          <SelectItem key={row.id} value={String(row.id)}>
                            {row.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className={cn("rounded-md border p-3 text-xs text-muted-foreground", enabled && "bg-muted/30")}>
                {enabled ? (
                  <>
                    <span className="font-medium text-foreground">{releaseDebtEnglish("Active schedule:")}</span>{" "}
                    {frequency === "daily"
                      ? "Every day"
                      : DAYS.filter((day) => daysOfWeek.includes(day.value))
                          .map((day) => day.label)
                          .join(", ")}
                    {` at ${sendTime || "--:--"} (${timezone || "timezone required"})`}. Report:{" "}
                    <span className="font-medium text-foreground">{includeCost ? "WITH COST" : "WITHOUT COST"}</span>.
                    {activeGroupName ? ` Group: ${activeGroupName}.` : " All stock groups."}
                    {activeCategoryName ? ` Category: ${activeCategoryName}.` : " All categories."}
                  </>
                ) : (
                  "Automatic sending is currently off. You can save the schedule settings now and enable it later."
                )}
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={saveDisabled || scheduleQuery.isError}
              data-testid="button-save-location-stock-schedule"
            >
              {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Schedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
