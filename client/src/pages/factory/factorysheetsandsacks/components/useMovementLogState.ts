// Extracted from ./MovementLog.tsx
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { LogEntry } from "../types";
import { getPresetDates, localDayOf } from "../utils";

export function useMovementLogState() {
  const [preset, setPreset] = useState("week");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [direction, setDirection] = useState<"all" | "IN" | "OUT">("all");
  const [filterItemId, setFilterItemId] = useState<string>("all");

  const { from, to } = useMemo(() => {
    if (preset === "custom") return { from: customFrom, to: customTo };
    return getPresetDates(preset);
  }, [preset, customFrom, customTo]);

  const {
    data: logEntriesData,
    isLoading,
    isError,
    refetch,
  } = useQuery<LogEntry[]>({
    queryKey: ["/api/factory/sheets-sacks/log", from, to, direction, filterItemId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (direction !== "all") params.set("action", direction);
      if (filterItemId !== "all") params.set("itemId", filterItemId);
      const res = await apiRequest("GET", `/api/factory/sheets-sacks/log?${params}`);
      return res.json();
    },
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });
  const logEntries = useMemo(() => logEntriesData ?? [], [logEntriesData]);

  // Group by local calendar day
  const byDay = useMemo(() => {
    const groups: Record<string, LogEntry[]> = {};
    for (const e of logEntries) {
      const day = localDayOf(e.createdAt);
      if (!groups[day]) groups[day] = [];
      groups[day].push(e);
    }
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  }, [logEntries]);

  // Period totals — only count IN and OUT; ADJUST is shown but excluded from IN/OUT sums
  const totals = useMemo(() => {
    let inPcs = 0,
      outPcs = 0,
      inVal = 0,
      outVal = 0;
    for (const e of logEntries) {
      const pieces = Number(e.pieces) || 0;
      if (e.action === "IN") {
        inPcs += pieces;
        inVal += parseFloat(e.totalValue || "0");
      }
      if (e.action === "OUT") {
        outPcs += pieces;
        outVal += parseFloat(e.totalValue || "0");
      }
    }
    return { inPcs, outPcs, inVal, outVal, net: inPcs - outPcs };
  }, [logEntries]);

  const dayTotal = (entries: LogEntry[]) => {
    let inPcs = 0,
      outPcs = 0;
    for (const e of entries) {
      const pieces = Number(e.pieces) || 0;
      if (e.action === "IN") inPcs += pieces;
      if (e.action === "OUT") outPcs += pieces;
    }
    return { inPcs, outPcs, net: inPcs - outPcs };
  };
  return {
    preset,
    setPreset,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    direction,
    setDirection,
    filterItemId,
    setFilterItemId,
    from,
    to,
    isLoading,
    isError,
    logEntriesData,
    refetch,
    logEntries,
    byDay,
    totals,
    dayTotal,
  };
}
