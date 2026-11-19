// Extracted from ./SpOffloadDialog.tsx: state, queries and handlers for SpOffloadDialog.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { FRESH_START_OTW_SOURCE_NAME } from "@shared/goldenCoastOtwSource";
import type {
  ChargeLine,
  SpSetupStatus,
  SpLedgerAccount,
  SpLocationOption,
  ParentAgentOption,
} from "./spOffloadDialogTypes";
import type { SpOffloadDialogProps } from "./SpOffloadDialog";
import { spContainerInvoiceChargeLines } from "@shared/spContainerInvoiceCharges";

export function useSpOffloadDialogModel({
  open,
  onOpenChange,
  container,
  onSuccess,
}: {
  open: SpOffloadDialogProps["open"];
  onOpenChange: SpOffloadDialogProps["onOpenChange"];
  container: SpOffloadDialogProps["container"];
  onSuccess: SpOffloadDialogProps["onSuccess"];
}) {
  const { toast } = useToast();
  // Offloading posts against an existing container; read-only roles never do it.
  const recordChanges = useExistingRecordChangeAccess();
  const [offloadDate, setOffloadDate] = useState(new Date().toISOString().slice(0, 10));
  const [chargeLines, setChargeLines] = useState<ChargeLine[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [phase8RequestId, setPhase8RequestId] = useState(() => crypto.randomUUID());
  const freshStartOtw = container?.supplierName === FRESH_START_OTW_SOURCE_NAME;

  const { data: statusData } = useQuery<SpSetupStatus>({
    queryKey: ["/api/sp/setup/status"],
    enabled: open,
  });

  const { data: ledgerAccounts = [] } = useQuery<SpLedgerAccount[]>({
    queryKey: ["/api/ledger-accounts?profile=picker"],
    enabled: open,
  });

  const { data: locationsList = [] } = useQuery<SpLocationOption[]>({
    queryKey: ["/api/locations"],
    enabled: open,
  });

  const { data: parentAgents = [] } = useQuery<ParentAgentOption[]>({
    queryKey: ["/api/sp/parent-agents"],
    enabled: open,
  });

  // Declared above the `!container` guard below so the hook count stays constant.
  // `container` is a prop, so it can go from set to null (or back) while this
  // dialog is mounted; with the mutation declared after the guard that changed
  // how many hooks ran between renders, which React fails on. Nothing here reads
  // `container` during render — `mutationFn` only runs on mutate(), which is
  // unreachable while the guard is returning null.
  const offloadMutation = useMutation({
    mutationFn: () => {
      if (!recordChanges.allowed) return Promise.reject(new Error(recordChanges.reason ?? ""));
      if (!container) return Promise.reject(new Error("No container selected"));
      if (!selectedLocationId) {
        toast({ title: "Select a location", variant: "destructive" });
        return Promise.reject(new Error("Select a location"));
      }
      if (freshStartOtw) {
        const active = chargeLines.filter((charge) => Number(charge.amountUsd) > 0);
        if (active.some((charge) => charge.chargeType !== "paid_now")) {
          return Promise.reject(
            new Error(
              "Fresh Start Phase 8 supports additional charges paid from one bank account only. Invoice charges are already included in Goods OTW."
            )
          );
        }
        const distinctBanks = [...new Set(active.map((charge) => charge.creditBankAccountId))];
        if (active.length > 0 && (distinctBanks.length !== 1 || !Number(distinctBanks[0]))) {
          return Promise.reject(new Error("Select one bank account for additional offload charges."));
        }
        return apiRequest("POST", "/api/sp/golden-coast/phase8/offload", {
          clientRequestId: phase8RequestId,
          containerId: container.id,
          locationId: Number(selectedLocationId),
          offloadDate,
          charges: active.map((charge) => ({
            chargeType: "other",
            description: charge.description,
            amountUsd: charge.amountUsd,
          })),
          chargeFundingAccount: active.length > 0 ? { kind: "bank", id: Number(distinctBanks[0]) } : null,
        });
      }
      return apiRequest("POST", "/api/sp/offload", {
        containerId: container.id,
        offloadDate,
        locationId: selectedLocationId,
        chargeLines: chargeLines.filter((c) => parseFloat(c.amountUsd || "0") > 0),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sp/containers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sp/stock"] });
      toast({ title: "Offload recorded", description: "Goods OTW reversed and stock created." });
      onOpenChange(false);
      setChargeLines([]);
      setSelectedLocationId("");
      setPhase8RequestId(crypto.randomUUID());
      onSuccess?.();
    },
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  return {
    recordChanges,
    offloadDate,
    setOffloadDate,
    chargeLines,
    setChargeLines,
    selectedLocationId,
    setSelectedLocationId,
    freshStartOtw,
    statusData,
    ledgerAccounts,
    locationsList,
    parentAgents,
    offloadMutation,
  };
}

export type SpOffloadDialogModel = ReturnType<typeof useSpOffloadDialogModel>;

export function deriveSpOffloadDialogView({
  container,
  sp,
}: {
  container: NonNullable<SpOffloadDialogProps["container"]>;
  sp: SpOffloadDialogModel;
}) {
  const discountFactor = 1 - parseFloat(String(container.discountPct ?? "0")) / 100;
  const totalQty = (container.lines || []).reduce((s, l) => s + parseFloat(String(l.qty ?? "0")), 0);
  const totalBaseCost = (container.lines || []).reduce(
    (s, l) => s + parseFloat(String(l.qty ?? "0")) * parseFloat(String(l.unitRateUsd ?? "0")) * discountFactor,
    0
  );
  // Supplier-invoice charges stated on the container; the server adds them to this
  // offload itself, so they are shown here but cannot be edited or removed.
  const invoiceCharges = spContainerInvoiceChargeLines(container);
  const invoiceChargesTotal = invoiceCharges.reduce((s, c) => s + c.amountUsd, 0);
  const totalLandedCost = invoiceChargesTotal + sp.chargeLines.reduce((s, c) => s + parseFloat(c.amountUsd || "0"), 0);
  const totalFinalCost = totalBaseCost + totalLandedCost;
  const invoiceTotal = parseFloat(String(container.invoiceTotalUsd ?? "0"));

  const otwAcct = (sp.statusData?.spAccounts || []).find((a) => a.subType === "sp_goods_otw");
  const otwClrAcct = (sp.statusData?.spAccounts || []).find((a) => a.subType === "sp_otw_clearing");
  const stockAcct = (sp.statusData?.spAccounts || []).find((a) => a.subType === "sp_stock");
  const costClrAcct = (sp.statusData?.spAccounts || []).find((a) => a.subType === "sp_cost_clearing");
  const prepaidAcct = (sp.statusData?.spAccounts || []).find((a) => a.subType === "sp_prepaid");
  const prepaidExpAcct = (sp.statusData?.spAccounts || []).find((a) => a.subType === "sp_prepaid_expenses");
  const hadiIcAcct = (sp.statusData?.spAccounts || []).find((a) => a.subType === "sp_hadi_intercompany");

  const activeCharges = sp.chargeLines.filter((c) => parseFloat(c.amountUsd || "0") > 0);
  const agentCharges = activeCharges.filter((c) => c.chargeType === "parent_agent");
  const totalAgentCharges = agentCharges.reduce((s, c) => s + parseFloat(c.amountUsd || "0"), 0);

  const addCharge = () =>
    sp.setChargeLines((prev) => [
      ...prev,
      {
        chargeType: "paid_now",
        description: "",
        amountUsd: "",
        prepaidChargeId: "",
        creditBankAccountId: "",
        creditLedgerAccountId: "",
        parentAgentAccountId: "",
      },
    ]);

  const removeCharge = (idx: number) => sp.setChargeLines((prev) => prev.filter((_, i) => i !== idx));

  const updateCharge = (idx: number, key: keyof ChargeLine, value: string) =>
    sp.setChargeLines((prev) => prev.map((c, i) => (i === idx ? { ...c, [key]: value } : c)));

  return {
    totalQty,
    totalBaseCost,
    invoiceCharges,
    totalLandedCost,
    totalFinalCost,
    invoiceTotal,
    otwAcct,
    otwClrAcct,
    stockAcct,
    costClrAcct,
    prepaidAcct,
    prepaidExpAcct,
    hadiIcAcct,
    activeCharges,
    agentCharges,
    totalAgentCharges,
    addCharge,
    removeCharge,
    updateCharge,
  };
}

export type SpOffloadDialogView = ReturnType<typeof deriveSpOffloadDialogView>;
