// Extracted from ./LinkedTradesEditor.tsx to keep that module under the source-size cap.
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguageCode } from "@/contexts/ApplicationLanguageContext";
import { propertiesContainerIntercompanyText } from "@/i18n/propertiesContainerIntercompanyTranslations";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  BASE,
  today,
  key,
  json,
  toCents,
  type TradeRow,
  type TradeDetail,
  type AllocationPreview,
  type InvoiceDetail,
  type EditableLine,
} from "./useLinkedTradesEditorContentStateHelpers";
export { toCents } from "./useLinkedTradesEditorContentStateHelpers";

export const money = (v: string | number | null) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(v || 0));

export function useLinkedTradesEditorContentState({
  physicalContainerId,
  embedded = false,
}: { physicalContainerId?: number; embedded?: boolean } = {}) {
  const { selectedCompany } = useCompany();
  const copy = propertiesContainerIntercompanyText(useApplicationLanguageCode());
  const { toast } = useToast();
  const companyId = Number(selectedCompany?.id || 0);
  const isProperties = selectedCompany?.companyType === "properties";
  const [selected, setSelected] = useState<number | null>(null);
  const [rows, setRows] = useState<EditableLine[]>([]);
  const [reason, setReason] = useState("Correct confirmed supplier purchase pricing");
  const [postingDate, setPostingDate] = useState(today);
  const [chargeDate, setChargeDate] = useState(today);
  const [invoiceKey, setInvoiceKey] = useState("");
  const [invoiceEvidence, setInvoiceEvidence] = useState("");
  const [chargeType, setChargeType] = useState("freight");
  const [face, setFace] = useState("");
  const [chosen, setChosen] = useState<number[]>([]);
  const [proposal, setProposal] = useState<AllocationPreview | null>(null);
  const [manual, setManual] = useState<Record<number, string>>({});
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [lookupId, setLookupId] = useState<number | null>(null);
  const [newAmounts, setNewAmounts] = useState<Record<number, string>>({});
  const [chargeReason, setChargeReason] = useState("Reallocate verified shared freight invoice");
  const [grantee, setGrantee] = useState("");
  const [grantRelation, setGrantRelation] = useState("");
  const [grantScope, setGrantScope] = useState<"invoice" | "relationship">("invoice");
  useEffect(() => {
    setSelected(null);
    setRows([]);
    setChosen([]);
    setProposal(null);
    setLookupId(null);
    setInvoiceNumber("");
    setGrantee("");
  }, [companyId, physicalContainerId]);

  const list = useQuery<{ trades: TradeRow[] }>({
    queryKey: companyQueryKey(BASE + "/linked-trades", companyId, physicalContainerId ?? "all"),
    enabled: companyId > 0,
    queryFn: () =>
      json(BASE + "/linked-trades" + (physicalContainerId ? "?physicalContainerId=" + physicalContainerId : "")),
    retry: false,
  });
  const activeScopedTrades = physicalContainerId
    ? (list.data?.trades ?? []).filter((row) => row.physicalContainerId === physicalContainerId)
    : (list.data?.trades ?? []);
  useEffect(() => {
    if (!physicalContainerId || !list.data) return;
    const matching = list.data.trades.find((row) => row.physicalContainerId === physicalContainerId);
    setSelected(matching?.tradeId ?? null);
    if (matching) setChosen((previous) => (previous.length ? previous : [matching.tradeId]));
  }, [physicalContainerId, list.data]);
  const validScopedSelection = !physicalContainerId || activeScopedTrades.some((row) => row.tradeId === selected);

  const detail = useQuery<TradeDetail>({
    queryKey: companyQueryKey(BASE + "/linked-trades/" + selected, companyId),
    enabled: companyId > 0 && selected != null && validScopedSelection,
    queryFn: () => json(BASE + "/linked-trades/" + selected),
    retry: false,
  });
  useEffect(() => {
    if (detail.data)
      setRows(
        detail.data.lines.map((line) => ({
          lineLinkId: line.lineLinkId,
          quantity: line.quantity,
          rate: line.rate,
          itemName: line.itemName,
        }))
      );
  }, [detail.data]);
  const invoice = useQuery<InvoiceDetail>({
    queryKey: companyQueryKey(BASE + "/shared-charges/" + lookupId, companyId),
    enabled: companyId > 0 && lookupId != null,
    queryFn: () => json(BASE + "/shared-charges/" + lookupId),
    retry: false,
  });
  useEffect(() => {
    if (invoice.data) setNewAmounts(Object.fromEntries(invoice.data.allocations.map((a) => [a.tradeId, a.amount])));
  }, [invoice.data]);

  const editMutation = useMutation({
    mutationFn: async () => {
      if (!selected || !detail.data || !validScopedSelection) throw new Error("Select a verified linked container");
      const response = await apiRequest("PATCH", BASE + "/linked-trades/" + selected, {
        expectedVersion: detail.data.version,
        requestKey: key(),
        postingDate,
        reason: reason.trim(),
        lines: rows,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Both companies synchronized",
        description: "The price adjustment and accounting vouchers were posted together.",
      });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(BASE + "/linked-trades", companyId) });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(BASE + "/lifecycle", companyId) });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(BASE + "/linked-trades/" + selected, companyId) });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
    },
    onError: (e: Error) => toast({ title: "Edit refused", description: e.message, variant: "destructive" }),
  });
  const previewMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", BASE + "/shared-charges/preview", {
        sourceCompanyId: companyId,
        tradeIds: chosen,
        amount: face,
      });
      return response.json() as Promise<AllocationPreview>;
    },
    onSuccess: (data) => {
      setProposal(data);
      setManual(Object.fromEntries(data.allocations.map((a) => [a.tradeId, a.suggestedAmount])));
      toast({
        title: "Proposed allocation ready",
        description: "Review and confirm these amounts; they are not posted yet.",
      });
    },
    onError: (e: Error) => toast({ title: "Allocation not available", description: e.message, variant: "destructive" }),
  });
  const confirmMutation = useMutation({
    mutationFn: async () => {
      if (!proposal) throw new Error("Preview the allocations first");
      const allocations = proposal.allocations.map((a) => ({
        tradeId: a.tradeId,
        expectedVersion: a.expectedVersion,
        amount: manual[a.tradeId] || "0",
      }));
      const response = await apiRequest("POST", BASE + "/shared-charges/confirm", {
        sourceCompanyId: companyId,
        invoiceKey: invoiceKey.trim(),
        chargeType,
        faceAmount: face,
        evidenceReference: invoiceEvidence.trim(),
        postingDate: chargeDate,
        reason: "Confirm documented shared invoice " + invoiceKey,
        requestKey: key(),
        allocations,
      });
      return response.json() as Promise<{ invoiceId: number }>;
    },
    onSuccess: (data) => {
      setInvoiceNumber(String(data.invoiceId));
      setLookupId(data.invoiceId);
      setProposal(null);
      toast({ title: "Shared invoice confirmed", description: "Every affected linked PO was updated atomically." });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(BASE + "/linked-trades", companyId) });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(BASE + "/lifecycle", companyId) });
    },
    onError: (e: Error) => toast({ title: "Confirmation refused", description: e.message, variant: "destructive" }),
  });
  const reallocateMutation = useMutation({
    mutationFn: async () => {
      if (!invoice.data) throw new Error("Load an invoice to revise");
      const allocations = invoice.data.allocations.map((a) => ({
        tradeId: a.tradeId,
        expectedVersion: a.expectedVersion,
        amount: newAmounts[a.tradeId] ?? a.amount,
      }));
      const response = await apiRequest("PATCH", BASE + "/shared-charges/" + invoice.data.invoiceId, {
        expectedInvoiceVersion: invoice.data.version,
        postingDate: chargeDate,
        requestKey: key(),
        reason: chargeReason.trim(),
        allocations,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Confirmed allocation updated", description: "Original invoice amount was preserved." });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(BASE + "/shared-charges/" + lookupId, companyId) });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(BASE + "/linked-trades", companyId) });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(BASE + "/lifecycle", companyId) });
    },
    onError: (e: Error) => toast({ title: "Redistribution refused", description: e.message, variant: "destructive" }),
  });
  const grantMutation = useMutation({
    mutationFn: async () => {
      if (!invoice.data) throw new Error("Load an invoice first");
      const response = await apiRequest("POST", BASE + "/shared-charge-grants", {
        userId: grantee.trim(),
        relationshipId: Number(grantRelation),
        scope: grantScope,
        ...(grantScope === "invoice" ? { invoiceKey: invoice.data.externalInvoiceKey } : {}),
      });
      return response.json();
    },
    onSuccess: () => toast({ title: "Shared Charge Editor permission granted" }),
    onError: (e: Error) => toast({ title: "Permission not granted", description: e.message, variant: "destructive" }),
  });
  const trades = list.data?.trades ?? [];
  const editTrades = physicalContainerId ? activeScopedTrades : trades;
  const proposedTotal = proposal ? proposal.allocations.reduce((s, a) => s + toCents(manual[a.tradeId] || "0"), 0) : 0;
  const reallocatedTotal = invoice.data
    ? invoice.data.allocations.reduce((s, a) => s + toCents(newAmounts[a.tradeId] ?? a.amount), 0)
    : 0;
  return {
    chargeDate,
    chargeReason,
    chargeType,
    chosen,
    confirmMutation,
    copy,
    detail,
    editMutation,
    editTrades,
    embedded,
    face,
    grantMutation,
    grantRelation,
    grantScope,
    grantee,
    invoice,
    invoiceEvidence,
    invoiceKey,
    invoiceNumber,
    isProperties,
    list,
    manual,
    newAmounts,
    postingDate,
    previewMutation,
    proposal,
    proposedTotal,
    reallocateMutation,
    reallocatedTotal,
    reason,
    rows,
    selected,
    setChargeDate,
    setChargeReason,
    setChargeType,
    setChosen,
    setFace,
    setGrantRelation,
    setGrantScope,
    setGrantee,
    setInvoiceEvidence,
    setInvoiceKey,
    setInvoiceNumber,
    setLookupId,
    setManual,
    setNewAmounts,
    setPostingDate,
    setProposal,
    setReason,
    setRows,
    setSelected,
    trades,
    validScopedSelection,
  };
}
