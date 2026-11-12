/**
 * Phase 11 — monthly 50/50 profit and loss close.
 *
 * Every total shown here is read back from the readiness payload. The UI never
 * posts revenue, COGS, shared charges, or a split percentage: it selects a
 * month and supplies the reason, request id, and exact confirmation phrase.
 */
import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarCheck2, Loader2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import {
  MONTHLY_CLOSE_CONFIRMATION,
  PHASE11_CLOSE,
  PHASE11_READINESS,
  type CompanyKey,
  type MutationResult,
  type Phase11Readiness,
} from "./contracts";
import {
  ReadinessState,
  makeRequestId,
  money,
  previousCompletedMonth,
  readJson,
  useReadinessInvalidation,
} from "./shared";

export function MonthlyClosePanel({ companyKey }: { companyKey: CompanyKey }) {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const invalidateReadiness = useReadinessInvalidation();

  const [phase11Month, setPhase11Month] = useState(previousCompletedMonth);
  const [phase11Reference, setPhase11Reference] = useState("");
  const [phase11Reason, setPhase11Reason] = useState("");
  const [phase11Confirmation, setPhase11Confirmation] = useState("");
  const [phase11RequestId, setPhase11RequestId] = useState(() => makeRequestId("gc-p11"));

  const phase11Url = `${PHASE11_READINESS}?periodMonth=${encodeURIComponent(phase11Month)}`;
  const phase11Query = useQuery<Phase11Readiness>({
    queryKey: [phase11Url, companyKey],
    queryFn: () => readJson<Phase11Readiness>(phase11Url),
    enabled: /^\d{4}-\d{2}$/.test(phase11Month),
    retry: false,
  });

  const rotatePhase11 = () => setPhase11RequestId(makeRequestId("gc-p11"));

  const phase11 = phase11Query.data;
  const phase11CanSubmit =
    phase11?.ready === true &&
    phase11.alreadyClosed !== true &&
    phase11Reason.trim().length >= 5 &&
    phase11Confirmation.trim() === MONTHLY_CLOSE_CONFIRMATION;

  const phase11Mutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const response = await apiRequest("POST", PHASE11_CLOSE, {
        periodMonth: phase11Month,
        clientRequestId: phase11RequestId,
        idempotencyKey: phase11RequestId,
        reference: phase11Reference.trim() || null,
        reason: phase11Reason.trim(),
        confirmation: phase11Confirmation.trim(),
      });
      return (await response.json()) as MutationResult;
    },
    onSuccess: (result) => {
      invalidateReadiness();
      setPhase11Reference("");
      setPhase11Reason("");
      setPhase11Confirmation("");
      setPhase11RequestId(makeRequestId("gc-p11"));
      toast({
        title: releaseDebtEnglish(result.replayed ? "Monthly close replay confirmed" : "Monthly close finalized"),
        description: releaseDebtEnglish("The month is now protected by the Phase 11 close."),
      });
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: releaseDebtEnglish("Monthly close failed"), description: error.message, variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <CalendarCheck2 className="h-5 w-5" /> {releaseDebtEnglish("Monthly 50/50 close")}
            </CardTitle>
            <CardDescription>
              {releaseDebtEnglish(
                "Phase 11 derives revenue, COGS, shared charges, and both 50/50 shares from posted ledger activity. The UI never supplies accounting totals or split percentages."
              )}
            </CardDescription>
          </div>
          <Badge variant="secondary">{releaseDebtEnglish("Phase 11")}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="max-w-xs space-y-2">
          <label className="text-sm font-medium" htmlFor="gc-phase11-month">
            {releaseDebtEnglish("Closed month")}
          </label>
          <Input
            id="gc-phase11-month"
            type="month"
            value={phase11Month}
            onChange={(event) => {
              setPhase11Month(event.target.value);
              rotatePhase11();
            }}
            data-testid="input-gc-phase11-month"
          />
        </div>
        <ReadinessState
          loading={phase11Query.isLoading}
          error={phase11Query.error}
          ready={phase11?.ready === true}
          readyText={releaseDebtEnglish("The selected month is ready for the ledger-derived 50/50 close.")}
          blockedText={releaseDebtEnglish(
            phase11?.alreadyClosed
              ? "The selected month is already closed."
              : "The selected month is not ready to close. Review the server response before continuing."
          )}
        />
        {phase11?.plan ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              [releaseDebtEnglish("Revenue"), phase11.plan.totalRevenueUsd],
              [releaseDebtEnglish("COGS"), phase11.plan.totalCogsUsd],
              [releaseDebtEnglish("Shared charges"), phase11.plan.totalSharedChargesUsd],
              [releaseDebtEnglish("Net profit / loss"), phase11.plan.netProfitLossUsd],
              [releaseDebtEnglish("Fresh Start share"), phase11.plan.freshStartShareUsd],
              [releaseDebtEnglish("Hassan share"), phase11.plan.hassanShareUsd],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 font-semibold tabular-nums">{money(value)}</p>
              </div>
            ))}
          </div>
        ) : null}
        {phase11?.profitPendingDistributionBalanceUsd != null ? (
          <div className="rounded-md border p-3 text-sm">
            <span className="text-muted-foreground">{releaseDebtEnglish("Profit Pending Distribution balance")}: </span>
            <span className="font-semibold tabular-nums">{money(phase11.profitPendingDistributionBalanceUsd)}</span>
          </div>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gc-phase11-reference">
              {releaseDebtEnglish("Reference (optional)")}
            </label>
            <Input
              id="gc-phase11-reference"
              value={phase11Reference}
              maxLength={200}
              onChange={(event) => {
                setPhase11Reference(event.target.value);
                rotatePhase11();
              }}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gc-phase11-reason">
              {releaseDebtEnglish("Reason")}
            </label>
            <Input
              id="gc-phase11-reason"
              value={phase11Reason}
              maxLength={500}
              onChange={(event) => {
                setPhase11Reason(event.target.value);
                rotatePhase11();
              }}
              data-testid="input-gc-phase11-reason"
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium" htmlFor="gc-phase11-confirmation">
              {releaseDebtEnglish("Exact confirmation")}
            </label>
            <Input
              id="gc-phase11-confirmation"
              value={phase11Confirmation}
              onChange={(event) => {
                setPhase11Confirmation(event.target.value);
                rotatePhase11();
              }}
              placeholder={MONTHLY_CLOSE_CONFIRMATION}
              autoComplete="off"
              data-testid="input-gc-phase11-confirmation"
            />
            <p className="text-xs text-muted-foreground">
              {releaseDebtEnglish("Type exactly")}: <span className="font-mono">{MONTHLY_CLOSE_CONFIRMATION}</span>
            </p>
          </div>
        </div>
        {recordChanges.allowed && (
          <Button
            onClick={() => phase11Mutation.mutate()}
            disabled={!phase11CanSubmit || phase11Mutation.isPending}
            data-testid="button-gc-phase11-submit"
          >
            {phase11Mutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CalendarCheck2 className="mr-2 h-4 w-4" />
            )}
            {releaseDebtEnglish("Finalize monthly close")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
