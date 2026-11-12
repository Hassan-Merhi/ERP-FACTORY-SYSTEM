import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, Loader2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { apiRequest } from "@/lib/queryClient";
import { PHASE7_READINESS, PHASE7_TRANSFER, type CompanyKey, type Phase7Readiness } from "./contracts";
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

const FRESH_START_HADI_READINESS = "/api/sp/golden-coast/phase7/sales-cash-pay-fresh-start/readiness";

interface HadiHeldBalanceReadiness {
  outstandingHadiSalesCashUsd: string;
  hadiIntercompanyAssetUsd: string;
}

function safeRemittanceCap(data?: HadiHeldBalanceReadiness): string {
  if (!data) return "0.00";
  const outstanding = Number(data.outstandingHadiSalesCashUsd ?? 0);
  const asset = Number(data.hadiIntercompanyAssetUsd ?? 0);
  if (!Number.isFinite(outstanding) || !Number.isFinite(asset)) return "0.00";
  return Math.max(0, Math.min(outstanding, asset)).toFixed(2);
}

export function HadiProceedsRemittancePanel({ companyKey }: { companyKey: CompanyKey }) {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const invalidateReadiness = useReadinessInvalidation();
  const [transferDate, setTransferDate] = useState(todayIso);
  const [amount, setAmount] = useState("");
  const [hadiAccount, setHadiAccount] = useState("");
  const [gcAccount, setGcAccount] = useState("");
  const [reference, setReference] = useState("");
  const [requestId, setRequestId] = useState(() => makeRequestId("gc-p16-remit"));

  const probe = useQuery<Phase7Readiness>({
    queryKey: [PHASE7_READINESS, companyKey, "phase16-remit-probe"],
    queryFn: () => readJson<Phase7Readiness>(PHASE7_READINESS),
    retry: false,
  });
  const targetCompanyId = probe.data?.pair?.hadiCompanyId ?? null;
  const authorizedLegacyUrl = targetCompanyId
    ? `${PHASE7_READINESS}?targetCompanyId=${encodeURIComponent(String(targetCompanyId))}`
    : PHASE7_READINESS;
  const authorized = useQuery<Phase7Readiness>({
    queryKey: [authorizedLegacyUrl, companyKey, "phase16-remit-authorized"],
    queryFn: () => readJson<Phase7Readiness>(authorizedLegacyUrl),
    enabled: targetCompanyId != null,
    retry: false,
  });
  const heldBalanceUrl = targetCompanyId
    ? `${FRESH_START_HADI_READINESS}?targetCompanyId=${encodeURIComponent(String(targetCompanyId))}`
    : FRESH_START_HADI_READINESS;
  const heldBalances = useQuery<HadiHeldBalanceReadiness>({
    queryKey: [heldBalanceUrl, companyKey, "phase16-remit-balance"],
    queryFn: () => readJson<HadiHeldBalanceReadiness>(heldBalanceUrl),
    enabled: targetCompanyId != null,
    retry: false,
  });

  const routing = authorized.data ?? probe.data;
  const maximum = safeRemittanceCap(heldBalances.data);
  const hadiChoice = selectedAccount(hadiAccount, routing?.hadiCashAccounts ?? []);
  const gcChoice = selectedAccount(gcAccount, routing?.goldenCoastCashAccounts ?? []);
  const canSubmit =
    targetCompanyId != null &&
    hadiChoice != null &&
    gcChoice != null &&
    allowedAmount(amount, maximum) &&
    transferDate.length === 10;
  const rotateRequest = () => setRequestId(makeRequestId("gc-p16-remit"));

  const mutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      if (!targetCompanyId || !hadiChoice || !gcChoice) {
        throw new Error(releaseDebtEnglish("HADI remittance routing is not ready."));
      }
      const response = await apiRequest(
        "POST",
        `${PHASE7_TRANSFER}?targetCompanyId=${encodeURIComponent(String(targetCompanyId))}`,
        {
          operation: "remit_from_hadi",
          transferDate,
          amountUsd: amount,
          clientRequestId: requestId,
          reference: reference.trim() || null,
          hadiCashAccount: hadiChoice,
          goldenCoastCashAccount: gcChoice,
        }
      );
      return response.json();
    },
    onSuccess: (result: { replayed?: boolean }) => {
      setAmount("");
      setReference("");
      setRequestId(makeRequestId("gc-p16-remit"));
      invalidateReadiness();
      toast({
        title: releaseDebtEnglish(result.replayed ? "HADI remittance replay confirmed" : "HADI proceeds remitted"),
        description: releaseDebtEnglish("Golden Coast and HADI intercompany balances were reduced together."),
      });
    },
    onError: (error: ClientErrorLike) => {
      toast({
        title: releaseDebtEnglish("HADI remittance failed"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <ArrowDownToLine className="h-5 w-5" /> {releaseDebtEnglish("Return HADI-held proceeds to Golden Coast")}
            </CardTitle>
            <CardDescription>
              {releaseDebtEnglish(
                "Use this when HADI still holds Golden Coast sale proceeds that should come back to Golden Coast, including after Golden Coast paid Fresh Start directly."
              )}
            </CardDescription>
          </div>
          <Badge variant="secondary">{releaseDebtEnglish("Phase 16 remittance")}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <ReadinessState
          loading={probe.isLoading || authorized.isLoading || heldBalances.isLoading}
          error={heldBalances.error ?? authorized.error ?? probe.error}
          ready={
            Number(maximum) > 0 &&
            (routing?.hadiCashAccounts?.length ?? 0) > 0 &&
            (routing?.goldenCoastCashAccounts?.length ?? 0) > 0
          }
          readyText={releaseDebtEnglish("HADI has Golden Coast sale proceeds available to remit.")}
          blockedText={releaseDebtEnglish("No HADI-held Golden Coast proceeds are currently available to remit.")}
        />

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">{releaseDebtEnglish("Sales proceeds still held by HADI")}</p>
            <p className="mt-1 font-semibold tabular-nums">{money(heldBalances.data?.outstandingHadiSalesCashUsd)}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">{releaseDebtEnglish("GC HADI intercompany asset")}</p>
            <p className="mt-1 font-semibold tabular-nums">{money(heldBalances.data?.hadiIntercompanyAssetUsd)}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">{releaseDebtEnglish("Maximum remittance now")}</p>
            <p className="mt-1 font-semibold tabular-nums">{money(maximum)}</p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gc-p16-remit-date">
              {releaseDebtEnglish("Remittance date")}
            </label>
            <Input
              id="gc-p16-remit-date"
              type="date"
              value={transferDate}
              onChange={(event) => {
                setTransferDate(event.target.value);
                rotateRequest();
              }}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gc-p16-remit-amount">
              {releaseDebtEnglish("Amount (USD)")}
            </label>
            <Input
              id="gc-p16-remit-amount"
              type="number"
              min="0.01"
              step="0.01"
              max={maximum}
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                rotateRequest();
              }}
              data-testid="input-gc-p16-remit-amount"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gc-p16-remit-hadi">
              {releaseDebtEnglish("HADI paying account")}
            </label>
            <AccountPicker
              id="gc-p16-remit-hadi"
              value={hadiAccount}
              accounts={routing?.hadiCashAccounts ?? []}
              onChange={(value) => {
                setHadiAccount(value);
                rotateRequest();
              }}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gc-p16-remit-gc">
              {releaseDebtEnglish("Golden Coast receiving account")}
            </label>
            <AccountPicker
              id="gc-p16-remit-gc"
              value={gcAccount}
              accounts={routing?.goldenCoastCashAccounts ?? []}
              onChange={(value) => {
                setGcAccount(value);
                rotateRequest();
              }}
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium" htmlFor="gc-p16-remit-reference">
              {releaseDebtEnglish("Reference (optional)")}
            </label>
            <Input
              id="gc-p16-remit-reference"
              value={reference}
              maxLength={200}
              onChange={(event) => {
                setReference(event.target.value);
                rotateRequest();
              }}
            />
          </div>
        </div>

        {recordChanges.allowed && (
          <Button
            onClick={() => mutation.mutate()}
            disabled={!canSubmit || mutation.isPending}
            data-testid="button-gc-p16-remit-submit"
          >
            {mutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ArrowDownToLine className="mr-2 h-4 w-4" />
            )}
            {releaseDebtEnglish("Remit proceeds to Golden Coast")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
