// Extracted from ./RecurringJournalsTab.tsx
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Pause, Play, RefreshCw, Save } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type RecurringJournalRecord = {
  id: number;
  sourceVoucherId: number;
  sourceVoucherNumber: string;
  sourceVoucherDescription: string | null;
  name: string;
  descriptionTemplate: string | null;
  frequency: string;
  scheduleRule: string;
  timezone: string;
  currency: string;
  active: boolean;
  startDate: string;
  endDate: string | null;
  nextRunDate: string;
  lastRunDate: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
};

export type RecurringListResponse = {
  recurringJournals: RecurringJournalRecord[];
};

export async function responseJson<T>(res: Response, fallback: string): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || fallback);
  return data as T;
}

export function RecurringJournalCard({
  recurring,
  queryKey,
}: {
  recurring: RecurringJournalRecord;
  queryKey: readonly unknown[];
}) {
  const { toast } = useToast();
  const [timeZone, setTimeZone] = useState(recurring.timezone);
  const [endDate, setEndDate] = useState(recurring.endDate || "");
  const [descriptionTemplate, setDescriptionTemplate] = useState(recurring.descriptionTemplate || "");
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (isDirty) return;
    setTimeZone(recurring.timezone);
    setEndDate(recurring.endDate || "");
    setDescriptionTemplate(recurring.descriptionTemplate || "");
  }, [isDirty, recurring.descriptionTemplate, recurring.endDate, recurring.id, recurring.timezone]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.invalidateQueries({
      queryKey: ["/api/recurring-journals/by-voucher", recurring.sourceVoucherId],
    });
  };

  const update = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `/api/recurring-journals/${recurring.id}`, patch);
      return responseJson(res, "Failed to update recurring journal");
    },
    onSuccess: async (_data, patch) => {
      if ("timezone" in patch || "endDate" in patch || "descriptionTemplate" in patch) {
        setIsDirty(false);
      }
      await invalidate();
      toast({ title: "Recurring journal updated" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })._handledGlobally) return;
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    },
  });

  const refreshTemplate = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/recurring-journals/from-voucher/${recurring.sourceVoucherId}`, {
        timezone: timeZone,
        endDate: endDate || null,
        descriptionTemplate: descriptionTemplate || undefined,
      });
      return responseJson(res, "Failed to refresh recurring journal");
    },
    onSuccess: async () => {
      setIsDirty(false);
      await invalidate();
      toast({
        title: "Accounts and amounts refreshed",
        description: "Future automatic journals now use the current source voucher entries.",
      });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })._handledGlobally) return;
      toast({ title: "Refresh failed", description: error.message, variant: "destructive" });
    },
  });

  const busy = update.isPending || refreshTemplate.isPending;

  return (
    <div className="rounded-xl border bg-card p-4 space-y-4" data-testid={`recurring-journal-${recurring.id}`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{recurring.name}</h3>
            <Badge variant={recurring.active ? "secondary" : "outline"}>{recurring.active ? "Active" : "Paused"}</Badge>
            <Badge variant="outline">{recurring.currency}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Source voucher: <span className="font-mono text-foreground">{recurring.sourceVoucherNumber}</span>
          </p>
          {recurring.sourceVoucherDescription && recurring.sourceVoucherDescription !== recurring.name && (
            <p className="text-xs text-muted-foreground">{recurring.sourceVoucherDescription}</p>
          )}
        </div>

        <Button
          size="sm"
          variant={recurring.active ? "outline" : "default"}
          disabled={busy}
          onClick={() => update.mutate({ active: !recurring.active })}
        >
          {update.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : recurring.active ? (
            <Pause className="h-4 w-4 mr-2" />
          ) : (
            <Play className="h-4 w-4 mr-2" />
          )}
          {recurring.active ? "Pause" : "Resume"}
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg bg-muted/35 px-3 py-2">
          <p className="text-xs text-muted-foreground">Schedule</p>
          <p className="text-sm font-medium">Last day of every month</p>
        </div>
        <div className="rounded-lg bg-muted/35 px-3 py-2">
          <p className="text-xs text-muted-foreground">Next posting</p>
          <p className="text-sm font-medium">{recurring.nextRunDate}</p>
        </div>
        <div className="rounded-lg bg-muted/35 px-3 py-2">
          <p className="text-xs text-muted-foreground">Last posting</p>
          <p className="text-sm font-medium">{recurring.lastRunDate || "Not posted yet"}</p>
        </div>
        <div className="rounded-lg bg-muted/35 px-3 py-2">
          <p className="text-xs text-muted-foreground">Started</p>
          <p className="text-sm font-medium">{recurring.startDate}</p>
        </div>
      </div>

      {recurring.lastError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          Last automatic run failed: {recurring.lastError}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`recurring-timezone-${recurring.id}`}>Timezone</Label>
          <Input
            id={`recurring-timezone-${recurring.id}`}
            value={timeZone}
            onChange={(event) => {
              setTimeZone(event.target.value);
              setIsDirty(true);
            }}
            placeholder="UTC"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`recurring-end-date-${recurring.id}`}>End date (optional)</Label>
          <Input
            id={`recurring-end-date-${recurring.id}`}
            type="date"
            value={endDate}
            onChange={(event) => {
              setEndDate(event.target.value);
              setIsDirty(true);
            }}
          />
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor={`recurring-description-${recurring.id}`}>Description template</Label>
          <Input
            id={`recurring-description-${recurring.id}`}
            value={descriptionTemplate}
            onChange={(event) => {
              setDescriptionTemplate(event.target.value);
              setIsDirty(true);
            }}
            placeholder="Savings Kinshasa {{month}}"
          />
          <p className="text-xs text-muted-foreground">
            Tokens: {"{{month}}"}, {"{{month_short}}"}, {"{{year}}"}, {"{{date}}"}.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-t pt-3">
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            update.mutate({
              timezone: timeZone,
              endDate: endDate || null,
              descriptionTemplate: descriptionTemplate || null,
            })
          }
        >
          {update.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          Save Settings
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => refreshTemplate.mutate()}>
          {refreshTemplate.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-2" />
          )}
          Refresh Accounts & Amounts
        </Button>
      </div>
    </div>
  );
}
