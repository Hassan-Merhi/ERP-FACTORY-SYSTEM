/**
 * Phase 9 — Hassan Savings withdrawal.
 *
 * The payable amount is whatever the server reports as available; the panel
 * additionally requires a reason and the exact confirmation phrase before it
 * will enable the sensitive action.
 */
import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, WalletCards } from "lucide-react";
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
  HASSAN_SAVINGS_CONFIRMATION,
  PHASE9_READINESS,
  PHASE9_WITHDRAWAL,
  type CompanyKey,
  type MutationResult,
  type Phase9Readiness,
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

export function HassanSavingsPanel({ companyKey }: { companyKey: CompanyKey }) {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const invalidateReadiness = useReadinessInvalidation();

  const [phase9Date, setPhase9Date] = useState(todayIso);
  const [phase9Amount, setPhase9Amount] = useState("");
  const [phase9PaymentAccount, setPhase9PaymentAccount] = useState("");
  const [phase9Reference, setPhase9Reference] = useState("");
  const [phase9Reason, setPhase9Reason] = useState("");
  const [phase9Confirmation, setPhase9Confirmation] = useState("");
  const [phase9RequestId, setPhase9RequestId] = useState(() => makeRequestId("gc-p9"));

  const phase9Query = useQuery<Phase9Readiness>({
    queryKey: [PHASE9_READINESS, companyKey],
    queryFn: () => readJson<Phase9Readiness>(PHASE9_READINESS),
    retry: false,
  });

  const rotatePhase9 = () => setPhase9RequestId(makeRequestId("gc-p9"));

  const phase9 = phase9Query.data;
  const phase9Choice = selectedAccount(phase9PaymentAccount, phase9?.paymentAccounts ?? []);
  const phase9CanSubmit =
    phase9?.ready === true &&
    phase9Choice != null &&
    allowedAmount(phase9Amount, phase9.availableSavingsUsd) &&
    phase9Reason.trim().length >= 5 &&
    phase9Confirmation.trim() === HASSAN_SAVINGS_CONFIRMATION;

  const phase9Mutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      if (!phase9Choice) throw new Error(releaseDebtEnglish("Select a payment account."));
      const response = await apiRequest("POST", PHASE9_WITHDRAWAL, {
        withdrawalDate: phase9Date,
        amountUsd: phase9Amount,
        clientRequestId: phase9RequestId,
        paymentAccount: phase9Choice,
        reference: phase9Reference.trim() || null,
        reason: phase9Reason.trim(),
        confirmation: phase9Confirmation.trim(),
      });
      return (await response.json()) as MutationResult;
    },
    onSuccess: (result) => {
      invalidateReadiness();
      setPhase9Amount("");
      setPhase9Reference("");
      setPhase9Reason("");
      setPhase9Confirmation("");
      setPhase9RequestId(makeRequestId("gc-p9"));
      toast({
        title: releaseDebtEnglish(result.replayed ? "Withdrawal replay confirmed" : "Hassan Savings withdrawn"),
        description: releaseDebtEnglish("The available Hassan Savings balance was refreshed."),
      });
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: releaseDebtEnglish("Withdrawal failed"), description: error.message, variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <WalletCards className="h-5 w-5" /> {releaseDebtEnglish("Hassan Savings withdrawal")}
            </CardTitle>
            <CardDescription>
              {releaseDebtEnglish(
                "Phase 9 pays out only from the live credit balance of the canonical Hassan Savings account."
              )}
            </CardDescription>
          </div>
          <Badge variant="secondary">{releaseDebtEnglish("Phase 9")}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <ReadinessState
          loading={phase9Query.isLoading}
          error={phase9Query.error}
          ready={phase9?.ready === true}
          readyText={releaseDebtEnglish("Hassan Savings is ready for a controlled withdrawal.")}
          blockedText={releaseDebtEnglish(
            "Withdrawal is not ready. Refresh after resolving the server-reported account state."
          )}
        />
        <div className="rounded-md border p-4">
          <p className="text-xs text-muted-foreground">{releaseDebtEnglish("Available Hassan Savings")}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{money(phase9?.availableSavingsUsd)}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gc-phase9-date">
              {releaseDebtEnglish("Withdrawal date")}
            </label>
            <Input
              id="gc-phase9-date"
              type="date"
              value={phase9Date}
              onChange={(event) => {
                setPhase9Date(event.target.value);
                rotatePhase9();
              }}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gc-phase9-amount">
              {releaseDebtEnglish("Amount (USD)")}
            </label>
            <Input
              id="gc-phase9-amount"
              type="number"
              min="0.01"
              step="0.01"
              max={phase9?.availableSavingsUsd ?? "0"}
              value={phase9Amount}
              onChange={(event) => {
                setPhase9Amount(event.target.value);
                rotatePhase9();
              }}
              data-testid="input-gc-phase9-amount"
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium" htmlFor="select-gc-phase9-payment-account">
              {releaseDebtEnglish("Payment account")}
            </label>
            <AccountPicker
              id="select-gc-phase9-payment-account"
              value={phase9PaymentAccount}
              accounts={phase9?.paymentAccounts ?? []}
              onChange={(value) => {
                setPhase9PaymentAccount(value);
                rotatePhase9();
              }}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gc-phase9-reference">
              {releaseDebtEnglish("Reference (optional)")}
            </label>
            <Input
              id="gc-phase9-reference"
              value={phase9Reference}
              maxLength={200}
              onChange={(event) => {
                setPhase9Reference(event.target.value);
                rotatePhase9();
              }}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gc-phase9-reason">
              {releaseDebtEnglish("Reason")}
            </label>
            <Input
              id="gc-phase9-reason"
              value={phase9Reason}
              maxLength={500}
              onChange={(event) => {
                setPhase9Reason(event.target.value);
                rotatePhase9();
              }}
              data-testid="input-gc-phase9-reason"
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium" htmlFor="gc-phase9-confirmation">
              {releaseDebtEnglish("Exact confirmation")}
            </label>
            <Input
              id="gc-phase9-confirmation"
              value={phase9Confirmation}
              onChange={(event) => {
                setPhase9Confirmation(event.target.value);
                rotatePhase9();
              }}
              placeholder={HASSAN_SAVINGS_CONFIRMATION}
              autoComplete="off"
              data-testid="input-gc-phase9-confirmation"
            />
            <p className="text-xs text-muted-foreground">
              {releaseDebtEnglish("Type exactly")}: <span className="font-mono">{HASSAN_SAVINGS_CONFIRMATION}</span>
            </p>
          </div>
        </div>
        {recordChanges.allowed && (
          <Button
            onClick={() => phase9Mutation.mutate()}
            disabled={!phase9CanSubmit || phase9Mutation.isPending}
            data-testid="button-gc-phase9-submit"
          >
            {phase9Mutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <WalletCards className="mr-2 h-4 w-4" />
            )}
            {releaseDebtEnglish("Withdraw Hassan Savings")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
