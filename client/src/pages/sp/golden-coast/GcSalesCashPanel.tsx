/**
 * Phase 10 — direct GC Sales Cash payment.
 *
 * GC Sales Cash is the credit-normal liability Golden Coast owes Fresh Start.
 * The settleable balance is the server's, not a client subtraction: the panel
 * pays all or part of it out of an approved Golden Coast cash or bank account.
 */
import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleDollarSign, Loader2 } from "lucide-react";
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
  PHASE10_READINESS,
  PHASE10_SETTLEMENT,
  type CompanyKey,
  type MutationResult,
  type Phase10Readiness,
} from "./contracts";
import {
  AccountPicker,
  ReadinessState,
  allowedAmount,
  makeRequestId,
  money,
  readJson,
  selectedAccount,
  todayIso,
  useReadinessInvalidation,
} from "./shared";

export function GcSalesCashPanel({ companyKey }: { companyKey: CompanyKey }) {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const invalidateReadiness = useReadinessInvalidation();

  const [phase10Date, setPhase10Date] = useState(todayIso);
  const [phase10Amount, setPhase10Amount] = useState("");
  const [phase10TransferFee, setPhase10TransferFee] = useState("");
  const [phase10ReceiptAccount, setPhase10ReceiptAccount] = useState("");
  const [phase10Reference, setPhase10Reference] = useState("");
  const [phase10RequestId, setPhase10RequestId] = useState(() => makeRequestId("gc-p10"));

  const phase10Query = useQuery<Phase10Readiness>({
    queryKey: [PHASE10_READINESS, companyKey],
    queryFn: () => readJson<Phase10Readiness>(PHASE10_READINESS),
    retry: false,
  });

  const rotatePhase10 = () => setPhase10RequestId(makeRequestId("gc-p10"));

  const phase10 = phase10Query.data;
  const phase10Choice = selectedAccount(phase10ReceiptAccount, phase10?.receiptAccounts ?? []);
  // The fee is charged on top of the settlement, so it is never capped by the
  // payable — but it can only be booked when Shared Charges is configured.
  const phase10Fee = phase10TransferFee.trim() === "" ? 0 : Number(phase10TransferFee);
  const phase10FeeValid =
    Number.isFinite(phase10Fee) && phase10Fee >= 0 && (phase10Fee === 0 || phase10?.sharedChargesAccount != null);
  const phase10CanSubmit =
    phase10?.ready === true &&
    phase10Choice != null &&
    phase10FeeValid &&
    allowedAmount(phase10Amount, phase10.settleableSalesCashUsd);

  const phase10Mutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      if (!phase10Choice) throw new Error(releaseDebtEnglish("Select a receipt account."));
      const response = await apiRequest("POST", PHASE10_SETTLEMENT, {
        settlementDate: phase10Date,
        amountUsd: phase10Amount,
        transferFeeUsd: phase10TransferFee.trim() || "0",
        clientRequestId: phase10RequestId,
        receiptAccount: phase10Choice,
        reference: phase10Reference.trim() || null,
      });
      return (await response.json()) as MutationResult;
    },
    onSuccess: (result) => {
      invalidateReadiness();
      setPhase10Amount("");
      setPhase10TransferFee("");
      setPhase10Reference("");
      setPhase10RequestId(makeRequestId("gc-p10"));
      toast({
        title: releaseDebtEnglish(result.replayed ? "Settlement replay confirmed" : "GC Sales Cash settled"),
        description: releaseDebtEnglish("The outstanding sales-cash payable was refreshed."),
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
              <CircleDollarSign className="h-5 w-5" /> {releaseDebtEnglish("GC Sales Cash settlement")}
            </CardTitle>
            <CardDescription>
              {releaseDebtEnglish(
                "Phase 10 pays down only the server-calculated outstanding GC Sales Cash payable, out of an approved Golden Coast cash or bank account."
              )}
            </CardDescription>
          </div>
          <Badge variant="secondary">{releaseDebtEnglish("Phase 10")}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <ReadinessState
          loading={phase10Query.isLoading}
          error={phase10Query.error}
          ready={phase10?.ready === true}
          readyText={releaseDebtEnglish("Direct GC Sales Cash payment is ready.")}
          blockedText={releaseDebtEnglish(
            "Payment is not ready. Refresh after resolving the server-reported account state."
          )}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border p-4">
            <p className="text-xs text-muted-foreground">{releaseDebtEnglish("GC Sales Cash payable due")}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{money(phase10?.settleableSalesCashUsd)}</p>
          </div>
          <div className="rounded-md border p-4">
            <p className="text-xs text-muted-foreground">{releaseDebtEnglish("Outstanding payable balance")}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{money(phase10?.rawSalesCashPayableBalanceUsd)}</p>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gc-phase10-date">
              {releaseDebtEnglish("Payment date")}
            </label>
            <Input
              id="gc-phase10-date"
              type="date"
              value={phase10Date}
              onChange={(event) => {
                setPhase10Date(event.target.value);
                rotatePhase10();
              }}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gc-phase10-amount">
              {releaseDebtEnglish("Amount (USD)")}
            </label>
            <Input
              id="gc-phase10-amount"
              type="number"
              min="0.01"
              step="0.01"
              max={phase10?.settleableSalesCashUsd ?? "0"}
              value={phase10Amount}
              onChange={(event) => {
                setPhase10Amount(event.target.value);
                rotatePhase10();
              }}
              data-testid="input-gc-phase10-amount"
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium" htmlFor="gc-phase10-transfer-fee">
              {releaseDebtEnglish("Transfer fee (USD)")}
            </label>
            <Input
              id="gc-phase10-transfer-fee"
              type="number"
              min="0"
              step="0.01"
              value={phase10TransferFee}
              onChange={(event) => {
                setPhase10TransferFee(event.target.value);
                rotatePhase10();
              }}
              data-testid="input-gc-phase10-transfer-fee"
            />
            <p className="text-xs text-muted-foreground">
              {phase10?.sharedChargesAccount == null
                ? releaseDebtEnglish("Shared Charges is not configured, so no transfer fee can be charged.")
                : releaseDebtEnglish(
                    "Paid on top of the settlement and booked to Shared Charges; the payable still falls by the full amount."
                  )}
            </p>
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium" htmlFor="select-gc-phase10-receipt-account">
              {releaseDebtEnglish("Paying cash/bank account")}
            </label>
            <AccountPicker
              id="select-gc-phase10-receipt-account"
              value={phase10ReceiptAccount}
              accounts={phase10?.receiptAccounts ?? []}
              onChange={(value) => {
                setPhase10ReceiptAccount(value);
                rotatePhase10();
              }}
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium" htmlFor="gc-phase10-reference">
              {releaseDebtEnglish("Reference (optional)")}
            </label>
            <Input
              id="gc-phase10-reference"
              value={phase10Reference}
              maxLength={200}
              onChange={(event) => {
                setPhase10Reference(event.target.value);
                rotatePhase10();
              }}
            />
          </div>
        </div>
        {recordChanges.allowed && (
          <Button
            onClick={() => phase10Mutation.mutate()}
            disabled={!phase10CanSubmit || phase10Mutation.isPending}
            data-testid="button-gc-phase10-submit"
          >
            {phase10Mutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CircleDollarSign className="mr-2 h-4 w-4" />
            )}
            {releaseDebtEnglish("Post direct settlement")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
