// Extracted from ./OffloadDialog.tsx: state, queries and handlers for OffloadDialog.
import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import type { Location } from "@shared/schema";
import { useCompany } from "@/contexts/CompanyContext";
import type {
  AdditionalCharge,
  LedgerAccountOption,
  SpSetupStatusData,
  ParentAgentOption,
  ContainerOffloadData,
} from "./offloadDialogTypes";
import type { OffloadDialogProps } from "./OffloadDialog";

export function useOffloadDialogModel({
  open,
  onOpenChange,
  containerId,
  containerNumber,
  totalBales,
}: {
  open: OffloadDialogProps["open"];
  onOpenChange: OffloadDialogProps["onOpenChange"];
  containerId: OffloadDialogProps["containerId"];
  containerNumber: OffloadDialogProps["containerNumber"];
  totalBales: OffloadDialogProps["totalBales"];
}) {
  // Offloading posts against an existing container; read-only roles never do it.
  const recordChanges = useExistingRecordChangeAccess();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const isSpCompany = selectedCompany?.companyType === "supplier_partner";

  // ── Shared state ──────────────────────────────────────────────────────────
  const [locationId, setLocationId] = useState<number | null>(null);
  const [offloadDate, setOffloadDate] = useState(new Date().toLocaleDateString("en-CA"));

  // ── ERP-only state ────────────────────────────────────────────────────────
  const [duties, setDuties] = useState("0");
  const [dutiesAccountId, setDutiesAccountId] = useState("");
  const [transportFees, setTransportFees] = useState("0");
  const [transportAccountId, setTransportAccountId] = useState("");
  const [additionalCharges, setAdditionalCharges] = useState<AdditionalCharge[]>([]);

  // ── SP-mode state ─────────────────────────────────────────────────────────
  const [spDutiesAmount, setSpDutiesAmount] = useState("");
  const [spDutiesMethod, setSpDutiesMethod] = useState<"prepaid_expenses" | "parent_agent">("prepaid_expenses");
  const [spDutiesAgentId, setSpDutiesAgentId] = useState("");
  const [spTransportAmount, setSpTransportAmount] = useState("");
  const [spTransportMethod, setSpTransportMethod] = useState<"prepaid_expenses" | "parent_agent">("prepaid_expenses");
  const [spTransportAgentId, setSpTransportAgentId] = useState("");

  // Reset all form state whenever the dialog opens or targets a new container
  useEffect(() => {
    if (!open) return;
    setLocationId(null);
    setOffloadDate(new Date().toLocaleDateString("en-CA"));
    // ERP fields
    setDuties("0");
    setDutiesAccountId("");
    setTransportFees("0");
    setTransportAccountId("");
    setAdditionalCharges([]);
    // SP fields
    setSpDutiesAmount("");
    setSpDutiesMethod("prepaid_expenses");
    setSpDutiesAgentId("");
    setSpTransportAmount("");
    setSpTransportMethod("prepaid_expenses");
    setSpTransportAgentId("");
  }, [open, containerId]);

  // ── Queries ───────────────────────────────────────────────────────────────
  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const { data: ledgerAccounts = [] } = useQuery<LedgerAccountOption[]>({
    queryKey: ["/api/ledger-accounts?profile=picker"],
    enabled: open && !isSpCompany,
  });

  const { data: spStatusData } = useQuery<SpSetupStatusData>({
    queryKey: ["/api/sp/setup/status"],
    enabled: open && isSpCompany,
  });

  const { data: parentAgents = [] } = useQuery<ParentAgentOption[]>({
    queryKey: ["/api/sp/parent-agents"],
    enabled: open && isSpCompany,
  });

  const { data: containerData } = useQuery<ContainerOffloadData>({
    queryKey: [`/api/containers/${containerId}`],
    enabled: open && !!containerId,
  });

  // ── Derived SP accounts ───────────────────────────────────────────────────
  const spPrepaidExpAcct = (spStatusData?.spAccounts || []).find(
    (a: { subType: string }) => a.subType === "sp_prepaid_expenses"
  );
  const spHadiIcAcct = (spStatusData?.spAccounts || []).find(
    (a: { subType: string }) => a.subType === "sp_hadi_intercompany"
  );

  // ── Charge calculations ───────────────────────────────────────────────────
  let poChargesTotal = 0;
  if (containerData?.charges && Array.isArray(containerData.charges)) {
    containerData.charges.forEach((charge) => {
      const amount = parseFloat(String(charge.amount ?? "0"));
      if (amount > 0) poChargesTotal += amount;
    });
  }

  const erpManualCharges =
    parseFloat(duties || "0") +
    parseFloat(transportFees || "0") +
    additionalCharges.reduce((sum, charge) => sum + parseFloat(String(charge.amount ?? "0")), 0);

  const spManualCharges = parseFloat(spDutiesAmount || "0") + parseFloat(spTransportAmount || "0");

  const manualCharges = isSpCompany ? spManualCharges : erpManualCharges;
  const totalCharges = manualCharges + poChargesTotal;
  const additionalCostPerBale = totalBales > 0 ? totalCharges / totalBales : 0;

  // ── ERP handlers ──────────────────────────────────────────────────────────
  const handleAddCharge = () => {
    setAdditionalCharges([
      ...additionalCharges,
      { id: Date.now().toString(), description: "", amount: "0", ledgerAccountId: "" },
    ]);
  };

  const handleRemoveCharge = (id: string) => {
    setAdditionalCharges(additionalCharges.filter((c) => c.id !== id));
  };

  const handleUpdateCharge = (id: string, field: keyof AdditionalCharge, value: string) => {
    setAdditionalCharges(additionalCharges.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  };

  // ── Mutation ──────────────────────────────────────────────────────────────
  const offloadMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      if (!locationId) throw new Error("Please select a location");

      if (isSpCompany) {
        const dutiesAmt = parseFloat(spDutiesAmount || "0");
        const transportAmt = parseFloat(spTransportAmount || "0");

        if (dutiesAmt > 0 && spDutiesMethod === "parent_agent" && !spDutiesAgentId) {
          throw new Error("Please select an agent for duties");
        }
        if (transportAmt > 0 && spTransportMethod === "parent_agent" && !spTransportAgentId) {
          throw new Error("Please select an agent for transport");
        }
        if (!spPrepaidExpAcct) throw new Error("SP Prepaid Expenses account not found. Run SP Setup first.");
        if (!spHadiIcAcct) throw new Error("SP Intercompany account not found. Run SP Setup first.");

        const resolvedDutiesAccountId =
          dutiesAmt > 0 ? (spDutiesMethod === "prepaid_expenses" ? spPrepaidExpAcct.id : spHadiIcAcct.id) : null;
        const resolvedTransportAccountId =
          transportAmt > 0 ? (spTransportMethod === "prepaid_expenses" ? spPrepaidExpAcct.id : spHadiIcAcct.id) : null;

        const agentChargeLines = [];
        if (dutiesAmt > 0 && spDutiesMethod === "parent_agent") {
          agentChargeLines.push({
            description: "Duties",
            amountUsd: dutiesAmt,
            parentAgentAccountId: parseInt(spDutiesAgentId),
          });
        }
        if (transportAmt > 0 && spTransportMethod === "parent_agent") {
          agentChargeLines.push({
            description: "Transport",
            amountUsd: transportAmt,
            parentAgentAccountId: parseInt(spTransportAgentId),
          });
        }

        const response = await factoryApiRequest("POST", `/api/containers/${containerId}/offload`, {
          locationId,
          offloadDate,
          duties: String(dutiesAmt),
          dutiesAccountId: resolvedDutiesAccountId,
          officeCharges: "0",
          officeChargesAccountId: null,
          officeChargesCashAccountId: null,
          transferCharges: "0",
          transportFees: String(transportAmt),
          transportAccountId: resolvedTransportAccountId,
          additionalCharges: [],
          inventoryCostCorrections: [],
          agentChargeLines,
        });
        return await response.json();
      } else {
        if (parseFloat(duties) > 0 && !dutiesAccountId) {
          throw new Error("Please select an account for duties");
        }
        if (parseFloat(transportFees) > 0 && !transportAccountId) {
          throw new Error("Please select an account for transport fees");
        }
        for (const charge of additionalCharges) {
          if (parseFloat(charge.amount) > 0) {
            if (!charge.description) throw new Error("Please provide a description for all additional charges");
            if (!charge.ledgerAccountId) throw new Error("Please select an account for all additional charges");
          }
        }

        const response = await factoryApiRequest("POST", `/api/containers/${containerId}/offload`, {
          locationId,
          offloadDate,
          duties,
          dutiesAccountId: dutiesAccountId ? parseInt(dutiesAccountId) : null,
          officeCharges: "0",
          officeChargesAccountId: null,
          officeChargesCashAccountId: null,
          transferCharges: "0",
          transportFees,
          transportAccountId: transportAccountId ? parseInt(transportAccountId) : null,
          additionalCharges: additionalCharges
            .filter((c) => parseFloat(c.amount) > 0)
            .map((c) => ({
              description: c.description,
              amount: parseFloat(c.amount),
              ledgerAccountId: parseInt(c.ledgerAccountId),
            })),
          inventoryCostCorrections: [],
          agentChargeLines: [],
        });
        return await response.json();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/containers"] });
      queryClient.invalidateQueries({ queryKey: [`/api/containers/${containerId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          return typeof key === "string" && key.startsWith("/api/stock-items/");
        },
      });
      queryClient.invalidateQueries({ queryKey: ["/api/stats/net-profit"] });
      toast({
        title: "Container offloaded successfully",
        description: `Container ${containerNumber} has been offloaded to the selected location.`,
      });
      onOpenChange(false);
      setLocation("/containers");
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Offload failed", description: error.message, variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!recordChanges.allowed) return;
    offloadMutation.mutate();
  };

  return {
    recordChanges,
    isSpCompany,
    locationId,
    setLocationId,
    offloadDate,
    setOffloadDate,
    duties,
    setDuties,
    dutiesAccountId,
    setDutiesAccountId,
    transportFees,
    setTransportFees,
    transportAccountId,
    setTransportAccountId,
    additionalCharges,
    spDutiesAmount,
    setSpDutiesAmount,
    spDutiesMethod,
    setSpDutiesMethod,
    spDutiesAgentId,
    setSpDutiesAgentId,
    spTransportAmount,
    setSpTransportAmount,
    spTransportMethod,
    setSpTransportMethod,
    spTransportAgentId,
    setSpTransportAgentId,
    locations,
    ledgerAccounts,
    parentAgents,
    spPrepaidExpAcct,
    poChargesTotal,
    manualCharges,
    totalCharges,
    additionalCostPerBale,
    handleAddCharge,
    handleRemoveCharge,
    handleUpdateCharge,
    offloadMutation,
    handleSubmit,
  };
}

export type OffloadDialogModel = ReturnType<typeof useOffloadDialogModel>;
