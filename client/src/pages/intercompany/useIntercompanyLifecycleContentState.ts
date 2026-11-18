// Extracted from ./IntercompanyLifecycle.tsx to keep that module under the source-size cap.
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguageCode } from "@/contexts/ApplicationLanguageContext";
import { propertiesContainerIntercompanyText } from "@/i18n/propertiesContainerIntercompanyTranslations";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const API = "/api/intercompany-container-trading/lifecycle";

export const newKey = () =>
  "ic-phase5-" +
  (typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2));

const dateNow = () => new Date().toLocaleDateString("en-CA");

export const money = (value: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value));

type Trade = {
  tradeId: number;
  physicalContainerId: number;
  relationshipId: number;
  sourceCompanyId: number;
  destinationCompanyId: number;
  version: number;
  state: string;
  containerNumber: string;
  physicalStatus: string;
  landedCost: string;
  received: null | { id: number; date: string; locationId: number; voucherId: number };
  canceled: null | { id: number; date: string; releasedCredit: string };
  hasSharedInvoices: boolean;
  pendingSharedAllocation: boolean;
  accountingNetted: boolean;
};

type Lifecycle = {
  trades: Trade[];
  locations: Array<{ id: number; name: string }>;
  inventoryAccounts: Array<{ id: number; name: string }>;
};

async function load(companyId: number): Promise<Lifecycle> {
  if (!companyId) throw new Error("Select a company");
  const response = await fetch(API, { credentials: "include" });
  const value = await response.json().catch(() => ({ message: "Cannot read intercompany lifecycle" }));
  if (!response.ok) throw new Error(value.message || "Cannot read intercompany lifecycle");
  return value as Lifecycle;
}

export function useIntercompanyLifecycleContentState({
  physicalContainerId,
  embedded = false,
}: { physicalContainerId?: number; embedded?: boolean } = {}) {
  const { selectedCompany } = useCompany();
  const copy = propertiesContainerIntercompanyText(useApplicationLanguageCode());
  const companyId = Number(selectedCompany?.id || 0);
  const { toast } = useToast();
  const [selectedTradeId, setSelectedTradeId] = useState<number | null>(null);
  const [locationId, setLocationId] = useState("");
  const [date, setDate] = useState(dateNow);
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [arrivalVerified, setArrivalVerified] = useState(false);
  const [costVerified, setCostVerified] = useState(false);
  const [goodsNotReceived, setGoodsNotReceived] = useState(false);
  const [cashUnchanged, setCashUnchanged] = useState(false);
  const [redistributed, setRedistributed] = useState(false);
  const [receiptKey, setReceiptKey] = useState(newKey);
  const [cancelKey, setCancelKey] = useState(newKey);
  const [deleteBothConfirmed, setDeleteBothConfirmed] = useState(false);
  const [profitNettingConfirmed, setProfitNettingConfirmed] = useState(false);

  const query = useQuery({
    queryKey: companyQueryKey(API, companyId),
    enabled: companyId > 0,
    queryFn: () => load(companyId),
    retry: false,
  });
  const visibleTrades = physicalContainerId
    ? (query.data?.trades ?? []).filter((row) => row.physicalContainerId === physicalContainerId)
    : (query.data?.trades ?? []);
  const trade = visibleTrades.find((row) => row.tradeId === selectedTradeId);
  const receivingOptions = useQuery<{
    destinationCompanyId: number;
    locations: Array<{ id: number; name: string }>;
    inventoryAccountId: number | null;
    inventoryAccountStatus: "ready" | "ambiguous" | "missing";
  }>({
    queryKey: companyQueryKey(API + "/" + trade?.tradeId + "/receiving-options", companyId),
    enabled: Boolean(
      trade &&
      trade.state === "active" &&
      !trade.received &&
      !trade.canceled &&
      (selectedCompany?.companyType !== "properties" || ["Owner", "Developer"].includes(selectedCompany?.role ?? ""))
    ),
    queryFn: async () => {
      const response = await fetch(API + "/" + trade!.tradeId + "/receiving-options", { credentials: "include" });
      const value = await response.json().catch(() => ({ message: copy.receivingOptionsFailed }));
      if (!response.ok) throw new Error(value.message || copy.receivingOptionsFailed);
      return value;
    },
    retry: false,
  });
  useEffect(() => {
    setSelectedTradeId(null);
    setLocationId("");
    setEvidence("");
    setReason("");
    setArrivalVerified(false);
    setCostVerified(false);
    setGoodsNotReceived(false);
    setCashUnchanged(false);
    setRedistributed(false);
    setReceiptKey(newKey());
    setCancelKey(newKey());
    setDeleteBothConfirmed(false);
    setProfitNettingConfirmed(false);
  }, [companyId, physicalContainerId]);
  useEffect(() => {
    if (!physicalContainerId || !query.data) return;
    const matching = query.data.trades.find((row) => row.physicalContainerId === physicalContainerId);
    setSelectedTradeId(matching?.tradeId ?? null);
  }, [physicalContainerId, query.data]);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: companyQueryKey(API, companyId) });
    queryClient.invalidateQueries({ queryKey: ["/api/containers"] });
    if (physicalContainerId) queryClient.invalidateQueries({ queryKey: [`/api/containers/${physicalContainerId}`] });
    queryClient.invalidateQueries({
      queryKey: companyQueryKey("/api/intercompany-container-trading/linked-trades", companyId),
    });
    queryClient.invalidateQueries({
      queryKey: companyQueryKey("/api/intercompany-container-trading/payments/relationships", companyId),
    });
  };
  const receive = useMutation({
    mutationFn: async () => {
      if (!trade) throw new Error("Select a linked container");
      const response = await apiRequest("POST", API + "/" + trade.tradeId + "/receive", {
        expectedVersion: trade.version,
        requestKey: receiptKey,
        postingDate: date,
        locationId: Number(locationId),
        inventoryAccountId: Number(receivingOptions.data?.inventoryAccountId),
        arrivalEvidence: evidence.trim(),
        reason: reason.trim(),
        confirmPhysicalArrival: arrivalVerified,
        confirmNoAdditionalUnpostedCharges: costVerified,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Destination ERP inventory received",
        description: "One GIT-to-INVENTORY voucher and canonical stock evidence were posted together.",
      });
      setReceiptKey(newKey());
      setSelectedTradeId(null);
      setEvidence("");
      setArrivalVerified(false);
      setCostVerified(false);
      refresh();
    },
    onError: (error: Error) =>
      toast({ title: "Receipt not posted", description: error.message, variant: "destructive" }),
  });
  const cancel = useMutation({
    mutationFn: async () => {
      if (!trade) throw new Error("Select a linked container");
      const response = await apiRequest("POST", API + "/" + trade.tradeId + "/cancel", {
        expectedVersion: trade.version,
        requestKey: cancelKey,
        postingDate: date,
        cancellationEvidence: evidence.trim(),
        reason: reason.trim(),
        sharedChargeDecision: trade.hasSharedInvoices ? "redistributed" : "none",
        confirmGoodsNotReceived: goodsNotReceived,
        confirmNoRealCashReversal: cashUnchanged,
      });
      return response.json() as Promise<{ releasedCredit: string }>;
    },
    onSuccess: (result) => {
      toast({
        title: "Unreceived internal trade canceled",
        description:
          "Original purchases and cash retained; " + money(result.releasedCredit) + " returned to same-pair credit.",
      });
      setCancelKey(newKey());
      setSelectedTradeId(null);
      setEvidence("");
      setGoodsNotReceived(false);
      setCashUnchanged(false);
      setRedistributed(false);
      refresh();
    },
    onError: (error: Error) =>
      toast({ title: "Cancellation refused", description: error.message, variant: "destructive" }),
  });
  const normalizeInternalProfit = useMutation({
    mutationFn: async () => {
      if (!trade || !profitNettingConfirmed) throw new Error("Confirm the accounting normalization");
      const response = await apiRequest("POST", API + "/" + trade.tradeId + "/normalize-internal-profit", {
        expectedVersion: trade.version,
        postingDate: date,
        confirmNoCashOrStockChange: true,
      });
      return response.json() as Promise<{ amount?: string; alreadyNetted: boolean }>;
    },
    onSuccess: (result) => {
      toast({
        title: result.alreadyNetted ? "Already reconciled" : "Intercompany accounts normalized",
        description: result.alreadyNetted
          ? "The technical Sales and COGS balances have already been eliminated."
          : "Internal Sales and COGS were netted without changing cash, stock or supplier balances.",
      });
      setProfitNettingConfirmed(false);
      refresh();
      queryClient.invalidateQueries({ queryKey: ["/api/accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
    },
    onError: (error: Error) =>
      toast({ title: "Accounting normalization refused", description: error.message, variant: "destructive" }),
  });
  const deleteLinked = useMutation({
    mutationFn: async () => {
      if (!trade || !deleteBothConfirmed) throw new Error("Confirm deletion of both company POs");
      const response = await apiRequest("POST", API + "/" + trade.tradeId + "/delete-linked", {
        expectedVersion: trade.version,
        confirmDeleteBothCompanies: true,
      });
      return response.json() as Promise<{ poIds: number[]; voucherIds: number[] }>;
    },
    onSuccess: (result) => {
      toast({
        title: "Linked purchase orders deleted in both companies",
        description:
          result.poIds.length +
          " POs and " +
          result.voucherIds.length +
          " original vouchers removed. No reversal vouchers created.",
      });
      setSelectedTradeId(null);
      setDeleteBothConfirmed(false);
      refresh();
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers"] });
    },
    onError: (error: Error) =>
      toast({ title: "Linked deletion refused", description: error.message, variant: "destructive" }),
  });
  const canReceive = Boolean(
    trade &&
    trade.state === "active" &&
    !trade.received &&
    !trade.canceled &&
    Boolean(receivingOptions.data?.inventoryAccountId) &&
    Boolean(receivingOptions.data?.locations.some((loc) => String(loc.id) === locationId)) &&
    locationId &&
    date &&
    evidence.trim().length >= 8 &&
    reason.trim().length >= 3 &&
    arrivalVerified &&
    costVerified &&
    !receive.isPending
  );
  const canCancel = Boolean(
    trade &&
    trade.state === "active" &&
    !trade.received &&
    !trade.canceled &&
    ["Owner", "Developer"].includes(selectedCompany?.role ?? "") &&
    !trade.pendingSharedAllocation &&
    (!trade.hasSharedInvoices || redistributed) &&
    evidence.trim().length >= 8 &&
    reason.trim().length >= 3 &&
    goodsNotReceived &&
    cashUnchanged &&
    date &&
    !cancel.isPending
  );
  return {
    arrivalVerified,
    canCancel,
    canReceive,
    cancel,
    cashUnchanged,
    companyId,
    copy,
    costVerified,
    date,
    deleteBothConfirmed,
    deleteLinked,
    embedded,
    evidence,
    goodsNotReceived,
    locationId,
    normalizeInternalProfit,
    profitNettingConfirmed,
    query,
    reason,
    receive,
    receivingOptions,
    redistributed,
    selectedCompany,
    setArrivalVerified,
    setCancelKey,
    setCashUnchanged,
    setCostVerified,
    setDate,
    setDeleteBothConfirmed,
    setEvidence,
    setGoodsNotReceived,
    setLocationId,
    setProfitNettingConfirmed,
    setReason,
    setReceiptKey,
    setRedistributed,
    setSelectedTradeId,
    trade,
    visibleTrades,
  };
}
