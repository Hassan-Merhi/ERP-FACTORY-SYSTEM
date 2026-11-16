// Extracted from ./FactoryLoadingDispatchScanner.tsx to keep that module under the source-size cap.
import { type KeyboardEvent, useCallback, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CameraScanFeedback } from "@/components/MobileBarcodeScanner";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";

type DispatchStatus = "OPEN" | "CLOSED" | "CANCELLED";

interface DispatchScan {
  id: number | string;
  dispatchId: number | string;
  orderId: number;
  baleId: number;
  baleReference: string;
  articleCode?: string | null;
  productName?: string | null;
  weightKg: string | number;
  scannedByUsername: string;
  scannedAt: string;
  removedAt?: string | null;
  removedByUserId?: string | null;
  removalReason?: string | null;
  stillInLoading: boolean;
}

interface ScanHistoryResponse {
  orderId: number;
  dispatchId: number;
  status: DispatchStatus;
  activeCount: number;
  activeWeightKg: number;
  scans: DispatchScan[];
}

interface DispatchScanError extends Error {
  code?: string;
  previous?: {
    baleReference?: string;
    scannedByUsername?: string;
    dispatchNumber?: number;
    scannedAt?: string;
  } | null;
}

export interface Props {
  orderId: number;
  dispatchId: number;
  companyId: number | null | undefined;
  status: DispatchStatus;
  role: string;
  onChanged: () => void;
}

export const PAGE_CHUNK = 100;

const MAX_PENDING = 50;

function scanError(error: unknown): { type: CameraScanFeedback["type"]; message: string } {
  const problem = error as DispatchScanError | null;
  const type: CameraScanFeedback["type"] =
    problem?.code === "DISPATCH_DUPLICATE"
      ? "duplicate"
      : problem?.code === "DISPATCH_NOT_IN_LOADING" || problem?.code === "DISPATCH_AMBIGUOUS_BARCODE"
        ? "warn"
        : "error";
  const prior = problem?.previous;
  const detail =
    type === "duplicate" && prior
      ? "Trip #" + prior.dispatchNumber + " · " + (prior.scannedByUsername || "Previous scanner")
      : null;
  return { type, message: detail || problem?.message || "Could not verify this bale" };
}

export function fmtCount(n: number): string {
  return n.toLocaleString();
}

export function fmtKg(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function useFactoryLoadingDispatchScannerState({
  orderId,
  dispatchId,
  companyId,
  status,
  role,
  onChanged,
}: Props) {
  const { toast } = useToast();
  const { formatDisplayDateTime } = useDateFormat();
  const baseUrl = "/api/factory/customer-orders/" + orderId + "/loading-dispatches/" + dispatchId;
  const scansUrl = baseUrl + "/scans";
  const scanKey = companyQueryKey(scansUrl, companyId);
  const loadingListKey = companyQueryKey("/api/factory/customer-orders/" + orderId + "/loading-dispatches", companyId);
  const writable = status === "OPEN" && !["view only", "create only"].includes(role.toLowerCase());
  const canCorrect = status === "OPEN" && ["admin", "owner", "developer"].includes(role.toLowerCase());

  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingRef = useRef<string[]>([]);
  const processingRef = useRef(false);
  const [scanText, setScanText] = useState("");
  const [pendingCount, setPendingCount] = useState(0);
  const [feedback, setFeedback] = useState<CameraScanFeedback | null>(null);
  const [filterText, setFilterText] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_CHUNK);
  const [removedVisible, setRemovedVisible] = useState(false);
  const [correction, setCorrection] = useState<DispatchScan | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [correcting, setCorrecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkMode, setBulkMode] = useState<"selected" | "all" | null>(null);
  const [bulkReason, setBulkReason] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery<ScanHistoryResponse>({
    queryKey: scanKey,
    queryFn: async () => {
      const res = await fetch(scansUrl, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Unable to load dispatch scan history");
      }
      return res.json() as Promise<ScanHistoryResponse>;
    },
    enabled: Boolean(companyId) && orderId > 0 && dispatchId > 0,
    refetchInterval: 5000,
  });

  const scans = useMemo(() => data?.scans ?? [], [data?.scans]);
  const active = useMemo(() => scans.filter((item) => !item.removedAt), [scans]);
  const corrected = useMemo(() => scans.filter((item) => Boolean(item.removedAt)), [scans]);
  const filtered = useMemo(() => {
    const term = filterText.trim().toLocaleLowerCase();
    if (!term) return active;
    return active.filter((item) =>
      [item.baleReference, item.articleCode ?? "", item.productName ?? "", item.scannedByUsername].some((text) =>
        text.toLocaleLowerCase().includes(term)
      )
    );
  }, [active, filterText]);
  const visibleScans = filtered.slice(0, visibleCount);
  const activeSelection = useMemo(
    () => active.map((scan) => String(scan.id)).filter((id) => selectedIds.has(id)),
    [active, selectedIds]
  );
  const allFilteredSelected = filtered.length > 0 && filtered.every((scan) => selectedIds.has(String(scan.id)));
  const toggleSelection = (id: string, checked: boolean) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  const selectAllFiltered = (checked: boolean) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      filtered.forEach((scan) => {
        if (checked) next.add(String(scan.id));
        else next.delete(String(scan.id));
      });
      return next;
    });

  const removeBulk = async () => {
    if (!bulkMode || !canCorrect || bulkBusy || pendingCount > 0) return;
    const reason = bulkReason.trim();
    if (reason.length < 3 || reason.length > 500) return;
    if (bulkMode === "selected" && !activeSelection.length) return;
    setBulkBusy(true);
    try {
      const response = await apiRequest("POST", scansUrl + "/bulk-remove", {
        reason,
        ...(bulkMode === "all" ? { all: true } : { scanIds: activeSelection }),
      });
      const result: { count: number } = await response.json();
      setBulkMode(null);
      setBulkReason("");
      setSelectedIds(new Set<string>());
      void queryClient.invalidateQueries({ queryKey: scanKey });
      void queryClient.invalidateQueries({ queryKey: loadingListKey });
      onChanged();
      toast({
        title: result.count + " scan" + (result.count === 1 ? "" : "s") + " removed",
        description: "Scans remain in correction history. Main loading and inventory are unchanged.",
      });
    } catch (error) {
      toast({
        title: "Unable to remove dispatch scans",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setBulkBusy(false);
    }
  };

  const flushQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      while (pendingRef.current.length) {
        const code = pendingRef.current.shift()!;
        setPendingCount(pendingRef.current.length + 1);
        try {
          const response = await apiRequest("POST", scansUrl, { scanCode: code });
          const item: {
            baleReference?: string;
            articleCode?: string;
            weightKg?: string | number;
            status?: string;
            warningMessage?: string;
          } = await response.json();
          setFeedback({
            type: item.status === "REVIEW_REQUIRED" ? "warn" : "success",
            referenceNumber: item.baleReference || code,
            message:
              item.warningMessage ||
              "Verified for this truck · " +
                (item.articleCode || "Bale") +
                " · " +
                fmtKg(Number(item.weightKg ?? 0)) +
                " kg",
          });
          // Refetch the saved facts; we never count an unconfirmed scan.
          void queryClient.invalidateQueries({ queryKey: scanKey });
          void queryClient.invalidateQueries({ queryKey: loadingListKey });
          onChanged();
        } catch (error) {
          const resolved = scanError(error);
          setFeedback({ type: resolved.type, referenceNumber: code, message: resolved.message });
          if (resolved.type !== "duplicate") {
            toast({ title: "Bale not verified", description: resolved.message, variant: "destructive" });
          }
          if ((error as DispatchScanError)?.code === "DISPATCH_NOT_OPEN") {
            pendingRef.current = [];
            onChanged();
          }
        } finally {
          setPendingCount(pendingRef.current.length);
        }
      }
    } finally {
      processingRef.current = false;
      setPendingCount(0);
    }
  }, [scansUrl, scanKey, loadingListKey, onChanged, toast]);

  const submitBarcode = useCallback(
    (code: string) => {
      if (!writable) return;
      const value = code.trim();
      if (!value) return;
      if (value.length > 120) {
        setFeedback({
          type: "error",
          referenceNumber: value.slice(0, 120),
          message: "Bale barcode exceeds 120 characters",
        });
        return;
      }
      if (pendingRef.current.length >= MAX_PENDING) {
        setFeedback({
          type: "warn",
          referenceNumber: value,
          message: "Scanner queue full. Check network connectivity.",
        });
        return;
      }
      pendingRef.current.push(value);
      setPendingCount(pendingRef.current.length + (processingRef.current ? 1 : 0));
      void flushQueue();
    },
    [writable, flushQueue]
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const value = scanText;
    setScanText("");
    submitBarcode(value);
    inputRef.current?.focus();
  };

  const removeScan = async () => {
    if (!correction || !canCorrect || correcting) return;
    const reason = correctionReason.trim();
    if (reason.length < 3 || reason.length > 500) return;
    setCorrecting(true);
    try {
      await apiRequest("POST", scansUrl + "/" + correction.id + "/remove", { reason });
      setCorrection(null);
      setCorrectionReason("");
      setSelectedIds((previous) => {
        const next = new Set(previous);
        next.delete(String(correction.id));
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: scanKey });
      void queryClient.invalidateQueries({ queryKey: loadingListKey });
      onChanged();
      toast({ title: "Dispatch scan corrected", description: "The previous scan stays in permanent history." });
    } catch (error) {
      toast({
        title: "Unable to correct scan",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setCorrecting(false);
    }
  };
  return {
    active,
    activeSelection,
    allFilteredSelected,
    bulkBusy,
    bulkMode,
    bulkReason,
    canCorrect,
    corrected,
    correcting,
    correction,
    correctionReason,
    data,
    error,
    feedback,
    filterText,
    filtered,
    formatDisplayDateTime,
    inputRef,
    isError,
    isLoading,
    onKeyDown,
    pendingCount,
    refetch,
    removeBulk,
    removeScan,
    removedVisible,
    scanText,
    selectAllFiltered,
    selectedIds,
    setBulkMode,
    setBulkReason,
    setCorrection,
    setCorrectionReason,
    setFilterText,
    setRemovedVisible,
    setScanText,
    setSelectedIds,
    setVisibleCount,
    status,
    submitBarcode,
    toggleSelection,
    visibleCount,
    visibleScans,
    writable,
  };
}
