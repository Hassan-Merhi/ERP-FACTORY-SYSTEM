// Extracted from ./useFactoryPriorityScanState.ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { visibleTabInterval } from "@/lib/queryPolicies";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useCompany } from "@/contexts/CompanyContext";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { type PriorityScanTranslationKey, translatePriorityScanText } from "@/i18n/priorityScanTranslations";
import {
  fetchPriorityScanHistory,
  PRIORITY_SCAN_HISTORY_URL,
  type PriorityScanHistoryResponse,
} from "./priorityScanHistory";
import {
  PENDING_LOADS_URL,
  PRIORITY_SCAN_CONFIGS_URL,
  PRIORITY_SCAN_FLASH_MS,
  PRIORITY_SCAN_ROUTE_URL,
  type PendingLoad,
  type PriorityRouteResolution,
  type PriorityScanAllocation,
  type PriorityScanConfig,
  type ScanFeedback,
} from "./FactoryPriorityScanTypes";

export function useFactoryPriorityScanStatePart1() {
  const { language } = useApplicationLanguage();
  const { selectedCompany } = useCompany();
  // Every priority scan allocates the bale into an existing loading: a write.
  const recordChanges = useExistingRecordChangeAccess();
  const tr = useCallback(
    (key: PriorityScanTranslationKey, params?: Record<string, string | number>) =>
      translatePriorityScanText(key, language, params),
    [language]
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanSubmissionInFlightRef = useRef(false);
  const [scanInput, setScanInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);
  const [priorityFlashVisible, setPriorityFlashVisible] = useState(false);
  const [localFlash, setLocalFlash] = useState<Pick<
    PriorityScanHistoryResponse["scans"][number],
    "referenceNumber" | "priority" | "color" | "orderId"
  > | null>(null);
  const [historyView, setHistoryView] = useState<"condensed" | "detailed">("condensed");

  const { data: configs = [], isLoading: configsLoading } = useQuery<PriorityScanConfig[]>({
    queryKey: [PRIORITY_SCAN_CONFIGS_URL],
    refetchInterval: visibleTabInterval(15_000),
    refetchIntervalInBackground: false,
  });

  const { data: loads = [], isLoading: loadsLoading } = useQuery<PendingLoad[]>({
    queryKey: [PENDING_LOADS_URL],
    refetchInterval: visibleTabInterval(30_000),
    refetchIntervalInBackground: false,
  });

  const { data: priorityHistory } = useQuery<PriorityScanHistoryResponse>({
    queryKey: [PRIORITY_SCAN_HISTORY_URL, selectedCompany?.id ?? null],
    queryFn: ({ queryKey }) => fetchPriorityScanHistory(queryClient, queryKey),
    refetchInterval: visibleTabInterval(1_000),
    refetchIntervalInBackground: false,
  });
  const sessionScans = useMemo(() => priorityHistory?.scans ?? [], [priorityHistory?.scans]);

  const condensedSessionScans = useMemo(() => {
    const grouped = new Map<
      string,
      { name: string; articleCode: string | null; count: number; latestScannedAt: string; colors: string[] }
    >();

    for (const scan of sessionScans) {
      const name = scan.productName?.trim() || tr("unnamedProduct");
      const key = name.toLocaleLowerCase("en-US");
      const existing = grouped.get(key);
      if (existing) {
        existing.count += 1;
        if (!existing.colors.some((color) => color.toLowerCase() === scan.color.toLowerCase())) {
          existing.colors.push(scan.color);
        }
        if (Date.parse(scan.scannedAt) > Date.parse(existing.latestScannedAt)) {
          existing.latestScannedAt = scan.scannedAt;
          existing.articleCode = scan.articleCode;
        }
      } else {
        grouped.set(key, {
          name,
          articleCode: scan.articleCode,
          count: 1,
          latestScannedAt: scan.scannedAt,
          colors: [scan.color],
        });
      }
    }

    return Array.from(grouped.values()).sort((a, b) => Date.parse(b.latestScannedAt) - Date.parse(a.latestScannedAt));
  }, [sessionScans, tr]);

  const activeQueue = useMemo(() => {
    const loadMap = new Map(loads.map((load) => [load.id, load]));
    return configs
      .filter((config) => config.enabled)
      .sort((a, b) => a.priority - b.priority || a.orderId - b.orderId)
      .map((config) => ({
        ...config,
        load: loadMap.get(config.orderId),
      }));
  }, [configs, loads]);

  const latestScannedBale = sessionScans[0] ?? null;

  useEffect(() => {
    if (!latestScannedBale?.scannedAt || !priorityHistory?.serverNow) {
      setPriorityFlashVisible(false);
      return;
    }

    const scannedAtMs = Date.parse(latestScannedBale.scannedAt);
    const serverNowMs = Date.parse(priorityHistory.serverNow);
    if (!Number.isFinite(scannedAtMs) || !Number.isFinite(serverNowMs)) {
      setPriorityFlashVisible(false);
      return;
    }

    const remainingMs = PRIORITY_SCAN_FLASH_MS - Math.max(0, serverNowMs - scannedAtMs);
    if (remainingMs <= 0) {
      setPriorityFlashVisible(false);
      return;
    }

    setPriorityFlashVisible(true);
    const timer = window.setTimeout(() => setPriorityFlashVisible(false), remainingMs);
    return () => window.clearTimeout(timer);
  }, [latestScannedBale?.id, latestScannedBale?.scannedAt, priorityHistory?.serverNow]);

  const currentPriorityBale = localFlash ?? (priorityFlashVisible ? latestScannedBale : null);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  useEffect(
    () => () => {
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
      if (localFlashTimerRef.current) clearTimeout(localFlashTimerRef.current);
    },
    []
  );

  const showFeedback = (next: ScanFeedback) => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setFeedback(next);
    feedbackTimerRef.current = setTimeout(() => setFeedback(null), 5000);
  };

  // The server-confirmed route immediately illuminates the exact saved priority color.
  // The history-driven flash above remains the fallback for scans on other devices.
  const flashConfirmedRoute = (route: PriorityScanAllocation) => {
    if (localFlashTimerRef.current) clearTimeout(localFlashTimerRef.current);
    setLocalFlash({
      referenceNumber: route.referenceNumber,
      priority: route.target.priority,
      color: route.target.color,
      orderId: route.target.orderId,
    });
    localFlashTimerRef.current = setTimeout(() => setLocalFlash(null), PRIORITY_SCAN_FLASH_MS);
  };

  const focusScanner = () => {
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const resolvePriorityRoute = async (referenceNumber: string): Promise<PriorityRouteResolution> => {
    const response = await apiRequest("GET", `${PRIORITY_SCAN_ROUTE_URL}?code=${encodeURIComponent(referenceNumber)}`);
    return response.json() as Promise<PriorityRouteResolution>;
  };
  return {
    recordChanges,
    tr,
    inputRef,
    scanSubmissionInFlightRef,
    scanInput,
    setScanInput,
    scanning,
    setScanning,
    feedback,
    historyView,
    setHistoryView,
    configsLoading,
    loadsLoading,
    sessionScans,
    condensedSessionScans,
    activeQueue,
    currentPriorityBale,
    showFeedback,
    flashConfirmedRoute,
    focusScanner,
    resolvePriorityRoute,
  };
}
