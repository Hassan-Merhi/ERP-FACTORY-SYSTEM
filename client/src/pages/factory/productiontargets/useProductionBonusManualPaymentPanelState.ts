// Extracted from ./ProductionBonusManualPaymentPanel.tsx
import { useState } from "react";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import { localDateStr } from "../factoryProductionTargetsModel";
import { mondayOfProductionBonusWeek } from "@shared/productionTargetBonusWeeklyMethod";

const endpoint = "/api/factory/production-target-bonuses/checkout/manual-payments";

type CashAccount = { id: number; name: string; code: string; openingCurrency: string | null };

export type ManualBonusPayment = {
  id: number;
  workerId: number;
  workerName: string;
  amount: string;
  weekStart: string;
  paymentDate: string;
  status: "POSTED" | "REVERSED";
  voucherId: number;
  reversalVoucherId: number | null;
  cashAccountName: string;
};

export type ManualBonusHistory = { payments: ManualBonusPayment[] };

type Worker = { workerId: number; workerName: string };

export type Props = {
  rosterDate: string;
  workers: Worker[];
  selected: number[];
  amounts: Record<number, string>;
  onReset: () => void;
};

async function api<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const response = await factoryApiRequest(method, url, body);
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message || "Manual bonus payment failed");
  return result as T;
}

const validAmount = (value: string) =>
  /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(value) && Number(value) > 0 && Number(value) <= 1000000;

const isDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value + "T12:00:00Z")) &&
  new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value;

export function useProductionBonusManualPaymentPanelState({
  rosterDate,
  workers,
  selected,
  amounts,
  onReset,
}: Pick<Props, "rosterDate" | "workers" | "selected" | "amounts" | "onReset">) {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const [accountId, setAccountId] = useState("");
  const [paymentDate, setPaymentDate] = useState(() => localDateStr(new Date()));
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reverseRow, setReverseRow] = useState<ManualBonusPayment | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const weekStart = mondayOfProductionBonusWeek(rosterDate) ?? "";
  const historyKey = [endpoint, weekStart];
  const { data: accountData, error: accountError } = useQuery<{ accounts: CashAccount[] }>({
    queryKey: ["/api/factory/staff-tracking/production-bonuses/payment-accounts"],
    queryFn: () => api("GET", "/api/factory/staff-tracking/production-bonuses/payment-accounts"),
  });
  const { data: history, error: historyError } = useQuery<ManualBonusHistory>({
    queryKey: historyKey,
    enabled: Boolean(weekStart),
    queryFn: () => api("GET", endpoint + "?" + new URLSearchParams({ weekStart })),
  });
  const accounts = (accountData?.accounts ?? []).filter(
    (account) => !account.openingCurrency || account.openingCurrency.toUpperCase() === "USD"
  );
  const chosen = selected.map((workerId) => ({
    workerId,
    workerName: workers.find((worker) => worker.workerId === workerId)?.workerName ?? String(workerId),
    amount: amounts[workerId] ?? "",
  }));
  const allValid = chosen.length > 0 && chosen.length <= 100 && chosen.every((item) => validAmount(item.amount));
  const total =
    chosen.reduce((sum, item) => sum + (validAmount(item.amount) ? Math.round(Number(item.amount) * 100) : 0), 0) / 100;
  const canReview = allValid && Boolean(accountId) && isDate(paymentDate) && paymentDate >= weekStart;
  const paidIds = new Set(
    (history?.payments ?? []).filter((item) => item.status === "POSTED").map((item) => item.workerId)
  );
  const hasExisting = chosen.some((item) => paidIds.has(item.workerId));
  const post = useMutation({
    mutationFn: () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return api<{ posted: number; replayed: number }>("POST", endpoint.replace("/manual-payments", "/manual-pay"), {
        confirm: true,
        currency: "USD",
        weekStart,
        rosterDate,
        paymentDate,
        cashAccountId: Number(accountId),
        requestKey,
        selections: chosen.map((item) => ({ workerId: item.workerId, amount: item.amount })),
      });
    },
    onSuccess: (result) => {
      setConfirmOpen(false);
      onReset();
      setRequestKey(crypto.randomUUID());
      toast({
        title: "Manual bonus payment posted",
        description: `${result.posted} payments posted, ${result.replayed} safe retries. View the payment vouchers and Daybook.`,
      });
      void queryClient.invalidateQueries({ queryKey: [endpoint] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/production-target-bonuses/weekly-payments"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/staff-tracking/production-bonuses/payments"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/production-target-bonuses/report"] });
    },
    onError: (error: Error) =>
      toast({ title: "Manual payment not posted", description: error.message, variant: "destructive" }),
  });
  const reverse = useMutation({
    mutationFn: () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return api("POST", endpoint + "/" + reverseRow!.id + "/reverse", {
        confirm: true,
        reversalDate: paymentDate,
        reason: reverseReason.trim(),
      });
    },
    onSuccess: () => {
      setReverseRow(null);
      setReverseReason("");
      toast({
        title: "Manual bonus reversed",
        description: "A reversing Receipt voucher was posted; both actions remain in the audit trail.",
      });
      void queryClient.invalidateQueries({ queryKey: [endpoint] });
    },
    onError: (error: Error) =>
      toast({ title: "Reversal not posted", description: error.message, variant: "destructive" }),
  });
  return {
    recordChanges,
    accountId,
    setAccountId,
    paymentDate,
    setPaymentDate,
    setConfirmOpen,
    confirmOpen,
    setReverseRow,
    reverseRow,
    setReverseReason,
    reverseReason,
    weekStart,
    accountError,
    historyError,
    history,
    accounts,
    chosen,
    allValid,
    total,
    canReview,
    hasExisting,
    post,
    reverse,
  };
}
