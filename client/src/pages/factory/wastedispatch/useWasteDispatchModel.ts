/**
 * Data and selection model for the Waste Dispatch page.
 *
 * Extracted from WasteDispatchOptimized.tsx during the P1 god-file split.
 * Owns the paged summary/history queries, the lazy per-group and per-dispatch
 * bale detail queries, the bale selection state, and the submit/delete
 * mutations — so the page component can stay pure composition.
 */

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { baleMatchesSearch, fetchGroupBales, fetchHistoryBales, readWasteJson } from "./optimizedData";
import { printDispatchDocument } from "./optimizedPrint";
import { today } from "./utils";
import type {
  GroupSummary,
  HistoryBale,
  HistoryItem,
  HistoryResponse,
  PrintDispatch,
  SummaryResponse,
  WasteBale,
} from "./optimizedTypes";

const GROUP_PAGE_SIZE = 25;
const HISTORY_PAGE_SIZE = 10;
const DETAIL_STALE_MS = 5 * 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGloballyHandled(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
    error !== null &&
    "_handledGlobally" in error &&
    (error as { _handledGlobally?: boolean })._handledGlobally
  );
}

export function useWasteDispatchModel() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [balePage, setBalePage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);
  const [scanInput, setScanInput] = useState("");
  const [dispatchDate, setDispatchDate] = useState(today());
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<Map<number, WasteBale>>(new Map());
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const [expandedHistoryIds, setExpandedHistoryIds] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleteDispatchId, setDeleteDispatchId] = useState<number | null>(null);
  const [printData, setPrintData] = useState<{ dispatch: PrintDispatch; bales: HistoryBale[] } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setBalePage(1);
      setExpandedGroups(new Set());
    }, 400);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setExpandedGroups(new Set());
  }, [balePage]);

  useEffect(() => {
    setExpandedHistoryIds(new Set());
  }, [historyPage]);

  const summaryParams = new URLSearchParams({
    page: String(balePage),
    limit: String(GROUP_PAGE_SIZE),
  });
  if (debouncedSearch) summaryParams.set("search", debouncedSearch);

  const { data: summary, isLoading: summaryLoading } = useQuery<SummaryResponse>({
    queryKey: ["/api/factory/waste-dispatch/summary", balePage, debouncedSearch],
    queryFn: () => readWasteJson(`/api/factory/waste-dispatch/summary?${summaryParams.toString()}`),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: (previous) => previous,
  });

  const { data: history, isLoading: historyLoading } = useQuery<HistoryResponse>({
    queryKey: ["/api/factory/waste-dispatch/history-summary", historyPage],
    queryFn: () =>
      readWasteJson(`/api/factory/waste-dispatch/history-summary?page=${historyPage}&limit=${HISTORY_PAGE_SIZE}`),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: (previous) => previous,
  });

  useEffect(() => {
    const totalPages = summary?.pagination.totalPages || 1;
    if (balePage > totalPages) setBalePage(totalPages);
  }, [balePage, summary?.pagination.totalPages]);

  useEffect(() => {
    const totalPages = history?.pagination.totalPages || 1;
    if (historyPage > totalPages) setHistoryPage(totalPages);
  }, [historyPage, history?.pagination.totalPages]);

  const groups = useMemo(() => summary?.groups ?? [], [summary?.groups]);
  const summaryTotals = summary?.totals ?? { bales: 0, weight: 0, cost: 0 };
  const summaryPagination = summary?.pagination ?? { page: 1, limit: GROUP_PAGE_SIZE, total: 0, totalPages: 1 };
  const historyItems = useMemo(() => history?.items ?? [], [history?.items]);
  const historyPagination = history?.pagination ?? {
    page: 1,
    limit: HISTORY_PAGE_SIZE,
    total: 0,
    totalPages: 1,
  };

  const visibleExpandedProductIds = useMemo(
    () => Array.from(expandedGroups).filter((productId) => groups.some((group) => group.productId === productId)),
    [expandedGroups, groups]
  );
  const groupQueries = useQueries({
    queries: visibleExpandedProductIds.map((productId) => ({
      queryKey: ["/api/factory/waste-dispatch/group-bales", productId, debouncedSearch],
      queryFn: () => fetchGroupBales(productId, debouncedSearch),
      staleTime: DETAIL_STALE_MS,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })),
  });
  const groupQueryById = useMemo(
    () => new Map(visibleExpandedProductIds.map((productId, index) => [productId, groupQueries[index]])),
    [visibleExpandedProductIds, groupQueries]
  );

  const visibleExpandedHistoryIds = useMemo(
    () => Array.from(expandedHistoryIds).filter((dispatchId) => historyItems.some((item) => item.id === dispatchId)),
    [expandedHistoryIds, historyItems]
  );
  const historyDetailQueries = useQueries({
    queries: visibleExpandedHistoryIds.map((dispatchId) => ({
      queryKey: ["/api/factory/waste-dispatch/history-bales", dispatchId],
      queryFn: () => fetchHistoryBales(dispatchId),
      staleTime: DETAIL_STALE_MS,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })),
  });
  const historyQueryById = useMemo(
    () => new Map(visibleExpandedHistoryIds.map((dispatchId, index) => [dispatchId, historyDetailQueries[index]])),
    [visibleExpandedHistoryIds, historyDetailQueries]
  );

  const selectedBales = useMemo(() => Array.from(selected.values()), [selected]);
  const selectedTotals = useMemo(
    () => ({
      weight: selectedBales.reduce((sum, bale) => sum + Number(bale.weightKg || 0), 0),
      cost: selectedBales.reduce((sum, bale) => sum + Number(bale.totalCost || 0), 0),
    }),
    [selectedBales]
  );

  const clearSelectedBales = () => setSelected(new Map<number, WasteBale>());

  const toggleBale = (bale: WasteBale) => {
    setSelected((previous) => {
      const next = new Map(previous);
      if (next.has(bale.id)) next.delete(bale.id);
      else next.set(bale.id, bale);
      return next;
    });
  };

  const toggleExpandGroup = (productId: number) => {
    setExpandedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const toggleGroupSelection = async (group: GroupSummary) => {
    try {
      const bales = await queryClient.fetchQuery({
        queryKey: ["/api/factory/waste-dispatch/group-bales", group.productId, debouncedSearch],
        queryFn: () => fetchGroupBales(group.productId, debouncedSearch),
        staleTime: DETAIL_STALE_MS,
      });
      setSelected((previous) => {
        const allSelected = bales.length > 0 && bales.every((bale) => previous.has(bale.id));
        const next = new Map(previous);
        for (const bale of bales) {
          if (allSelected) next.delete(bale.id);
          else next.set(bale.id, bale);
        }
        return next;
      });
    } catch (error: unknown) {
      toast({ title: "Could not load product bales", description: errorMessage(error), variant: "destructive" });
    }
  };

  const selectAllMutation = useMutation({
    mutationFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      return readWasteJson<{ bales: WasteBale[] }>(`/api/factory/waste-dispatch/select-all?${params.toString()}`);
    },
    onSuccess: ({ bales }) => {
      setSelected(new Map(bales.map((bale) => [bale.id, bale])));
      toast({ title: "Selection updated", description: `${bales.length} matching bale(s) selected.` });
    },
    onError: (error: unknown) => {
      toast({ title: "Could not select bales", description: errorMessage(error), variant: "destructive" });
    },
  });

  const handleScan = async (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    const reference = scanInput.trim();
    if (!reference) return;
    try {
      const response = await readWasteJson<{ bale: WasteBale }>(
        `/api/factory/waste-dispatch/scan?ref=${encodeURIComponent(reference)}`
      );
      setSelected((previous) => new Map(previous).set(response.bale.id, response.bale));
      if (baleMatchesSearch(response.bale, debouncedSearch)) {
        setExpandedGroups((previous) => new Set(previous).add(response.bale.productId));
      }
      setScanInput("");
      toast({ title: "Bale added", description: `${response.bale.referenceNumber} — ${response.bale.productName}` });
    } catch (error: unknown) {
      toast({ title: "Not found", description: errorMessage(error), variant: "destructive" });
      setScanInput("");
    }
  };

  const invalidateWasteReads = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/factory/waste-dispatch/summary"] });
    queryClient.invalidateQueries({ queryKey: ["/api/factory/waste-dispatch/group-bales"] });
    queryClient.invalidateQueries({ queryKey: ["/api/factory/waste-dispatch/history-summary"] });
    queryClient.invalidateQueries({ queryKey: ["/api/factory/waste-dispatch/history-bales"] });
  };

  const submitMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/factory/waste-dispatch/submit", {
        baleIds: Array.from(selected.keys()),
        dispatchDate,
        notes: notes.trim() || undefined,
      });
      return response.json();
    },
    onSuccess: (result) => {
      const dispatchedBales: HistoryBale[] = Array.from(selected.values()).map((bale) => ({
        id: bale.id,
        referenceNumber: bale.referenceNumber,
        productName: bale.productName,
        weightKg: bale.weightKg,
        totalCost: bale.totalCost,
      }));
      invalidateWasteReads();
      setSelected(new Map<number, WasteBale>());
      setExpandedGroups(new Set());
      setNotes("");
      setConfirming(false);
      setPrintData({
        dispatch: {
          dispatchNumber: result.dispatch.dispatchNumber,
          dispatchDate: result.dispatch.dispatchDate,
          notes: result.dispatch.notes,
        },
        bales: dispatchedBales,
      });
      toast({
        title: "Waste disposed",
        description: `${result.totalBales} bale(s) marked as disposed (${result.dispatch.dispatchNumber})`,
      });
    },
    onError: (error: unknown) => {
      if (isGloballyHandled(error)) return;
      toast({ title: "Error", description: errorMessage(error), variant: "destructive" });
      setConfirming(false);
    },
  });

  const deleteDispatchMutation = useMutation({
    mutationFn: async (id: number) => {
      const response = await apiRequest("DELETE", `/api/factory/waste-dispatch/${id}`);
      return response.json();
    },
    onSuccess: (result, id) => {
      invalidateWasteReads();
      queryClient.removeQueries({ queryKey: ["/api/factory/waste-dispatch/history-bales", id] });
      setDeleteDispatchId(null);
      setExpandedHistoryIds((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
      toast({ title: "Dispatch deleted", description: `${result.restoredBales} bale(s) restored to stock.` });
    },
    onError: (error: unknown) => {
      if (isGloballyHandled(error)) return;
      toast({ title: "Error", description: errorMessage(error), variant: "destructive" });
      setDeleteDispatchId(null);
    },
  });

  const toggleHistoryItem = (id: number) => {
    setExpandedHistoryIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleHistoryPrint = async (dispatch: HistoryItem) => {
    try {
      const bales = await queryClient.fetchQuery({
        queryKey: ["/api/factory/waste-dispatch/history-bales", dispatch.id],
        queryFn: () => fetchHistoryBales(dispatch.id),
        staleTime: DETAIL_STALE_MS,
      });
      printDispatchDocument(dispatch, bales);
    } catch (error: unknown) {
      toast({ title: "Could not load dispatch", description: errorMessage(error), variant: "destructive" });
    }
  };

  return {
    // state
    search,
    setSearch,
    debouncedSearch,
    balePage,
    setBalePage,
    historyPage,
    setHistoryPage,
    scanInput,
    setScanInput,
    dispatchDate,
    setDispatchDate,
    notes,
    setNotes,
    selected,
    expandedGroups,
    expandedHistoryIds,
    confirming,
    setConfirming,
    deleteDispatchId,
    setDeleteDispatchId,
    printData,
    setPrintData,
    // data
    summaryLoading,
    historyLoading,
    groups,
    summaryTotals,
    summaryPagination,
    historyItems,
    historyPagination,
    groupQueryById,
    historyQueryById,
    selectedBales,
    selectedTotals,
    // actions
    clearSelectedBales,
    toggleBale,
    toggleExpandGroup,
    toggleGroupSelection,
    selectAllMutation,
    handleScan,
    submitMutation,
    deleteDispatchMutation,
    toggleHistoryItem,
    handleHistoryPrint,
  };
}
