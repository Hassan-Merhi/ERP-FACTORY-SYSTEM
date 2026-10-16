/**
 * Compact Phase 11 action for the SP Reports page.
 *
 * The report date range chooses the month, while the server remains the source
 * of truth for readiness, totals, and the final accounting posting.
 */
import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck2, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
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
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  MONTHLY_CLOSE_CONFIRMATION,
  PHASE11_CLOSE,
  PHASE11_READINESS,
  type CompanyKey,
  type MutationResult,
  type Phase11Readiness,
} from "./contracts";
import { ReadinessState, errorMessage, makeRequestId, money, readJson, useReadinessInvalidation } from "./shared";

function monthLabel(periodMonth: string): string {
  const [year, month] = periodMonth.split("-").map(Number);
  if (!year || !month) return periodMonth;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function QuickMonthlyClose({ periodMonth, companyKey }: { periodMonth: string; companyKey: CompanyKey }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const invalidateReadiness = useReadinessInvalidation();
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [requestId, setRequestId] = useState(() => makeRequestId("gc-p11"));
  const [postedVoucher, setPostedVoucher] = useState<MutationResult["voucher"] | null>(null);

  const validMonth = /^\d{4}-\d{2}$/.test(periodMonth);
  const readinessUrl = `${PHASE11_READINESS}?periodMonth=${encodeURIComponent(periodMonth)}`;
  const readinessQuery = useQuery<Phase11Readiness>({
    queryKey: [readinessUrl, companyKey],
    queryFn: () => readJson<Phase11Readiness>(readinessUrl),
    enabled: validMonth,
    retry: false,
  });

  useEffect(() => {
    setConfirmationOpen(false);
    setConfirmation("");
    setPostedVoucher(null);
    setRequestId(makeRequestId("gc-p11"));
  }, [periodMonth]);

  const phase11 = readinessQuery.data;
  const canOpen =
    phase11?.ready === true && phase11.alreadyClosed !== true && !readinessQuery.isLoading && !readinessQuery.error;

  const closeMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", PHASE11_CLOSE, {
        periodMonth,
        clientRequestId: requestId,
        idempotencyKey: requestId,
        reference: `Monthly profit split for ${periodMonth}`,
        reason: `Monthly profit split for ${periodMonth}`,
        confirmation: confirmation.trim(),
      });
      return (await response.json()) as MutationResult;
    },
    onSuccess: (result) => {
      setPostedVoucher(result.voucher ?? null);
      setConfirmationOpen(false);
      setConfirmation("");
      setRequestId(makeRequestId("gc-p11"));
      invalidateReadiness();
      void queryClient.invalidateQueries({ queryKey: ["/api/sp/profit-splits"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/sp/report/profit"] });
      // Keep the report's period visibly current after the server closes it.
      void readinessQuery.refetch();
      toast({
        title: releaseDebtEnglish("Monthly close finalized"),
        description: releaseDebtEnglish(
          `The ${periodMonth} split was posted as journal voucher ${result.voucher?.voucherNumber ?? result.voucher?.id ?? "in the ledger"}.`
        ),
      });
    },
    onError: (error: ClientErrorLike) => {
      toast({
        title: releaseDebtEnglish("Monthly close failed"),
        description: errorMessage(error),
        variant: "destructive",
      });
    },
  });

  if (!validMonth) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="sp-quick-close-date-hint">
        {releaseDebtEnglish("Choose a valid From and To date to enable the monthly split.")}
      </p>
    );
  }

  return (
    <>
      <div className="space-y-3" data-testid="sp-quick-monthly-close">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">
              {releaseDebtEnglish("Split selected month")}: {monthLabel(periodMonth)}
            </p>
            <p className="text-xs text-muted-foreground">
              {releaseDebtEnglish("The split uses posted ledger activity for the selected month.")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmationOpen(true)}
            disabled={!canOpen || closeMutation.isPending}
            data-testid="button-sp-split-selected-month"
          >
            {closeMutation.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <CalendarCheck2 className="mr-1 h-3.5 w-3.5" />
            )}
            {releaseDebtEnglish("Split")}
          </Button>
        </div>

        <ReadinessState
          loading={readinessQuery.isLoading}
          error={readinessQuery.error}
          ready={phase11?.ready === true}
          readyText={releaseDebtEnglish("This month is ready for the ledger-derived split.")}
          blockedText={releaseDebtEnglish(
            phase11?.alreadyClosed
              ? "This month has already been split."
              : "This month is not ready to split. Review the server response before continuing."
          )}
        />

        {phase11?.plan ? (
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div>
              <span className="text-muted-foreground">{releaseDebtEnglish("Net profit / loss")}</span>
              <p className="font-semibold tabular-nums">{money(phase11.plan.netProfitLossUsd)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">{releaseDebtEnglish("Fresh Start share")}</span>
              <p className="font-semibold tabular-nums">{money(phase11.plan.freshStartShareUsd)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">{releaseDebtEnglish("Hassan share")}</span>
              <p className="font-semibold tabular-nums">{money(phase11.plan.hassanShareUsd)}</p>
            </div>
          </div>
        ) : null}

        {(postedVoucher?.id || phase11?.voucher?.id) ? (
          <a
            href={`/voucher-detail/${postedVoucher?.id || phase11?.voucher?.id}`}
            className="text-sm font-medium underline underline-offset-2"
            data-testid="link-sp-monthly-close-journal"
          >
            Journal voucher {postedVoucher?.voucherNumber || phase11?.voucher?.voucherNumber || `#${postedVoucher?.id || phase11?.voucher?.id}`}
          </a>
        ) : null}
        {phase11?.alreadyClosed && phase11.journalVerified === false ? (
          <p className="text-sm text-destructive" data-testid="sp-close-missing-journal">
            Existing monthly split has no verified Journal voucher; contact a developer before further accounting.
          </p>
        ) : null}

        {closeMutation.error ? (
          <p className="text-sm text-destructive" role="alert">
            {errorMessage(closeMutation.error)}
          </p>
        ) : null}
      </div>

      <Dialog open={confirmationOpen} onOpenChange={setConfirmationOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {releaseDebtEnglish("Split")} {monthLabel(periodMonth)}?
            </DialogTitle>
            <DialogDescription>
              {releaseDebtEnglish(
                "This posts the protected ledger-derived 50/50 monthly close. Type the exact confirmation phrase to continue."
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="sp-quick-close-confirmation">
              {releaseDebtEnglish("Exact confirmation")}
            </label>
            <Input
              id="sp-quick-close-confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder={MONTHLY_CLOSE_CONFIRMATION}
              autoComplete="off"
              data-testid="input-sp-quick-close-confirmation"
            />
            <p className="text-xs text-muted-foreground">
              {releaseDebtEnglish("Type exactly")}: <span className="font-mono">{MONTHLY_CLOSE_CONFIRMATION}</span>
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmationOpen(false)} disabled={closeMutation.isPending}>
              {releaseDebtEnglish("Cancel")}
            </Button>
            <Button
              onClick={() => closeMutation.mutate()}
              disabled={confirmation.trim() !== MONTHLY_CLOSE_CONFIRMATION || closeMutation.isPending}
              data-testid="button-sp-confirm-split"
            >
              {closeMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {releaseDebtEnglish("Confirm split")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
