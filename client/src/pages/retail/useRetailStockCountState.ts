// Extracted from ./RetailStockCount.tsx to keep that module under the source-size cap.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { queryClient } from "@/lib/queryClient";
import { getJson, type Location } from "./retailInventoryTypes";
import {
  createRetailStockCountSession,
  fetchRetailStockCountReport,
  fetchRetailStockCountSession,
  fetchRetailStockCountVariance,
  listRetailStockCountSessions,
  scanRetailStockCount,
  transitionRetailStockCount,
  updateRetailStockCountLine,
} from "@/pages/pos/retailWave2Api";
import type {
  RetailStockCountLineStatus,
  RetailStockCountSession,
  RetailStockCountSessionLine,
} from "@/pages/pos/retailWave2Types";

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  counting: "Counting",
  review: "Review",
  finalized: "Finalized",
  canceled: "Canceled",
};

export const LINE_STATUS_LABELS: Record<RetailStockCountLineStatus, string> = {
  uncounted: "Uncounted",
  counted: "Counted",
  variance: "Variance",
  unexpected: "Unexpected",
};

export function statusClass(status: string): string {
  if (status === "finalized") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";
  if (status === "canceled") return "bg-muted text-muted-foreground";
  if (status === "counting") return "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300";
  if (status === "review") return "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300";
  return "bg-muted text-foreground";
}

export function lineStatusClass(status: RetailStockCountLineStatus): string {
  if (status === "variance") return "text-amber-700 dark:text-amber-400 font-medium";
  if (status === "unexpected") return "text-destructive font-medium";
  if (status === "uncounted") return "text-muted-foreground";
  return "";
}

export function useRetailStockCountState() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const canChangeCounts = recordChanges.allowed;
  const retailEnabled = selectedCompany?.companyType === "retail";
  const [locationId, setLocationId] = useState<number | "">("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [scanText, setScanText] = useState("");
  const [includeAllVariants, setIncludeAllVariants] = useState(false);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [allowUncounted, setAllowUncounted] = useState(false);
  const [confirmVariance, setConfirmVariance] = useState(false);
  const [finalizeNotes, setFinalizeNotes] = useState("");
  const scanRef = useRef<HTMLInputElement | null>(null);

  const locationsQuery = useQuery({
    queryKey: ["retail-stock-count-locations"],
    queryFn: () => getJson<Location[]>("/api/locations"),
    enabled: retailEnabled,
  });
  const locations = (locationsQuery.data ?? []).filter((location) => location.id > 0);

  useEffect(() => {
    if (!locationId && locations.length === 1) setLocationId(locations[0].id);
  }, [locationId, locations]);

  const sessionsQuery = useQuery({
    queryKey: ["retail-stock-counts", locationId],
    queryFn: () => listRetailStockCountSessions({ locationId: locationId || undefined, limit: 50 }),
    enabled: retailEnabled,
    refetchInterval: 15_000,
  });

  const sessionQuery = useQuery({
    queryKey: ["retail-stock-count", selectedId],
    queryFn: () => fetchRetailStockCountSession(selectedId as number),
    enabled: retailEnabled && Boolean(selectedId),
    refetchInterval: 10_000,
  });
  const session: RetailStockCountSession | null = sessionQuery.data ?? null;

  const reportQuery = useQuery({
    queryKey: ["retail-stock-count-report", locationId],
    queryFn: () => fetchRetailStockCountReport({ locationId: locationId || undefined }),
    enabled: retailEnabled,
  });

  const varianceQuery = useQuery({
    queryKey: ["retail-stock-count-variance", session?.id, session?.status],
    queryFn: () => fetchRetailStockCountVariance(session!.id),
    enabled: Boolean(session && session.status === "finalized"),
  });

  const refreshAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["retail-stock-counts"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-stock-count-report"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-stock-count"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-stock-count-variance"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-pos-items"] }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: () =>
      createRetailStockCountSession({
        locationId: locationId as number,
        includeAllVariants,
        startNow: true,
      }),
    onSuccess: async (created) => {
      setSelectedId(created.id);
      await refreshAll();
      toast({ title: "Stock count started", description: `${created.code} · ${created.lineCount} lines snapshotted.` });
      window.setTimeout(() => scanRef.current?.focus(), 50);
    },
    onError: (error) =>
      toast({ title: "Could not start the count", description: error.message, variant: "destructive" }),
  });

  const transitionMutation = useMutation({
    mutationFn: (input: { action: "start" | "review" | "recount" | "cancel" }) =>
      transitionRetailStockCount(
        session!.id,
        input.action,
        input.action === "cancel" ? { reason: "Canceled from stock count screen" } : {},
        recordChanges
      ),
    onSuccess: async (_data, input) => {
      await refreshAll();
      toast({
        title: `Stock count ${input.action}`,
        description: `Stock count ${session?.code ?? "current session"} updated.`,
      });
    },
    onError: (error) => toast({ title: "Action failed", description: error.message, variant: "destructive" }),
  });

  const finalizeMutation = useMutation({
    mutationFn: () =>
      transitionRetailStockCount(
        session!.id,
        "finalize",
        {
          allowUncounted,
          confirmVariance,
          notes: finalizeNotes.trim() || undefined,
        },
        recordChanges
      ),
    onSuccess: async (data) => {
      setFinalizeOpen(false);
      await refreshAll();
      const movementsWritten = data.session.movementCount ?? data.session.countedLineCount;
      toast({
        title: "Stock count finalized",
        description: `${movementsWritten} inventory movements were written by this count.`,
      });
    },
    onError: (error) => toast({ title: "Finalize failed", description: error.message, variant: "destructive" }),
  });

  const scanMutation = useMutation({
    mutationFn: (barcode: string) =>
      scanRetailStockCount(session!.id, { barcode, quantity: 1, mode: "increment" }, recordChanges),
    onSuccess: async (data) => {
      setScanText("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["retail-stock-count"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-stock-counts"] }),
      ]);
      const entry = (data as unknown as { line?: { status?: string; unexpected?: boolean } })?.line ?? {};
      toast({
        title: entry.unexpected ? "Unexpected item counted" : "Counted",
        description: entry.unexpected
          ? "This variant was not in the snapshot — it will be reviewed as an unexpected line."
          : "Quantity incremented by 1.",
      });
    },
    onError: (error) => toast({ title: "Scan rejected", description: error.message, variant: "destructive" }),
  });

  const lineMutation = useMutation({
    mutationFn: (input: {
      line: RetailStockCountSessionLine;
      countedQuantity?: number;
      recountRequired?: boolean;
      notes?: string;
    }) =>
      updateRetailStockCountLine(
        session!.id,
        input.line.id,
        {
          countedQuantity: input.countedQuantity,
          recountRequired: input.recountRequired,
          notes: input.notes,
        },
        recordChanges
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["retail-stock-count"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-stock-counts"] }),
      ]);
    },
    onError: (error) =>
      toast({ title: "Could not update the line", description: error.message, variant: "destructive" }),
  });

  const lines = useMemo(() => session?.lines ?? [], [session]);
  const canCount = canChangeCounts && session?.status === "counting";
  const report = reportQuery.data;
  return {
    allowUncounted,
    canChangeCounts,
    canCount,
    confirmVariance,
    createMutation,
    finalizeMutation,
    finalizeNotes,
    finalizeOpen,
    includeAllVariants,
    lineMutation,
    lines,
    locationId,
    locations,
    recordChanges,
    report,
    retailEnabled,
    scanMutation,
    scanRef,
    scanText,
    selectedId,
    session,
    sessionsQuery,
    setAllowUncounted,
    setConfirmVariance,
    setFinalizeNotes,
    setFinalizeOpen,
    setIncludeAllVariants,
    setLocationId,
    setScanText,
    setSelectedId,
    transitionMutation,
    varianceQuery,
  };
}
