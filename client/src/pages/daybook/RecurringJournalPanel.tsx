import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarClock, Loader2, Pause, Play, RefreshCw, Settings2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type RecurringJournalRecord = {
  id: number;
  sourceVoucherId: number;
  name: string;
  descriptionTemplate: string | null;
  frequency: string;
  scheduleRule: string;
  timezone: string;
  active: boolean;
  startDate: string;
  endDate: string | null;
  nextRunDate: string;
  lastRunDate: string | null;
  lastError: string | null;
};

type GeneratedVoucher = {
  id: number;
  voucherNumber: string;
  voucherDate: string;
  description: string | null;
  totalAmount: string;
  currency: string;
  createdAt: string;
};

type RecurringResponse = {
  recurring: RecurringJournalRecord | null;
  history: GeneratedVoucher[];
};

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

async function responseJson<T>(res: Response, fallback: string): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || fallback);
  return data as T;
}

export function RecurringJournalPanel({
  voucherId,
  enabled,
}: {
  voucherId: number;
  enabled: boolean;
}) {
  const { toast } = useToast();
  const queryKey = useMemo(() => ["/api/recurring-journals/by-voucher", voucherId], [voucherId]);
  const [showSettings, setShowSettings] = useState(false);
  const [timeZone, setTimeZone] = useState(browserTimeZone());
  const [endDate, setEndDate] = useState("");
  const [descriptionTemplate, setDescriptionTemplate] = useState("");

  const query = useQuery<RecurringResponse>({
    queryKey,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/recurring-journals/by-voucher/${voucherId}`);
      return responseJson<RecurringResponse>(res, "Failed to load recurring journal");
    },
    enabled,
    staleTime: 15_000,
  });

  const recurring = query.data?.recurring ?? null;
  const history = query.data?.history ?? [];

  useEffect(() => {
    if (!recurring) {
      setTimeZone(browserTimeZone());
      setEndDate("");
      setDescriptionTemplate("");
      return;
    }
    setTimeZone(recurring.timezone || browserTimeZone());
    setEndDate(recurring.endDate || "");
    setDescriptionTemplate(recurring.descriptionTemplate || "");
  }, [recurring?.id, recurring?.timezone, recurring?.endDate, recurring?.descriptionTemplate]);

  const refreshData = async () => {
    await queryClient.invalidateQueries({ queryKey });
  };

  const createOrRefresh = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/recurring-journals/from-voucher/${voucherId}`, {
        timezone: timeZone || browserTimeZone(),
        endDate: endDate || null,
        descriptionTemplate: descriptionTemplate || undefined,
      });
      return responseJson<RecurringResponse>(res, "Failed to create recurring journal");
    },
    onSuccess: async (data) => {
      queryClient.setQueryData(queryKey, data);
      await refreshData();
      toast({
        title: recurring ? "Recurring journal refreshed" : "Recurring journal enabled",
        description: `Next automatic posting: ${data.recurring?.nextRunDate || "month-end"}.`,
      });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })._handledGlobally) return;
      toast({ title: "Recurring journal failed", description: error.message, variant: "destructive" });
    },
  });

  const update = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      if (!recurring) throw new Error("Recurring journal not found");
      const res = await apiRequest("PATCH", `/api/recurring-journals/${recurring.id}`, patch);
      return responseJson<RecurringResponse>(res, "Failed to update recurring journal");
    },
    onSuccess: async (data) => {
      queryClient.setQueryData(queryKey, data);
      await refreshData();
      toast({
        title: data.recurring?.active ? "Recurring journal active" : "Recurring journal paused",
        description: data.recurring?.active
          ? `Next automatic posting: ${data.recurring.nextRunDate}.`
          : "No automatic vouchers will be created while paused.",
      });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })._handledGlobally) return;
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    },
  });

  if (!enabled) return null;

  if (query.isLoading) {
    return (
      <div className="rounded-lg border bg-muted/20 p-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading recurring journal…
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 flex items-center justify-between gap-3">
        <p className="text-sm text-destructive">Could not load recurring journal settings.</p>
        <Button size="sm" variant="outline" onClick={() => query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const busy = createOrRefresh.isPending || update.isPending;

  return (
    <div className="rounded-lg border bg-muted/15 p-3 space-y-3" data-testid="recurring-journal-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-2">
          <CalendarClock className="h-4 w-4 mt-0.5 text-muted-foreground" />
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">Recurring Journal</p>
              {recurring && (
                <Badge variant={recurring.active ? "secondary" : "outline"}>
                  {recurring.active ? "Active" : "Paused"}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {recurring
                ? `Posts automatically on the last day of each month. Next: ${recurring.nextRunDate}`
                : "Automatically repeat this journal on the last day of every month."}
            </p>
          </div>
        </div>

        {!recurring ? (
          <Button
            size="sm"
            onClick={() => createOrRefresh.mutate()}
            disabled={busy}
            data-testid="button-make-journal-recurring"
          >
            {createOrRefresh.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Make Recurring
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowSettings((value) => !value)}
              disabled={busy}
            >
              <Settings2 className="h-4 w-4 mr-2" />
              Settings
            </Button>
            <Button
              size="sm"
              variant={recurring.active ? "outline" : "default"}
              onClick={() => update.mutate({ active: !recurring.active })}
              disabled={busy}
              data-testid="button-toggle-recurring-journal"
            >
              {recurring.active ? <Pause className="h-4 w-4 mr-2" /> : <Play className="h-4 w-4 mr-2" />}
              {recurring.active ? "Pause" : "Resume"}
            </Button>
          </div>
        )}
      </div>

      {recurring?.lastError && (
        <p className="text-xs text-destructive rounded-md bg-destructive/5 p-2">
          Last automatic run failed: {recurring.lastError}
        </p>
      )}

      {(showSettings || !recurring) && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t">
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor={`recurring-timezone-${voucherId}`}>Timezone</Label>
            <Input
              id={`recurring-timezone-${voucherId}`}
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
              placeholder="UTC"
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor={`recurring-end-date-${voucherId}`}>End date (optional)</Label>
            <Input
              id={`recurring-end-date-${voucherId}`}
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5 md:col-span-3">
            <Label className="text-xs" htmlFor={`recurring-description-${voucherId}`}>Description template</Label>
            <Input
              id={`recurring-description-${voucherId}`}
              value={descriptionTemplate}
              onChange={(event) => setDescriptionTemplate(event.target.value)}
              placeholder="Savings Kinshasa {{month}}"
              className="h-8 text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              Tokens: {"{{month}}"}, {"{{month_short}}"}, {"{{year}}"}, {"{{date}}"}.
            </p>
          </div>

          {recurring && (
            <div className="md:col-span-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() =>
                  update.mutate({
                    timezone: timeZone,
                    endDate: endDate || null,
                    descriptionTemplate: descriptionTemplate || null,
                  })
                }
                disabled={busy}
              >
                Save Settings
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => createOrRefresh.mutate()}
                disabled={busy}
                title="Copy the current voucher's accounts and amounts into the recurring template"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh Accounts & Amounts
              </Button>
            </div>
          )}
        </div>
      )}

      {recurring && history.length > 0 && (
        <div className="pt-2 border-t">
          <p className="text-xs font-medium mb-1.5">Generated vouchers</p>
          <div className="flex flex-wrap gap-2">
            {history.slice(-5).reverse().map((item) => (
              <Badge key={item.id} variant="outline" className="font-normal">
                {item.voucherDate} · {item.voucherNumber}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
