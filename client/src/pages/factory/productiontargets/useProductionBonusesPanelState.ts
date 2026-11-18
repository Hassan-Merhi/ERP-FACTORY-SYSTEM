// Extracted from ./ProductionBonusesPanel.tsx to keep that module under the source-size cap.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import {
  EMPTY_BONUS_ROWS,
  api,
  rowKey,
  type BonusResponse,
  type BonusRow,
  type Decision,
  type Status,
} from "./ProductionBonusesPanelTypes";

export function useProductionBonusesPanelState({ initialDate }: { initialDate: string }) {
  const { toast } = useToast();
  const [start, setStart] = useState(initialDate);
  const [end, setEnd] = useState(initialDate);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | Status | "eligible">("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmDecision, setConfirmDecision] = useState<Decision | null>(null);
  const [rateWorker, setRateWorker] = useState<BonusRow | null>(null);
  const [rateInput, setRateInput] = useState("");
  const [rateDate, setRateDate] = useState(initialDate);

  useEffect(() => {
    setStart(initialDate);
    setEnd(initialDate);
    setSelected([]);
  }, [initialDate]);

  const rangeValid = Boolean(start && end && start <= end) && (Date.parse(end) - Date.parse(start)) / 86400000 <= 31;
  const { data, isLoading, error } = useQuery<BonusResponse>({
    queryKey: ["/api/factory/staff-tracking/production-bonuses", start, end],
    queryFn: () =>
      api<BonusResponse>(
        "GET",
        "/api/factory/staff-tracking/production-bonuses?" + new URLSearchParams({ start, end }).toString()
      ),
    enabled: rangeValid,
    // Open production continues changing while scanning; refresh previews
    // without changing any already approved, immutable bonus amounts.
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  const rows = data?.rows ?? EMPTY_BONUS_ROWS;
  const visible = useMemo(
    () =>
      rows.filter((row) => {
        const needle = search.trim().toLocaleLowerCase();
        const matchesName =
          !needle ||
          row.workerName.toLocaleLowerCase().includes(needle) ||
          row.category.toLocaleLowerCase().includes(needle) ||
          row.date.includes(needle);
        if (!matchesName) return false;
        if (filter === "eligible")
          return row.status === "pending" && row.extraBales > 0 && row.targetConfigured !== false;
        return filter === "all" || row.status === filter;
      }),
    [rows, search, filter]
  );
  const eligible = visible.filter(
    (row) => row.status === "pending" && row.extraBales > 0 && row.targetConfigured !== false
  );
  const selectedRows = rows.filter(
    (row) =>
      selected.includes(rowKey(row)) && row.status === "pending" && row.extraBales > 0 && row.targetConfigured !== false
  );
  const allVisibleSelected = eligible.length > 0 && eligible.every((row) => selected.includes(rowKey(row)));

  // Weekly/date-range worker totals combine historically linked and unlinked
  // days without counting the displayed linked-team production twice.
  const workerBreakdown = useMemo(() => {
    const grouped = new Map<
      number,
      {
        workerId: number;
        name: string;
        target: number;
        produced: number;
        extra: number;
        pending: number;
        approved: number;
      }
    >();
    for (const row of rows) {
      const current = grouped.get(row.workerId) ?? {
        workerId: row.workerId,
        name: row.workerName,
        target: 0,
        produced: 0,
        extra: 0,
        pending: 0,
        approved: 0,
      };
      current.target += row.targetBales;
      current.produced += row.producedBales;
      current.extra += row.extraBales;
      if (row.status === "pending") current.pending += row.proposedAmount;
      if (row.status === "approved") current.approved += row.lockedAmount ?? 0;
      grouped.set(row.workerId, current);
    }
    return [...grouped.values()].sort((a, b) => b.extra - a.extra || a.name.localeCompare(b.name));
  }, [rows]);

  const reviewMutation = useMutation({
    mutationFn: async (decision: Decision) =>
      api<{ saved: number; unchanged: number }>("POST", "/api/factory/staff-tracking/production-bonuses/decide", {
        decisions: selectedRows.map((row) => ({
          date: row.date,
          workerId: row.workerId,
          decision,
          expectedAmount: row.proposedAmount,
          expectedProducedBales: row.producedBales,
          expectedTargetBales: row.targetBales,
        })),
      }),
    onSuccess: ({ saved, unchanged }) => {
      toast({
        title: "Production bonus decisions saved",
        description: `${saved} reviewed, ${unchanged} already decided.`,
      });
      setSelected([]);
      setConfirmDecision(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/staff-tracking/production-bonuses"] });
    },
    onError: (err: Error) => {
      setConfirmDecision(null);
      toast({ title: "Could not save decisions", description: err.message, variant: "destructive" });
    },
  });

  const rateMutation = useMutation({
    mutationFn: () =>
      api("POST", "/api/factory/staff-tracking/production-bonuses/rate", {
        workerId: rateWorker!.workerId,
        effectiveFrom: rateDate,
        ratePerBale: rateInput,
      }),
    onSuccess: () => {
      toast({ title: "Worker bonus rate saved" });
      setRateWorker(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/staff-tracking/production-bonuses"] });
    },
    onError: (err: Error) => toast({ title: "Rate not saved", description: err.message, variant: "destructive" }),
  });
  const canApproveSelected =
    selectedRows.length > 0 &&
    selectedRows.every(
      (row) => row.extraBales > 0 && row.targetConfigured !== false && row.ratePerBale != null && row.ratePerBale > 0
    );
  const selectedAmount = selectedRows.reduce((total, row) => total + row.proposedAmount, 0);
  return {
    allVisibleSelected,
    canApproveSelected,
    confirmDecision,
    data,
    eligible,
    end,
    error,
    filter,
    isLoading,
    rangeValid,
    rateDate,
    rateInput,
    rateMutation,
    rateWorker,
    reviewMutation,
    search,
    selected,
    selectedAmount,
    selectedRows,
    setConfirmDecision,
    setEnd,
    setFilter,
    setRateDate,
    setRateInput,
    setRateWorker,
    setSearch,
    setSelected,
    setStart,
    start,
    visible,
    workerBreakdown,
  };
}
