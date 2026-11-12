import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Info, Layers, ListOrdered, PackageCheck, ScanLine } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { visibleTabInterval } from "@/lib/queryPolicies";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useCompany } from "@/contexts/CompanyContext";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { translatePriorityScanText, type PriorityScanTranslationKey } from "@/i18n/priorityScanTranslations";
import { getPriorityScanLetter, getPriorityScanLetterInk } from "@shared/priorityScanColors";
import { PriorityScanColorLetter } from "./PriorityScanColorLetter";
import {
  PRIORITY_SCAN_HISTORY_URL,
  fetchPriorityScanHistory,
  type PriorityScanHistoryResponse,
} from "./priorityScanHistory";

const PRIORITY_SCAN_CONFIGS_URL = "/api/factory/customer-orders/loading-list/priority-scan-configs";
const PENDING_LOADS_URL = "/api/factory/customer-orders?status=LOADING&profile=summary&pageSize=250";
const PRIORITY_SCAN_ROUTE_URL = "/api/factory/customer-orders/loading-list/priority-scan-route";
const PRIORITY_SCAN_FLASH_MS = 2_000;

interface PriorityScanConfig {
  id: number;
  orderId: number;
  color: string;
  priority: number;
  enabled: boolean;
  proformaIdUsed: number | null;
}

interface PendingLoad {
  id: number;
  customerId: number;
  customerName: string;
  totalQtyBales: number;
  proformaIdUsed: number | null;
  proformaName: string | null;
  status: string;
}

interface PriorityRouteTarget {
  orderId: number;
  priority: number;
  color: string;
  proformaId: number;
  remainingQty: number;
}

interface PriorityRouteResolution {
  referenceNumber: string;
  baleId: number;
  productName: string | null;
  articleCode: string;
  locationId: number;
  target: PriorityRouteTarget;
  candidates: PriorityRouteTarget[];
}

interface PriorityScanRequestError extends Error {
  status?: number;
  code?: string;
  overloaded?: unknown;
  notInProforma?: unknown;
}

interface PriorityScanAdvanceResult {
  completedOrderIds: number[];
  activeOrderId: number | null;
  activePriority: number | null;
}

interface PriorityScanAllocation extends PriorityRouteResolution {
  advance: PriorityScanAdvanceResult | null;
}

interface ScanFeedback {
  type: "success" | "error" | "warn" | "duplicate";
  referenceNumber: string;
  message: string;
}

export default function FactoryPriorityScan() {
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

  const allocatePriorityScan = async (referenceNumber: string): Promise<PriorityScanAllocation> => {
    const maxAttempts = Math.max(3, activeQueue.length + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const route = await resolvePriorityRoute(referenceNumber);
      try {
        const allocationResponse = await apiRequest(
          "POST",
          `/api/factory/customer-orders/${route.target.orderId}/bales`,
          {
            scanCode: route.referenceNumber,
            locationId: route.locationId,
            priorityScan: true,
          }
        );
        const allocation = (await allocationResponse.json()) as {
          priorityScanAdvance?: PriorityScanAdvanceResult | null;
        };
        return {
          ...route,
          advance: allocation.priorityScanAdvance ?? null,
        };
      } catch (error) {
        const requestError = error as PriorityScanRequestError;
        const routeMayHaveChanged =
          requestError.code === "PRIORITY_SCAN_ROUTE_CHANGED" ||
          (requestError.status === 400 && (requestError.overloaded === true || requestError.notInProforma === true));
        if (!routeMayHaveChanged || attempt === maxAttempts - 1) throw error;
      }
    }

    throw new Error(tr("noDestination"));
  };

  const handleScan = async (code = scanInput) => {
    const referenceNumber = code.trim().toUpperCase();
    if (!referenceNumber || scanning || scanSubmissionInFlightRef.current || !recordChanges.allowed) return;

    setScanInput("");

    if (activeQueue.length === 0) {
      showFeedback({
        type: "error",
        referenceNumber,
        message: tr("noActivePriority"),
      });
      focusScanner();
      return;
    }

    scanSubmissionInFlightRef.current = true;
    setScanning(true);
    try {
      const routed = await allocatePriorityScan(referenceNumber);
      flashConfirmedRoute(routed);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [PENDING_LOADS_URL] }),
        queryClient.invalidateQueries({ queryKey: [PRIORITY_SCAN_CONFIGS_URL] }),
        queryClient.invalidateQueries({
          queryKey: ["/api/factory/customer-orders", routed.target.orderId],
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/factory/customer-proformas/capacity", routed.target.proformaId],
        }),
        queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-stock-count"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/factory/daily-bale-scans"] }),
        queryClient.invalidateQueries({ queryKey: [PRIORITY_SCAN_HISTORY_URL] }),
      ]);

      const completedThisLoading = routed.advance?.completedOrderIds.includes(routed.target.orderId) === true;
      const message = completedThisLoading
        ? routed.advance?.activeOrderId
          ? tr("loadingSatisfiedAdvance", {
              orderId: routed.target.orderId,
              nextOrderId: routed.advance.activeOrderId,
            })
          : tr("loadingSatisfiedComplete", { orderId: routed.target.orderId })
        : tr("addedToPriority", {
            priority: routed.target.priority,
            orderId: routed.target.orderId,
          });

      showFeedback({
        type: "success",
        referenceNumber: routed.referenceNumber,
        message,
      });
    } catch (error) {
      const requestError = error as PriorityScanRequestError;

      if (requestError.code === "PRIORITY_SCAN_NOT_REQUIRED") {
        let dailyScanRecorded = true;
        try {
          await apiRequest("POST", "/api/factory/daily-bale-scans", { referenceNumber });
        } catch (dailyError) {
          if ((dailyError as PriorityScanRequestError).status !== 409) {
            dailyScanRecorded = false;
          }
        }

        await queryClient.invalidateQueries({ queryKey: ["/api/factory/daily-bale-scans"] });

        showFeedback({
          type: dailyScanRecorded ? "warn" : "error",
          referenceNumber,
          message: dailyScanRecorded
            ? `${requestError.message} It was still marked as scanned in Daily Scan.`
            : requestError.message,
        });
      } else {
        showFeedback({
          type: /already (?:been )?(?:scanned|loaded|added|in)|reserved for another loading/i.test(
            requestError.message || ""
          )
            ? "duplicate"
            : "error",
          referenceNumber,
          message: error instanceof Error ? error.message : tr("couldNotRoute"),
        });
      }
    } finally {
      scanSubmissionInFlightRef.current = false;
      setScanning(false);
      focusScanner();
    }
  };

  const isLoading = configsLoading || loadsLoading;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-gradient-to-b from-slate-50 via-slate-50 to-blue-50/40 p-3 text-slate-900 dark:from-[hsl(var(--factory-hue)_69%_9%)] dark:via-[hsl(var(--factory-hue)_66%_11%)] dark:to-[hsl(var(--factory-hue)_57%_12%)] dark:text-slate-100 sm:p-5">
      {/* These counters are derived from the same queue and daily history as the scanner. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex items-center gap-3 rounded-2xl border border-blue-200/80 bg-white/95 px-4 py-3 shadow-sm dark:border-blue-400/25 dark:bg-gradient-to-r dark:from-[hsl(var(--factory-hue)_59%_19%)] dark:to-[hsl(var(--factory-hue)_58%_15%)]">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">
            <Layers className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold tracking-wide text-slate-500 dark:text-slate-400">
              {tr("priorityQueue")}
            </p>
            <p className="text-2xl font-bold tabular-nums text-blue-700 dark:text-blue-300">{activeQueue.length}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-2xl border border-emerald-200/80 bg-white/95 px-4 py-3 shadow-sm dark:border-emerald-400/25 dark:bg-gradient-to-r dark:from-[hsl(var(--factory-hue)_52%_13%)] dark:to-[hsl(var(--factory-hue)_56%_14%)]">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
            <PackageCheck className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold tracking-wide text-slate-500 dark:text-slate-400">
              {tr("thisSession")}
            </p>
            <p
              className="text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300"
              data-testid="priority-scan-today-count"
            >
              {sessionScans.length.toLocaleString()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-2xl border border-violet-200/80 bg-white/95 px-4 py-3 shadow-sm dark:border-violet-400/25 dark:bg-gradient-to-r dark:from-[hsl(var(--factory-hue)_35%_19%)] dark:to-[hsl(var(--factory-hue)_43%_17%)]">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">
            <ListOrdered className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold tracking-wide text-slate-500 dark:text-slate-400">
              {tr("currentPriority")}
            </p>
            <p className="text-2xl font-bold tabular-nums text-violet-700 dark:text-violet-300">
              {activeQueue.length ? "#" + activeQueue[0].priority : "—"}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.9fr)_minmax(290px,0.9fr)]">
        <section className="relative overflow-hidden rounded-2xl border border-blue-200/80 bg-gradient-to-br from-white via-blue-50/70 to-sky-100/60 p-4 shadow-md shadow-blue-950/5 dark:border-blue-400/35 dark:bg-gradient-to-br dark:from-[hsl(var(--factory-hue)_65%_19%)] dark:via-[hsl(var(--factory-hue)_70%_16%)] dark:to-[hsl(var(--factory-hue)_69%_13%)] dark:shadow-blue-950/25 sm:p-5">
          <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-blue-400/10 blur-3xl dark:bg-blue-400/15" />
          <div className="relative flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-400/30 dark:bg-blue-500/20 dark:text-blue-300">
                <ScanLine className="h-6 w-6" />
              </span>
              <div>
                <h2 className="text-xl font-bold tracking-tight sm:text-2xl">{tr("priorityScan")}</h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-blue-100/75">{tr("scanDescription")}</p>
              </div>
            </div>
            <Badge className="rounded-full border border-blue-300 bg-blue-100 px-3 py-1 text-blue-800 shadow-none dark:border-blue-500/30 dark:bg-blue-500/20 dark:text-blue-200">
              {tr(activeQueue.length === 1 ? "activePriority" : "activePriorities", { count: activeQueue.length })}
            </Badge>
          </div>

          <div className="relative mt-5 flex gap-2">
            <div className="relative min-w-0 flex-1">
              <ScanLine className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-blue-600/70 dark:text-sky-300" />
              <Input
                ref={inputRef}
                value={scanInput}
                onChange={(event) => setScanInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleScan();
                  }
                }}
                placeholder={tr("scanPlaceholder")}
                autoComplete="off"
                className="h-12 rounded-xl border-blue-300 bg-white pl-11 font-mono text-base text-slate-900 shadow-inner shadow-blue-100/60 focus-visible:ring-blue-500 dark:border-blue-400/55 dark:bg-[hsl(var(--factory-hue)_75%_11%)] dark:text-white dark:shadow-blue-900/30 dark:placeholder:text-slate-400"
                disabled={scanning || !recordChanges.allowed}
                title={recordChanges.reason ?? undefined}
                data-testid="input-priority-scan"
              />
            </div>
            <MobileBarcodeScanner
              onScan={(code) => void handleScan(code)}
              feedback={feedback}
              disabled={scanning || !recordChanges.allowed}
              className="h-12 w-12 shrink-0 rounded-xl border-blue-300 dark:border-blue-400/55"
            />
            <Button
              type="button"
              className="h-12 shrink-0 rounded-xl bg-blue-600 px-4 font-semibold text-white shadow-md shadow-blue-600/20 hover:bg-blue-500 dark:bg-blue-600 dark:hover:bg-blue-500 sm:px-6"
              onClick={() => void handleScan()}
              disabled={scanning || !scanInput.trim() || !recordChanges.allowed}
              title={recordChanges.reason ?? undefined}
              data-testid="button-priority-scan"
            >
              <ScanLine className="mr-2 h-4 w-4" />
              {scanning ? tr("checking") : tr("scan")}
            </Button>
          </div>

          <div className="relative mt-4 flex gap-2 rounded-xl border border-blue-200/70 bg-blue-100/50 p-3 text-xs leading-relaxed text-slate-600 dark:border-blue-400/20 dark:bg-blue-950/35 dark:text-blue-100/75">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-sky-300" />
            <div className="space-y-1">
              <p>{tr("routeHint")}</p>
              <p>{tr("manualExceptionHint")}</p>
            </div>
          </div>

          {feedback && (
            <div
              role="status"
              className={[
                "relative mt-4 flex items-start gap-3 rounded-xl border px-4 py-3 shadow-sm",
                feedback.type === "success"
                  ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-400/45 dark:bg-emerald-950/45 dark:text-emerald-100"
                  : feedback.type === "warn"
                    ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-400/45 dark:bg-amber-950/45 dark:text-amber-100"
                    : "border-red-300 bg-red-50 text-red-900 dark:border-red-400/45 dark:bg-red-950/45 dark:text-red-100",
              ].join(" ")}
              data-testid="priority-scan-feedback"
            >
              {feedback.type === "success" ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
              ) : (
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
              )}
              <div className="min-w-0">
                <div className="font-mono font-bold">{feedback.referenceNumber}</div>
                <div className="text-sm">{feedback.message}</div>
              </div>
            </div>
          )}
        </section>

        {/* Preserve the authoritative full HEX-color flash and its M–W letter. */}
        <section
          className={[
            "relative flex min-h-[230px] flex-col overflow-hidden rounded-2xl border shadow-md transition-colors duration-150",
            currentPriorityBale
              ? "border-slate-400/40 shadow-slate-950/15 dark:border-white/20 dark:shadow-black/25"
              : "border-slate-200 bg-white dark:border-slate-700 dark:bg-gradient-to-br dark:from-[hsl(var(--factory-hue)_54%_18%)] dark:to-[hsl(var(--factory-hue)_64%_12%)]",
          ].join(" ")}
          style={
            currentPriorityBale
              ? {
                  backgroundColor: currentPriorityBale.color,
                  color: getPriorityScanLetterInk(currentPriorityBale.color),
                }
              : undefined
          }
          aria-label={
            currentPriorityBale ? tr("priorityColor", { color: currentPriorityBale.color }) : tr("currentPriority")
          }
          data-testid="current-priority-color"
        >
          {currentPriorityBale ? (
            <div
              className="flex h-full min-h-[230px] flex-col items-center justify-center gap-2 p-5 text-center"
              aria-live="polite"
            >
              <div className="flex items-center gap-1.5 rounded-full border border-current/30 bg-white/15 px-3 py-1 text-xs font-bold">
                <CheckCircle2 className="h-4 w-4" />
                {tr("scanned")}
              </div>
              {getPriorityScanLetter(currentPriorityBale.color) && (
                <span
                  className="font-black text-[clamp(4.5rem,9vw,7rem)] leading-none"
                  style={{ color: getPriorityScanLetterInk(currentPriorityBale.color) }}
                  data-testid="current-priority-letter"
                  aria-label={"Letter " + getPriorityScanLetter(currentPriorityBale.color)}
                >
                  {getPriorityScanLetter(currentPriorityBale.color)}
                </span>
              )}
              <div className="max-w-full truncate font-mono text-lg font-bold">
                {currentPriorityBale.referenceNumber}
              </div>
              <p className="text-xs font-semibold">
                {tr("priorityNumber", { priority: currentPriorityBale.priority })} ·{" "}
                {tr("loadingNumber", { orderId: currentPriorityBale.orderId })}
              </p>
            </div>
          ) : (
            <div className="flex h-full min-h-[230px] flex-col items-center justify-center gap-3 p-6 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-blue-200 bg-blue-50 text-blue-500 dark:border-blue-400/30 dark:bg-blue-500/10 dark:text-blue-300">
                <ScanLine className="h-8 w-8" />
              </span>
              <h3 className="font-bold text-slate-800 dark:text-slate-100">{tr("currentPriority")}</h3>
              <p className="max-w-xs text-sm text-slate-500 dark:text-slate-400">{tr("scanToBegin")}</p>
            </div>
          )}
        </section>
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-blue-400/20 dark:bg-[hsl(var(--factory-hue)_64%_12%)]/95">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/80 px-4 py-3 dark:border-blue-400/20 dark:bg-gradient-to-r dark:from-[hsl(var(--factory-hue)_60%_18%)] dark:to-[hsl(var(--factory-hue)_56%_14%)] sm:px-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-sky-300">
              <Layers className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-lg font-bold tracking-tight">{tr("priorityQueue")}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">{tr("firstRowActive")}</p>
            </div>
          </div>
          <Badge className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1 font-semibold text-blue-800 shadow-none dark:border-blue-500/30 dark:bg-blue-500/20 dark:text-blue-200">
            {activeQueue.length} {tr("priorityQueue")}
          </Badge>
        </div>

        {isLoading ? (
          <div className="space-y-2 p-4">
            {[1, 2, 3].map((item) => (
              <Skeleton key={item} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : activeQueue.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">{tr("noPrioritiesEnabled")}</div>
        ) : (
          <div className="px-2 pb-2 sm:px-3">
            <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_4.5rem] gap-3 border-b border-slate-200 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:text-slate-400 sm:grid-cols-[5rem_minmax(0,1fr)_6rem_6rem]">
              <span>#</span>
              <span>{tr("customerLoading", { orderId: "" }).replace("#", "").trim()}</span>
              <span className="text-right">{tr("scanned")}</span>
              <span className="hidden text-right sm:block">{tr("active")}</span>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
              {activeQueue.map((item, index) => (
                <div
                  key={item.id}
                  className={[
                    "grid grid-cols-[3.5rem_minmax(0,1fr)_4.5rem] items-center gap-3 rounded-lg px-3 py-2.5 transition-colors sm:grid-cols-[5rem_minmax(0,1fr)_6rem_6rem]",
                    index === 0
                      ? "border border-emerald-300 bg-emerald-50/90 dark:border-emerald-500/65 dark:bg-emerald-500/15"
                      : "hover:bg-blue-50/80 dark:hover:bg-blue-400/10",
                  ].join(" ")}
                  data-testid={"priority-queue-row-" + item.orderId}
                >
                  <span
                    className={[
                      "w-fit rounded-lg px-2 py-1 text-sm font-bold tabular-nums",
                      index === 0
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/25 dark:text-emerald-200"
                        : "bg-slate-100 text-slate-600 dark:bg-slate-700/60 dark:text-slate-300",
                    ].join(" ")}
                  >
                    #{item.priority}
                  </span>
                  <div className="flex min-w-0 items-center gap-3">
                    <PriorityScanColorLetter color={item.color} />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-bold text-slate-900 dark:text-slate-100">
                        {item.load?.customerName || tr("loadingNumber", { orderId: item.orderId })}
                      </div>
                      <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {tr("loadingNumber", { orderId: item.orderId })}
                        {item.load?.proformaName ? " · " + item.load.proformaName : ""}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-base font-bold tabular-nums text-slate-900 dark:text-slate-100">
                      {item.load?.totalQtyBales ?? 0}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">{tr("scanned")}</div>
                  </div>
                  <div className="hidden justify-end sm:flex">
                    {index === 0 && (
                      <Badge className="gap-1 rounded-full border border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-500/50 dark:bg-emerald-600/25 dark:text-emerald-200">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {tr("active")}
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="min-h-[220px] flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-blue-400/20 dark:bg-[hsl(var(--factory-hue)_64%_12%)]/95">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/80 px-4 py-3 dark:border-blue-400/20 dark:bg-[hsl(var(--factory-hue)_60%_16%)] sm:px-5">
          <div>
            <h3 className="font-bold">{tr("thisSession")}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {historyView === "condensed" ? "Grouped by product name" : tr("referenceProductOnly")}
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-600 dark:bg-[hsl(var(--factory-hue)_74%_10%)]">
            <Button
              type="button"
              size="sm"
              variant={historyView === "condensed" ? "secondary" : "ghost"}
              className="rounded-lg"
              onClick={() => setHistoryView("condensed")}
              data-testid="button-priority-history-condensed"
            >
              Condensed
            </Button>
            <Button
              type="button"
              size="sm"
              variant={historyView === "detailed" ? "secondary" : "ghost"}
              className="rounded-lg"
              onClick={() => setHistoryView("detailed")}
              data-testid="button-priority-history-detailed"
            >
              Detailed
            </Button>
          </div>
        </div>
        {sessionScans.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center text-slate-500 dark:text-slate-400">
            <ScanLine className="h-10 w-10 opacity-30" />
            <p className="mt-2 text-sm">{tr("scanToBegin")}</p>
          </div>
        ) : (
          <>
            {historyView === "condensed" ? (
              <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
                {condensedSessionScans.map((group) => (
                  <div
                    key={group.name.toLocaleLowerCase("en-US")}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-blue-400/5"
                  >
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{group.name}</div>
                      {group.articleCode && (
                        <div className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                          {group.articleCode}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {group.colors.map((color) => (
                        <PriorityScanColorLetter key={color} color={color} size="sm" />
                      ))}
                    </div>
                    <Badge variant="secondary" className="shrink-0">
                      {group.count} {tr("scanned")}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
                {sessionScans.map((scan) => (
                  <div
                    key={scan.id}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-blue-400/5"
                  >
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <div className="min-w-[150px] font-mono font-medium">{scan.referenceNumber}</div>
                    <div className="min-w-0 flex-1 truncate text-sm">{scan.productName || tr("unnamedProduct")}</div>
                    <div className="flex shrink-0 items-center gap-2">
                      <PriorityScanColorLetter color={scan.color} size="sm" />
                      <Badge variant="outline">
                        {tr("priorityNumber", { priority: scan.priority })} ·{" "}
                        {tr("loadingNumber", { orderId: scan.orderId })}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50/80 px-4 py-3 text-sm dark:border-slate-700 dark:bg-[hsl(var(--factory-hue)_60%_16%)]">
              <span className="font-medium">Total scanned bales</span>
              <Badge variant="secondary" data-testid="priority-scan-total">
                {sessionScans.length}
              </Badge>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
