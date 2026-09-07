/**
 * Settle GC Sales Cash out of Hassan Dakik Equity — the no-cash alternative to
 * the Phase 10 payment on the same tab.
 *
 * GC Sales Cash and Hassan Dakik Equity are both credit-normal and both move
 * down, so one amount drives two debits and Fresh Start FZ Equity takes the
 * balancing credit of twice that amount. The server owns that arithmetic and
 * both ceilings; the panel only shows what it reports.
 */
import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, Loader2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  EQUITY_SALES_CASH_CONFIRMATION,
  EQUITY_SALES_CASH_READINESS,
  EQUITY_SALES_CASH_SETTLEMENT,
  type CompanyKey,
  type EquitySalesCashReadiness,
  type MutationResult,
} from "./contracts";
import {
  ReadinessState,
  allowedAmount,
  makeRequestId,
  money,
  readJson,
  todayIso,
  useReadinessInvalidation,
} from "./shared";

export function EquitySalesCashPanel({ companyKey }: { companyKey: CompanyKey }) {
  const { toast } = useToast();
  const invalidateReadiness = useReadinessInvalidation();

  const [date, setDate] = useState(todayIso);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [requestId, setRequestId] = useState(() => makeRequestId("gc-esc"));

  const readinessQuery = useQuery<EquitySalesCashReadiness>({
    queryKey: [EQUITY_SALES_CASH_READINESS, companyKey],
    queryFn: () => readJson<EquitySalesCashReadiness>(EQUITY_SALES_CASH_READINESS),
    retry: false,
  });

  const rotateRequestId = () => setRequestId(makeRequestId("gc-esc"));

  const readiness = readinessQuery.data;
  const canSubmit =
    readiness?.ready === true &&
    allowedAmount(amount, readiness.maxSettlementUsd) &&
    reason.trim().length >= 5 &&
    confirmation.trim() === EQUITY_SALES_CASH_CONFIRMATION;

  const settlement = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", EQUITY_SALES_CASH_SETTLEMENT, {
        settlementDate: date,
        amountUsd: amount,
        clientRequestId: requestId,
        reference: reference.trim() || null,
        reason: reason.trim(),
        confirmation: confirmation.trim(),
      });
      return (await response.json()) as MutationResult;
    },
    onSuccess: (result) => {
      invalidateReadiness();
      setAmount("");
      setReference("");
      setReason("");
      setConfirmation("");
      setRequestId(makeRequestId("gc-esc"));
      toast({
        title: releaseDebtEnglish(
          result.replayed ? "Settlement replay confirmed" : "GC Sales Cash settled from equity"
        ),
        description: releaseDebtEnglish("The payable and both partner equity balances were refreshed."),
      });
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: releaseDebtEnglish("Settlement failed"), description: error.message, variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <ArrowLeftRight className="h-5 w-5" /> {releaseDebtEnglish("Settle GC Sales Cash from equity")}
            </CardTitle>
            <CardDescription>
              {releaseDebtEnglish(
                "Pay down the GC Sales Cash payable out of Hassan Dakik Equity instead of cash. No money leaves Golden Coast: the payable and Hassan's capital both fall by the amount entered, and Fresh Start FZ Equity absorbs both sides."
              )}
            </CardDescription>
          </div>
          <Badge variant="secondary">{releaseDebtEnglish("No cash")}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <ReadinessState
          loading={readinessQuery.isLoading}
          error={readinessQuery.error}
          ready={readiness?.ready === true}
          readyText={releaseDebtEnglish("Settling GC Sales Cash from Hassan Dakik Equity is ready.")}
          blockedText={releaseDebtEnglish(
            "Settlement is not ready. There must be an outstanding payable and an available Hassan Dakik Equity balance."
          )}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-md border p-4">
            <p className="text-xs text-muted-foreground">{releaseDebtEnglish("GC Sales Cash payable due")}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{money(readiness?.payableSalesCashUsd)}</p>
          </div>
          <div className="rounded-md border p-4">
            <p className="text-xs text-muted-foreground">{releaseDebtEnglish("Available Hassan Dakik Equity")}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{money(readiness?.availableHassanEquityUsd)}</p>
          </div>
          <div className="rounded-md border p-4">
            <p className="text-xs text-muted-foreground">{releaseDebtEnglish("Most that can be settled now")}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid="text-gc-equity-sales-cash-max">
              {money(readiness?.maxSettlementUsd)}
            </p>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gc-equity-sales-cash-date">
              {releaseDebtEnglish("Settlement date")}
            </label>
            <Input
              id="gc-equity-sales-cash-date"
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
                rotateRequestId();
              }}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gc-equity-sales-cash-amount">
              {releaseDebtEnglish("Amount (USD)")}
            </label>
            <Input
              id="gc-equity-sales-cash-amount"
              type="number"
              min="0.01"
              step="0.01"
              max={readiness?.maxSettlementUsd ?? "0"}
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                rotateRequestId();
              }}
              data-testid="input-gc-equity-sales-cash-amount"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gc-equity-sales-cash-reference">
              {releaseDebtEnglish("Reference (optional)")}
            </label>
            <Input
              id="gc-equity-sales-cash-reference"
              value={reference}
              maxLength={200}
              onChange={(event) => {
                setReference(event.target.value);
                rotateRequestId();
              }}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gc-equity-sales-cash-reason">
              {releaseDebtEnglish("Reason")}
            </label>
            <Input
              id="gc-equity-sales-cash-reason"
              value={reason}
              maxLength={500}
              onChange={(event) => {
                setReason(event.target.value);
                rotateRequestId();
              }}
              data-testid="input-gc-equity-sales-cash-reason"
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium" htmlFor="gc-equity-sales-cash-confirmation">
              {releaseDebtEnglish(`Type ${EQUITY_SALES_CASH_CONFIRMATION} to confirm`)}
            </label>
            <Input
              id="gc-equity-sales-cash-confirmation"
              value={confirmation}
              maxLength={64}
              onChange={(event) => setConfirmation(event.target.value)}
              data-testid="input-gc-equity-sales-cash-confirmation"
            />
          </div>
        </div>
        <div className="rounded-md border bg-muted/40 p-4 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">{releaseDebtEnglish("Journal this posts")}</p>
          <p className="mt-1 tabular-nums">
            {releaseDebtEnglish("Dr GC Sales Cash")} {money(amount || "0")}
          </p>
          <p className="tabular-nums">
            {releaseDebtEnglish("Dr Hassan Dakik Equity")} {money(amount || "0")}
          </p>
          <p className="tabular-nums">
            {releaseDebtEnglish("Cr Fresh Start FZ Equity")}{" "}
            {money(Number.isFinite(Number(amount)) ? String(Number(amount || 0) * 2) : "0")}
          </p>
        </div>
        <Button
          onClick={() => settlement.mutate()}
          disabled={!canSubmit || settlement.isPending}
          data-testid="button-gc-equity-sales-cash-submit"
        >
          {settlement.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {releaseDebtEnglish("Settle from equity")}
        </Button>
      </CardContent>
    </Card>
  );
}
