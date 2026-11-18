// Extracted from ./IntercompanyPayments.tsx to keep that module under the source-size cap.
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { invalidateApiFamily } from "@/lib/frontendDataArchitecture";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useApplicationLanguageCode } from "@/contexts/ApplicationLanguageContext";
import { intercompanyVoucherText } from "@/i18n/intercompanyVoucherTranslations";
import {
  BASE,
  dateNow,
  getJson,
  money,
  newKey,
  parseCash,
  type HistoryPayment,
  type Pair,
  type Setup,
} from "./IntercompanyPaymentsTypes";

export function useIntercompanyPaymentsContentState({ embedded = false }: { embedded?: boolean } = {}) {
  const { selectedCompany } = useCompany();
  const voucherCopy = intercompanyVoucherText(useApplicationLanguageCode());
  const { toast } = useToast();
  const companyId = Number(selectedCompany?.id || 0);
  const [relationshipId, setRelationshipId] = useState<number | null>(null);
  const [transactionCurrency, setCurrency] = useState<"USD" | "CFA" | "ZMW">("USD");
  const [nativeAmount, setNativeAmount] = useState("");
  const [historicalRate, setHistoricalRate] = useState("1");
  const [paymentDate, setPaymentDate] = useState(dateNow);
  const [transferReference, setTransferReference] = useState("");
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("Confirmed intercompany container settlement");
  const [sourceCash, setSourceCash] = useState("");
  const [destinationCash, setDestinationCash] = useState("");
  const [allocation, setAllocation] = useState<Record<number, string>>({});
  const [sourceConfirmed, setSourceConfirmed] = useState(false);
  const [destConfirmed, setDestConfirmed] = useState(false);
  const [requestKey, setRequestKey] = useState(newKey);
  const [reversing, setReversing] = useState<number | null>(null);
  const [reversalReason, setReversalReason] = useState("");
  const [reversalDate, setReversalDate] = useState(dateNow);
  const [reverseReceipt, setReverseReceipt] = useState(false);
  const [reversePayment, setReversePayment] = useState(false);
  const [reversalKey, setReversalKey] = useState(newKey);

  useEffect(() => {
    setRelationshipId(null);
    setSourceCash("");
    setDestinationCash("");
    setAllocation({});
    setSourceConfirmed(false);
    setDestConfirmed(false);
    setReversing(null);
    setNativeAmount("");
    setHistoricalRate("1");
    setCurrency("USD");
    setPaymentDate(dateNow());
    setTransferReference("");
    setEvidence("");
    setRequestKey(newKey());
    setReversalKey(newKey());
    setReversalReason("");
    setReverseReceipt(false);
    setReversePayment(false);
  }, [companyId]);
  const pairs = useQuery<{ relationships: Pair[] }>({
    queryKey: companyQueryKey(BASE + "/relationships", companyId),
    enabled: companyId > 0,
    queryFn: () => getJson(BASE + "/relationships"),
    retry: false,
  });
  const setup = useQuery<Setup>({
    queryKey: companyQueryKey(BASE + "/pairs/" + relationshipId + "/setup", companyId),
    enabled: companyId > 0 && relationshipId != null,
    queryFn: () => getJson(BASE + "/pairs/" + relationshipId + "/setup"),
    retry: false,
  });
  const history = useQuery<{ relationshipId: number; history: HistoryPayment[] }>({
    queryKey: companyQueryKey(BASE + "/pairs/" + relationshipId + "/history", companyId),
    enabled: companyId > 0 && relationshipId != null,
    queryFn: () => getJson(BASE + "/pairs/" + relationshipId + "/history"),
    retry: false,
  });
  useEffect(() => {
    setSourceCash("");
    setDestinationCash("");
    setAllocation({});
    setSourceConfirmed(false);
    setDestConfirmed(false);
    setNativeAmount("");
    setTransferReference("");
    setEvidence("");
    setRequestKey(newKey());
    setReversing(null);
  }, [relationshipId]);
  const refresh = () => {
    // Refresh both the source-side receipt and destination-side payment
    // vouchers from the active company's ordinary Vouchers page.
    for (const family of [
      "/api/vouchers",
      "/api/accounts",
      "/api/ledger-accounts",
      "/api/bank-accounts",
      "/api/suppliers",
      "/api/daybook",
      "/api/net-position",
    ]) {
      void invalidateApiFamily(queryClient, family);
    }
    queryClient.invalidateQueries({
      queryKey: companyQueryKey(BASE + "/pairs/" + relationshipId + "/setup", companyId),
    });
    queryClient.invalidateQueries({
      queryKey: companyQueryKey(BASE + "/pairs/" + relationshipId + "/history", companyId),
    });
    queryClient.invalidateQueries({
      queryKey: companyQueryKey("/api/intercompany-container-trading/linked-trades", companyId),
    });
  };
  const confirm = useMutation({
    mutationFn: async () => {
      if (!setup.data) throw new Error("Select an involved company pair");
      const allocations = setup.data.purchaseOrders
        .filter((p) => Number(allocation[p.tradeId] || 0) > 0)
        .map((p) => ({ tradeId: p.tradeId, expectedVersion: p.version, amount: allocation[p.tradeId] }));
      const response = await apiRequest("POST", BASE + "/confirm", {
        relationshipId: setup.data.relationshipId,
        requestKey,
        paymentDate,
        currency: transactionCurrency,
        transactionAmount: nativeAmount,
        historicalRate,
        sourceReceiptAccount: parseCash(sourceCash),
        destinationPaymentAccount: parseCash(destinationCash),
        transferReference: transferReference.trim(),
        confirmationEvidence: evidence.trim(),
        reason: reason.trim(),
        confirmedSourceReceipt: sourceConfirmed,
        confirmedDestinationPayment: destConfirmed,
        allocations,
      });
      return response.json() as Promise<{ paymentId: number; usdAmount: string; unallocatedCredit: string }>;
    },
    onSuccess: (data) => {
      toast({
        title: "Actual payment mirrored in both companies",
        description: "Payment #" + data.paymentId + " posted. Unallocated credit " + money(data.unallocatedCredit),
      });
      setRequestKey(newKey());
      setAllocation({});
      setNativeAmount("");
      setTransferReference("");
      setEvidence("");
      setSourceConfirmed(false);
      setDestConfirmed(false);
      refresh();
    },
    onError: (error: Error) =>
      toast({ title: "No cash was posted", description: error.message, variant: "destructive" }),
  });
  const reversal = useMutation({
    mutationFn: async () => {
      if (reversing == null) throw new Error("Select a payment to reverse");
      const response = await apiRequest("POST", BASE + "/" + reversing + "/reverse", {
        requestKey: reversalKey,
        reversalDate,
        reason: reversalReason.trim(),
        confirmedSourceReversal: reverseReceipt,
        confirmedDestinationReversal: reversePayment,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Both payment vouchers reversed together",
        description: "Original vouchers and historical FX evidence were preserved.",
      });
      setReversing(null);
      setReversalKey(newKey());
      setReversalReason("");
      setReverseReceipt(false);
      setReversePayment(false);
      refresh();
    },
    onError: (error: Error) =>
      toast({ title: "Reversal was not posted", description: error.message, variant: "destructive" }),
  });
  const usdAmount = Number(nativeAmount || 0) / Number(historicalRate || 1);
  const manuallyAllocated = Object.values(allocation).reduce((sum, value) => sum + Number(value || 0), 0);
  const invalidPoAllocation = Object.entries(allocation).some(([tradeId, value]) => {
    if (!value.trim()) return false;
    if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return true;
    const linked = setup.data?.purchaseOrders.find((po) => po.tradeId === Number(tradeId));
    return !linked || Math.round(Number(value) * 100) > Math.round(Number(linked.unpaid) * 100);
  });
  const canConfirm = Boolean(
    setup.data?.tradeEnabled &&
    relationshipId &&
    sourceCash &&
    destinationCash &&
    transferReference.trim().length >= 5 &&
    evidence.trim().length >= 8 &&
    nativeAmount &&
    historicalRate &&
    Number.isFinite(usdAmount) &&
    usdAmount > 0 &&
    sourceConfirmed &&
    destConfirmed &&
    !invalidPoAllocation &&
    manuallyAllocated <= Math.round(usdAmount * 100) / 100 + 0.00001 &&
    !confirm.isPending
  );
  const sourceAccounts = setup.data?.cashAccounts.filter((a) => a.companyId === setup.data?.sourceCompanyId) || [];
  const destAccounts = setup.data?.cashAccounts.filter((a) => a.companyId === setup.data?.destinationCompanyId) || [];
  const chosen = setup.data?.purchaseOrders || [];
  const availableCredit = setup.data?.credits.reduce((n, c) => n + Number(c.available), 0) || 0;
  return {
    allocation,
    availableCredit,
    canConfirm,
    chosen,
    companyId,
    confirm,
    destAccounts,
    destConfirmed,
    destinationCash,
    embedded,
    evidence,
    historicalRate,
    history,
    manuallyAllocated,
    nativeAmount,
    pairs,
    paymentDate,
    reason,
    relationshipId,
    reversal,
    reversalDate,
    reversalReason,
    reversePayment,
    reverseReceipt,
    reversing,
    selectedCompany,
    setAllocation,
    setCurrency,
    setDestConfirmed,
    setDestinationCash,
    setEvidence,
    setHistoricalRate,
    setNativeAmount,
    setPaymentDate,
    setReason,
    setRelationshipId,
    setReversalDate,
    setReversalReason,
    setReversePayment,
    setReverseReceipt,
    setReversing,
    setSourceCash,
    setSourceConfirmed,
    setTransferReference,
    setup,
    sourceAccounts,
    sourceCash,
    sourceConfirmed,
    transactionCurrency,
    transferReference,
    usdAmount,
    voucherCopy,
  };
}
