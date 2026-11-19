import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarClock, Loader2, Plus } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadingState } from "@/components/ui/page-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  responseJson,
  RecurringJournalCard,
  type RecurringJournalRecord,
  type RecurringListResponse,
} from "./RecurringJournalsTabParts";

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
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
        <LoadingState title="Loading recurring journals…" className="rounded-xl p-6" />
      ) : query.isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex items-center justify-between gap-3">
          <p className="text-sm text-destructive">Could not load recurring journals.</p>
          <Button size="sm" variant="outline" onClick={() => query.refetch()}>
            Retry
          </Button>
        </div>
      ) : (query.data?.recurringJournals.length ?? 0) === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No recurring journals yet"
          description="Add one above using an existing posted Journal voucher."
          className="rounded-xl p-8"
        />
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
