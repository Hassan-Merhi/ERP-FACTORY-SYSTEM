import { visibleTabInterval } from "@/lib/queryPolicies";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

import type { CardKey, NetPositionData, PinnedRow, SnapshotData } from "./types";

function getFinancialSnapshotErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "An unexpected error occurred";
}

export function useFactoryFinancialSnapshotModel() {
  const { toast } = useToast();

  const [cashBankExpanded, setCashBankExpanded] = useState(false);
  const [agentExpanded, setAgentExpanded] = useState(false);
  const [freightExpanded, setFreightExpanded] = useState(false);
  const [supplierExpanded, setSupplierExpanded] = useState(false);
  const [customerExpanded, setCustomerExpanded] = useState(false);
  const [advanceExpanded, setAdvanceExpanded] = useState(false);

  const [pickerFor, setPickerFor] = useState<CardKey | null>(null);
  const [pickerSearch, setPickerSearch] = useState("");

  const {
    data: snapshot,
    isLoading: loadingSnapshot,
    isFetching: fetchingSnapshot,
    refetch: refetchSnapshot,
    dataUpdatedAt: snapUpdated,
  } = useQuery<SnapshotData>({
    queryKey: ["/api/factory/financial-snapshot"],
    placeholderData: (prev) => prev,
    refetchInterval: visibleTabInterval(5 * 60_000),
  });

  const {
    data: netPosition,
    isLoading: loadingNP,
    isFetching: fetchingNP,
    refetch: refetchNP,
  } = useQuery<NetPositionData>({
    queryKey: ["/api/factory/net-position"],
    placeholderData: (prev) => prev,
    refetchInterval: visibleTabInterval(5 * 60_000),
  });

  const {
    data: agentAccounts,
    isLoading: loadingAgents,
    isFetching: fetchingAgents,
    refetch: refetchAgents,
  } = useQuery<PinnedRow[]>({
    queryKey: ["/api/agent-accounts"],
    placeholderData: (prev) => prev,
    refetchInterval: visibleTabInterval(5 * 60_000),
  });

  const { data: freightAccountRows, isLoading: loadingFreight } = useQuery<PinnedRow[]>({
    queryKey: ["/api/freight-accounts"],
    placeholderData: (prev) => prev,
  });

  const { data: cashbankPinned, isLoading: loadingCashbank } = useQuery<PinnedRow[]>({
    queryKey: ["/api/snapshot-pinned-accounts/cashbank"],
    placeholderData: (prev) => prev,
  });

  const { data: advancePinned, isLoading: loadingAdvancePinned } = useQuery<PinnedRow[]>({
    queryKey: ["/api/snapshot-pinned-accounts/advance"],
    placeholderData: (prev) => prev,
  });

  const addAccountMutation = useMutation({
    mutationFn: ({
      type,
      body,
    }: {
      type: CardKey;
      body: { accountId: string; accountType: string; accountName: string };
    }) => {
      if (type === "agent") return apiRequest("POST", "/api/agent-accounts", body);
      if (type === "freight") return apiRequest("POST", "/api/freight-accounts", body);
      return apiRequest("POST", `/api/snapshot-pinned-accounts/${type}`, body);
    },
    onSuccess: (_data, { type }) => {
      if (type === "agent") queryClient.invalidateQueries({ queryKey: ["/api/agent-accounts"] });
      else if (type === "freight") queryClient.invalidateQueries({ queryKey: ["/api/freight-accounts"] });
      else queryClient.invalidateQueries({ queryKey: [`/api/snapshot-pinned-accounts/${type as string}`] });
    },
    onError: (err: unknown) =>
      toast({ title: "Error", description: getFinancialSnapshotErrorMessage(err), variant: "destructive" }),
  });

  const removeAccountMutation = useMutation({
    mutationFn: ({ type, accountId }: { type: CardKey; accountId: string }) => {
      if (type === "agent") return apiRequest("DELETE", `/api/agent-accounts/${encodeURIComponent(accountId)}`);
      if (type === "freight") return apiRequest("DELETE", `/api/freight-accounts/${encodeURIComponent(accountId)}`);
      return apiRequest("DELETE", `/api/snapshot-pinned-accounts/${type}/${encodeURIComponent(accountId)}`);
    },
    onSuccess: (_data, { type }) => {
      if (type === "agent") queryClient.invalidateQueries({ queryKey: ["/api/agent-accounts"] });
      else if (type === "freight") queryClient.invalidateQueries({ queryKey: ["/api/freight-accounts"] });
      else queryClient.invalidateQueries({ queryKey: [`/api/snapshot-pinned-accounts/${type as string}`] });
    },
    onError: (err: unknown) =>
      toast({ title: "Error", description: getFinancialSnapshotErrorMessage(err), variant: "destructive" }),
  });

  // True only on first load (no cached data yet) — triggers full skeleton screen
  const isLoading =
    loadingSnapshot || loadingNP || loadingAgents || loadingFreight || loadingCashbank || loadingAdvancePinned;
  // True whenever any background refetch is in flight — used only for the button spinner
  const isFetching = fetchingSnapshot || fetchingNP || fetchingAgents;

  const handleRefresh = () => {
    refetchSnapshot();
    refetchNP();
    refetchAgents();
  };

  const lastUpdated = snapUpdated ? new Date(snapUpdated).toLocaleTimeString() : null;

  const computed = useMemo(() => {
    if (!netPosition || !agentAccounts) return null;

    const allAccounts = [
      ...(netPosition.forUs?.accounts || []).map((a) => ({ ...a, side: "forUs" as const })),
      ...(netPosition.onUs?.accounts || []).map((a) => ({ ...a, side: "onUs" as const })),
    ];

    const signedValue = (a: { value: number; side: "forUs" | "onUs" }) => (a.side === "forUs" ? a.value : -a.value);

    // ── Mix Batches on Tables — from net position "Balance on Table" top-level field ──
    const mixBatchValue = netPosition.balanceOnTableValue ?? 0;

    // ── Raw Material Value — from net position "Factory Raw Material Stock" top-level field ──
    const rawMaterialValue = netPosition.rawMaterialValue ?? 0;

    // ── Supplier Balances (auto: all suppliers from net position) ──
    const supplierAccounts = (netPosition.onUs?.accounts || []).filter((a) => a.category === "Supplier");
    const overpaidSupplierAccounts = (netPosition.forUs?.accounts || []).filter(
      (a) => a.category === "Supplier Overpayments"
    );
    const supplierNet = netPosition.supplierLiabilities ?? 0;
    const supplierList = [
      ...supplierAccounts.map((a) => ({ name: a.name, value: a.value, breakdown: a.breakdown, overpaid: false })),
      ...overpaidSupplierAccounts.map((a) => ({
        name: a.name,
        value: -a.value,
        breakdown: a.breakdown,
        overpaid: true,
      })),
    ].sort((x, y) => Math.abs(y.value) - Math.abs(x.value));

    // ── Customer Credit (auto: all Dr customers from net position) ──
    const customerAccounts = (netPosition.forUs?.accounts || []).filter((a) => a.category === "Customer");
    const customerNet = customerAccounts.reduce((sum, a) => sum + a.value, 0);
    const customerList = customerAccounts
      .map((a) => ({ name: a.name, value: a.value }))
      .sort((x, y) => y.value - x.value);

    // ── Agent Accounts ──
    const agentNames = new Set(agentAccounts.map((a) => a.accountName.toLowerCase().trim()));
    const agentIds = new Set(
      agentAccounts
        .map((a) => {
          const parts = a.accountId.split("-");
          return parseInt(parts[parts.length - 1] || "0");
        })
        .filter(Boolean)
    );
    const agentAccountItems = allAccounts.filter(
      (a) => agentNames.has(a.name.toLowerCase().trim()) || agentIds.has(Number(a.id))
    );
    const agentNet = agentAccountItems.reduce((sum, a) => sum + signedValue(a), 0);
    const agentList = agentAccountItems
      .map((a) => ({
        id: a.id as number,
        compositeId: `ledger-${a.id}`,
        name: a.name,
        code: a.code,
        signedBalance: signedValue(a),
      }))
      .sort((x, y) => Math.abs(y.signedBalance) - Math.abs(x.signedBalance));

    // ── Freight Accounts ──
    const freightIds = new Set(
      (freightAccountRows || [])
        .map((a) => {
          const parts = a.accountId.split("-");
          return parseInt(parts[parts.length - 1] || "0");
        })
        .filter(Boolean)
    );
    const freightNames = new Set((freightAccountRows || []).map((a) => a.accountName.toLowerCase().trim()));
    const freightAccountItems =
      freightAccountRows && freightAccountRows.length > 0
        ? allAccounts.filter((a) => freightNames.has(a.name.toLowerCase().trim()) || freightIds.has(Number(a.id)))
        : [];
    const freightNet = freightAccountItems.reduce((sum, a) => sum + signedValue(a), 0);
    const freightList = freightAccountItems
      .map((a) => ({
        id: a.id as number,
        compositeId: `ledger-${a.id}`,
        name: a.name,
        code: a.code,
        signedBalance: signedValue(a),
      }))
      .sort((x, y) => Math.abs(y.signedBalance) - Math.abs(x.signedBalance));

    // ── Cash & Bank (manual pinned) ──
    const cashbankIds = new Set(
      (cashbankPinned || [])
        .map((a) => {
          const parts = a.accountId.split("-");
          return parseInt(parts[parts.length - 1] || "0");
        })
        .filter(Boolean)
    );
    const cashbankNames = new Set((cashbankPinned || []).map((a) => a.accountName.toLowerCase().trim()));
    const cashBankItems =
      cashbankPinned && cashbankPinned.length > 0
        ? allAccounts.filter((a) => cashbankNames.has(a.name.toLowerCase().trim()) || cashbankIds.has(Number(a.id)))
        : [];
    const cashBankTotal = cashBankItems.reduce((sum, a) => sum + signedValue(a), 0);
    const cashBankList = cashBankItems
      .map((a) => ({
        id: a.id as number,
        compositeId: `ledger-${a.id}`,
        name: a.name,
        code: a.code,
        signedBalance: signedValue(a),
      }))
      .sort((x, y) => Math.abs(y.signedBalance) - Math.abs(x.signedBalance));

    // ── Worker Advances (pinned) ──
    const buildPinnedList = (pinned: PinnedRow[] | undefined) => {
      if (!pinned || pinned.length === 0) return { items: [], net: 0, list: [] };
      const pinnedIds = new Set(
        pinned
          .map((p) => {
            const parts = p.accountId.split("-");
            return parseInt(parts[parts.length - 1] || "0");
          })
          .filter(Boolean)
      );
      const pinnedNames = new Set(pinned.map((p) => p.accountName.toLowerCase().trim()));
      const items = allAccounts.filter(
        (a) => pinnedNames.has(a.name.toLowerCase().trim()) || pinnedIds.has(Number(a.id))
      );
      const net = items.reduce((sum, a) => sum + signedValue(a), 0);
      const list = items
        .map((a) => ({
          id: a.id as number,
          compositeId: `ledger-${a.id}`,
          name: a.name,
          code: a.code,
          signedBalance: signedValue(a),
        }))
        .sort((x, y) => Math.abs(y.signedBalance) - Math.abs(x.signedBalance));
      return { items, net, list };
    };
    const advanceData = buildPinnedList(advancePinned);

    return {
      rawMaterialValue,
      mixBatchValue,
      supplierNet,
      supplierCount: supplierList.length,
      supplierList,
      customerNet,
      customerCount: customerList.length,
      customerList,
      cashBankTotal,
      cashBankCount: cashBankItems.length,
      cashBankList,
      freightNet,
      freightCount: freightAccountItems.length,
      freightList,
      agentNet,
      agentCount: agentAccountItems.length,
      agentList,
      advanceNet: advanceData.net,
      advanceCount: advanceData.items.length,
      advanceList: advanceData.list,
      allAccounts,
    };
  }, [netPosition, agentAccounts, freightAccountRows, cashbankPinned, advancePinned]);

  const allLoading = isLoading || !computed;

  // ── Account picker helpers ──
  const pinnedRowsForCard: PinnedRow[] =
    pickerFor === "agent"
      ? agentAccounts || []
      : pickerFor === "freight"
        ? freightAccountRows || []
        : pickerFor === "cashbank"
          ? cashbankPinned || []
          : pickerFor === "advance"
            ? advancePinned || []
            : [];

  const pickerSelectedIds = new Set(pinnedRowsForCard.map((a) => a.accountId));
  const pickerAccounts = (computed?.allAccounts || [])
    .filter((a) => {
      const compositeId = `ledger-${a.id}`;
      if (pickerSelectedIds.has(compositeId)) return false;
      if (!pickerSearch.trim()) return true;
      return (
        a.name.toLowerCase().includes(pickerSearch.toLowerCase()) ||
        (a.code || "").toLowerCase().includes(pickerSearch.toLowerCase())
      );
    })
    .slice(0, 80);

  const cardLabel =
    pickerFor === "agent"
      ? "Agent"
      : pickerFor === "freight"
        ? "Freight / Embassy"
        : pickerFor === "cashbank"
          ? "Cash & Bank"
          : pickerFor === "advance"
            ? "Advance"
            : "";

  return {
    addAccountMutation,
    advanceExpanded,
    allLoading,
    cardLabel,
    cashBankExpanded,
    computed,
    customerExpanded,
    freightExpanded,
    handleRefresh,
    isFetching,
    isLoading,
    lastUpdated,
    loadingSnapshot,
    netPosition,
    pickerAccounts,
    pickerFor,
    pickerSearch,
    removeAccountMutation,
    setAdvanceExpanded,
    setAgentExpanded,
    setCashBankExpanded,
    setCustomerExpanded,
    setFreightExpanded,
    setPickerFor,
    setPickerSearch,
    setSupplierExpanded,
    snapshot,
    supplierExpanded,
    agentExpanded,
  };
}
