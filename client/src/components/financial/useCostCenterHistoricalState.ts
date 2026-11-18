// Extracted from ./CostCenterHistorical.tsx to keep that module under the source-size cap.
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Decimal from "decimal.js";
import { useCompany } from "@/contexts/CompanyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { type CostCenter, readCostCenterApi, writeCostCenterApi } from "@/api/costCentersApi";
import {
  MAX_BATCH,
  amountPattern,
  dateToday,
  err,
  startDate,
  type Account,
  type Batch,
  type Kind,
  type Preview,
  type Reconciliation,
  type Split,
} from "./CostCenterHistoricalTypes";

export function useCostCenterHistoricalState({ baseUrl, centers }: { baseUrl: string; centers: CostCenter[] }) {
  const { selectedCompany } = useCompany();
  const isFactory = useAppMode() === "factory";
  const { toast } = useToast();
  const companyId = selectedCompany?.id;
  const canWrite = ["Admin", "Owner", "Developer"].includes(selectedCompany?.role || "");
  const [kind, setKind] = useState<Kind>("VOUCHER_ENTRY");
  const [from, setFrom] = useState(startDate);
  const [to, setTo] = useState(dateToday);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [limit, setLimit] = useState(String(MAX_BATCH));
  const [splits, setSplits] = useState<Split[]>([{ costCenterId: "", percent: "100" }]);
  const [reason, setReason] = useState("Historical expense cost center assignment");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [applied, setApplied] = useState<{ sourceCount: number; allocatedUsdTotal: string } | null>(null);
  const [showBatchHistory, setShowBatchHistory] = useState(false);
  const validWindow = from.length === 10 && to.length === 10 && from <= to;
  const queryString = useMemo(() => {
    const q = new URLSearchParams({ sourceKind: kind, fromDate: from, toDate: to });
    if (kind === "VOUCHER_ENTRY" && selectedAccounts.length) q.set("ledgerAccountIds", selectedAccounts.join(","));
    return q.toString();
  }, [kind, from, to, selectedAccounts]);
  const { data: accounts } = useQuery<{ accounts: Account[] }>({
    queryKey: [baseUrl, companyId, "automation", "accounts"],
    queryFn: () => readCostCenterApi(baseUrl + "/automation/accounts"),
    enabled: !!companyId,
  });
  const {
    data: reconciliation,
    isLoading: reconLoading,
    isError: reconError,
    error: reconErrorText,
    refetch: refreshRecon,
  } = useQuery<Reconciliation>({
    queryKey: [baseUrl, companyId, "historical", "reconciliation", queryString],
    queryFn: () => readCostCenterApi<Reconciliation>(baseUrl + "/historical/reconciliation?" + queryString),
    enabled: !!companyId && validWindow,
    staleTime: 30000,
  });
  const { data: history, refetch: refreshHistory } = useQuery<{ batches: Batch[] }>({
    queryKey: [baseUrl, companyId, "historical", "batches"],
    queryFn: () => readCostCenterApi<{ batches: Batch[] }>(baseUrl + "/historical/batches"),
    enabled: !!companyId && showBatchHistory,
  });
  const pctTotal = useMemo(() => {
    try {
      return splits.reduce((acc, s) => acc.plus(new Decimal(s.percent || 0)), new Decimal(0));
    } catch {
      return new Decimal(-1);
    }
  }, [splits]);
  const validSplits =
    splits.length > 0 &&
    splits.length <= 10 &&
    splits.every(
      (s) =>
        s.costCenterId &&
        amountPattern.test(s.percent) &&
        new Decimal(s.percent).gt(0) &&
        centers.some((c) => c.active && String(c.id) === s.costCenterId)
    ) &&
    new Set(splits.map((s) => s.costCenterId)).size === splits.length &&
    pctTotal.gt(0) &&
    pctTotal.lte(100);
  const valid =
    canWrite &&
    validWindow &&
    validSplits &&
    Number.isInteger(Number(limit)) &&
    Number(limit) > 0 &&
    Number(limit) <= MAX_BATCH &&
    reason.trim().length >= 5 &&
    reason.trim().length <= 500;
  function invalidatePreview() {
    setPreview(null);
    setConfirmation("");
    setApplied(null);
  }
  function changeSplit(index: number, patch: Partial<Split>) {
    invalidatePreview();
    setSplits((old) => old.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }
  const previewWrite = useMutation({
    mutationFn: () =>
      writeCostCenterApi<Preview>("POST", baseUrl + "/historical/preview", {
        sourceKind: kind,
        fromDate: from,
        toDate: to,
        ledgerAccountIds: kind === "VOUCHER_ENTRY" && selectedAccounts.length ? selectedAccounts.map(Number) : null,
        limit: Number(limit),
        reason: reason.trim(),
        splits: splits.map((s) => ({
          costCenterId: Number(s.costCenterId),
          percent: new Decimal(s.percent).toFixed(4),
        })),
      }),
    onSuccess: (result) => {
      setPreview(result);
      setConfirmation("");
      setApplied(null);
      toast({
        title: "Dry-run preview saved",
        description: "No original vouchers or cost-center allocations were changed.",
      });
      void refreshHistory();
    },
    onError: (error) => toast({ title: "Preview unavailable", description: err(error), variant: "destructive" }),
  });
  const applyWrite = useMutation({
    mutationFn: () => {
      if (!preview) throw new Error("Create a new dry-run preview first");
      return writeCostCenterApi<{ sourceCount: number; allocatedUsdTotal: string }>(
        "POST",
        baseUrl + "/historical/" + preview.batchId + "/apply",
        { confirmation: "APPLY" }
      );
    },
    onSuccess: async (result) => {
      setApplied(result);
      setPreview(null);
      setConfirmation("");
      await queryClient.invalidateQueries({ queryKey: [baseUrl, companyId] });
      toast({
        title: "Historical allocation applied",
        description:
          "Analytical tags added. The original vouchers, inventory values and account balances are unchanged.",
      });
      void refreshRecon();
      void refreshHistory();
    },
    onError: (e) => {
      setConfirmation("");
      toast({ title: "Batch rejected — nothing applied", description: err(e), variant: "destructive" });
    },
  });
  const samePreview = !!preview && !previewWrite.isPending && !applyWrite.isPending;
  return {
    accounts,
    applied,
    applyWrite,
    canWrite,
    centers,
    changeSplit,
    confirmation,
    from,
    history,
    invalidatePreview,
    isFactory,
    kind,
    limit,
    pctTotal,
    preview,
    previewWrite,
    reason,
    reconError,
    reconErrorText,
    reconLoading,
    reconciliation,
    refreshHistory,
    refreshRecon,
    samePreview,
    selectedAccounts,
    setConfirmation,
    setFrom,
    setKind,
    setLimit,
    setPreview,
    setReason,
    setSelectedAccounts,
    setShowBatchHistory,
    setSplits,
    setTo,
    showBatchHistory,
    splits,
    to,
    valid,
  };
}
