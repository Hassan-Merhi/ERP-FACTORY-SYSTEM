import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarClock, Loader2, Pause, Play, Plus, RefreshCw, Save } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type RecurringJournalRecord = {
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

type RecurringListResponse = {
  recurringJournals: RecurringJournalRecord[];
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

function RecurringJournalCard({
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

export function RecurringJournalsTab() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const companyId = selectedCompany?.id ?? null;
  const queryKey = useMemo(() => ["/api/recurring-journals", companyId] as const, [companyId]);
  const [voucherNumber, setVoucherNumber] = useState("");
  const [timeZone, setTimeZone] = useState(browserTimeZone());
  const [endDate, setEndDate] = useState("");
  const [descriptionTemplate, setDescriptionTemplate] = useState("");

  const query = useQuery<RecurringListResponse>({
    queryKey,
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/recurring-journals");
      return responseJson<RecurringListResponse>(res, "Failed to load recurring journals");
    },
    enabled: !!companyId,
    staleTime: 15_000,
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/recurring-journals/from-voucher-number", {
        voucherNumber: voucherNumber.trim(),
        timezone: timeZone || browserTimeZone(),
        endDate: endDate || null,
        descriptionTemplate: descriptionTemplate.trim() || undefined,
      });
      return responseJson<{ recurring?: RecurringJournalRecord }>(res, "Failed to create recurring journal");
    },
    onSuccess: async (data: { recurring?: RecurringJournalRecord }) => {
      setVoucherNumber("");
      setEndDate("");
      setDescriptionTemplate("");
      await queryClient.invalidateQueries({ queryKey });
      toast({
        title: "Recurring journal created",
        description: `Next automatic posting: ${data.recurring?.nextRunDate || "month-end"}.`,
      });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })._handledGlobally) return;
      toast({ title: "Create failed", description: error.message, variant: "destructive" });
    },
  });

  if (!companyId) {
    return (
      <div className="rounded-xl border bg-muted/20 p-6 text-sm text-muted-foreground">
        Select a company to manage recurring journals.
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-5">
      <div>
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <CalendarClock className="h-5 w-5" />
          Recurring Journals
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Schedule and manage automatic month-end journal vouchers here. Recurring controls no longer appear in Daybook
          voucher view or edit screens.
        </p>
      </div>

      <div className="rounded-xl border bg-card p-4 space-y-4">
        <div>
          <h3 className="font-semibold">Add recurring journal</h3>
          <p className="text-sm text-muted-foreground">
            Enter an existing posted Journal voucher number. Its accounts and amounts become the template for future
            month-end postings.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-recurring-voucher-number">Source journal voucher number</Label>
            <Input
              id="new-recurring-voucher-number"
              value={voucherNumber}
              onChange={(event) => setVoucherNumber(event.target.value)}
              placeholder="JOURNAL-..."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-recurring-timezone">Timezone</Label>
            <Input
              id="new-recurring-timezone"
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
              placeholder="UTC"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-recurring-end-date">End date (optional)</Label>
            <Input
              id="new-recurring-end-date"
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-recurring-description">Description template (optional)</Label>
            <Input
              id="new-recurring-description"
              value={descriptionTemplate}
              onChange={(event) => setDescriptionTemplate(event.target.value)}
              placeholder="Savings Kinshasa {{month}}"
            />
          </div>
        </div>

        <Button
          onClick={() => create.mutate()}
          disabled={create.isPending || !voucherNumber.trim()}
          data-testid="button-add-recurring-journal"
        >
          {create.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
          Add Recurring Journal
        </Button>
      </div>

      {query.isLoading ? (
        <div className="rounded-xl border p-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading recurring journals…
        </div>
      ) : query.isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex items-center justify-between gap-3">
          <p className="text-sm text-destructive">Could not load recurring journals.</p>
          <Button size="sm" variant="outline" onClick={() => query.refetch()}>
            Retry
          </Button>
        </div>
      ) : (query.data?.recurringJournals.length ?? 0) === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <CalendarClock className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 font-medium">No recurring journals yet</p>
          <p className="text-sm text-muted-foreground">Add one above using an existing posted Journal voucher.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {query.data?.recurringJournals.map((recurring) => (
            <RecurringJournalCard key={recurring.id} recurring={recurring} queryKey={queryKey} />
          ))}
        </div>
      )}
    </div>
  );
}
