import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, ScanLine } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { visibleTabInterval } from "@/lib/queryPolicies";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useCompany } from "@/contexts/CompanyContext";
import { translatePriorityScanText, type PriorityScanTranslationKey } from "@/i18n/priorityScanTranslations";

const PRIORITY_SCAN_CONFIGS_URL = "/api/factory/customer-orders/loading-list/priority-scan-configs";
const PENDING_LOADS_URL = "/api/factory/customer-orders?status=LOADING&profile=summary&pageSize=250";
const PRIORITY_SCAN_ROUTE_URL = "/api/factory/customer-orders/loading-list/priority-scan-route";
const PRIORITY_SCAN_HISTORY_URL = `${PRIORITY_SCAN_ROUTE_URL}?view=today-history`;
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

interface SessionScan {
  id: number;
  referenceNumber: string;
  productName: string | null;
  articleCode: string | null;
  orderId: number;
  priority: number;
  color: string;
  scannedBy: string | null;
  scannedAt: string;
}

interface PriorityScanHistoryResponse {
  businessDate: string;
  serverNow: string;
  scans: SessionScan[];
}

interface ScanFeedback {
  type: "success" | "error" | "warn";
  referenceNumber: string;
  message: string;
}

export default function FactoryPriorityScan() {
  const { language } = useApplicationLanguage();
  const { selectedCompany } = useCompany();
  const tr = useCallback(
    (key: PriorityScanTranslationKey, params?: Record<string, string | number>) =>
      translatePriorityScanText(key, language, params),
    [language]
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanSubmissionInFlightRef = useRef(false);
  const [scanInput, setScanInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);
  const [priorityFlashVisible, setPriorityFlashVisible] = useState(false);
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
    refetchInterval: visibleTabInterval(1_000),
    refetchIntervalInBackground: false,
  });
  const sessionScans = priorityHistory?.scans ?? [];

  const condensedSessionScans = useMemo(() => {
    const grouped = new Map<
      string,
      { name: string; articleCode: string | null; count: number; latestScannedAt: string }
    >();

    for (const scan of sessionScans) {
      const name = scan.productName?.trim() || tr("unnamedProduct");
      const key = name.toLocaleLowerCase("en-US");
      const existing = grouped.get(key);
      if (existing) {
        existing.count += 1;
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
        });
      }
    }

    return Array.from(grouped.values()).sort(
      (a, b) => Date.parse(b.latestScannedAt) - Date.parse(a.latestScannedAt)
    );
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

  const currentPriorityBale = priorityFlashVisible ? latestScannedBale : null;

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  useEffect(
    () => () => {
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    },
    []
  );

  const showFeedback = (next: ScanFeedback) => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setFeedback(next);
    feedbackTimerRef.current = setTimeout(() => setFeedback(null), 5000);
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

  const handleScan = async () => {
    const referenceNumber = scanInput.trim().toUpperCase();
    if (!referenceNumber || scanning || scanSubmissionInFlightRef.current) return;

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
          type: "error",
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
    <div className="flex flex-col h-full p-5 gap-5">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(300px,0.6fr)]">
        <section className="rounded-xl border bg-card p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2">
                <ScanLine className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold">{tr("priorityScan")}</h2>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{tr("scanDescription")}</p>
            </div>
            <Badge variant="outline">
              {tr(activeQueue.length === 1 ? "activePriority" : "activePriorities", { count: activeQueue.length })}
            </Badge>
          </div>

          <div className="mt-5 flex gap-2">
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
              className="h-12 text-base font-mono"
              disabled={scanning}
              data-testid="input-priority-scan"
            />
            <Button
              type="button"
              className="h-12 px-5"
              onClick={() => void handleScan()}
              disabled={scanning || !scanInput.trim()}
              data-testid="button-priority-scan"
            >
              <ScanLine className="h-4 w-4 mr-2" />
              {scanning ? tr("checking") : tr("scan")}
            </Button>
          </div>

          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            <p>{tr("routeHint")}</p>
            <p>{tr("manualExceptionHint")}</p>
          </div>

          {feedback && (
            <div
              className={[
                "mt-4 rounded-lg border px-4 py-3 flex items-start gap-3",
                feedback.type === "success"
                  ? "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/30 dark:text-green-100"
                  : feedback.type === "warn"
                    ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
                    : "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-100",
              ].join(" ")}
              data-testid="priority-scan-feedback"
            >
              {feedback.type === "success" ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
              )}
              <div className="min-w-0">
                <div className="font-semibold font-mono">{feedback.referenceNumber}</div>
                <div className="text-sm">{feedback.message}</div>
              </div>
            </div>
          )}
        </section>

        <section
          className={[
            "rounded-xl border min-h-[230px] overflow-hidden transition-colors duration-150",
            currentPriorityBale ? "" : "bg-card",
          ].join(" ")}
          style={currentPriorityBale ? { backgroundColor: currentPriorityBale.color } : undefined}
          aria-label={currentPriorityBale ? tr("priorityColor", { color: currentPriorityBale.color }) : undefined}
          data-testid="current-priority-color"
        >
          {currentPriorityBale && (
            <span className="sr-only">
              {currentPriorityBale.referenceNumber} · {tr("priorityNumber", { priority: currentPriorityBale.priority })}{" "}
              · {tr("loadingNumber", { orderId: currentPriorityBale.orderId })}
            </span>
          )}
        </section>
      </div>

      <section className="rounded-xl border overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/20 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">{tr("priorityQueue")}</h3>
            <p className="text-xs text-muted-foreground">{tr("firstRowActive")}</p>
          </div>
          <Badge variant="secondary">{activeQueue.length}</Badge>
        </div>

        {isLoading ? (
          <div className="p-4 space-y-2">
            {[1, 2, 3].map((item) => (
              <Skeleton key={item} className="h-14 w-full" />
            ))}
          </div>
        ) : activeQueue.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">{tr("noPrioritiesEnabled")}</div>
        ) : (
          <div className="divide-y">
            {activeQueue.map((item, index) => (
              <div
                key={item.id}
                className={["px-4 py-3 flex items-center gap-4", index === 0 ? "bg-primary/5" : ""].join(" ")}
                data-testid={`priority-queue-row-${item.orderId}`}
              >
                <div className="w-20 shrink-0 font-semibold">#{item.priority}</div>
                <span
                  className="h-5 w-5 rounded-full border border-black/10 shrink-0"
                  style={{ backgroundColor: item.color }}
                  aria-label={tr("priorityColor", { color: item.color })}
                />
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">
                    {item.load?.customerName || tr("loadingNumber", { orderId: item.orderId })}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {tr("loadingNumber", { orderId: item.orderId })}
                    {item.load?.proformaName ? ` · ${item.load.proformaName}` : ""}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-medium">{item.load?.totalQtyBales ?? 0}</div>
                  <div className="text-xs text-muted-foreground">{tr("scanned")}</div>
                </div>
                {index === 0 && <Badge>{tr("active")}</Badge>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border overflow-hidden flex-1 min-h-[220px]">
        <div className="px-4 py-3 border-b bg-muted/20 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="font-semibold">{tr("thisSession")}</h3>
            <p className="text-xs text-muted-foreground">
              {historyView === "condensed" ? "Grouped by product name" : tr("referenceProductOnly")}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant={historyView === "condensed" ? "secondary" : "ghost"}
              onClick={() => setHistoryView("condensed")}
              data-testid="button-priority-history-condensed"
            >
              Condensed
            </Button>
            <Button
              type="button"
              size="sm"
              variant={historyView === "detailed" ? "secondary" : "ghost"}
              onClick={() => setHistoryView("detailed")}
              data-testid="button-priority-history-detailed"
            >
              Detailed
            </Button>
          </div>
        </div>
        {sessionScans.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center text-muted-foreground">
            <ScanLine className="h-10 w-10 opacity-30" />
            <p className="mt-2 text-sm">{tr("scanToBegin")}</p>
          </div>
        ) : (
          <>
            {historyView === "condensed" ? (
              <div className="divide-y">
                {condensedSessionScans.map((group) => (
                  <div key={group.name.toLocaleLowerCase("en-US")} className="px-4 py-3 flex items-center gap-3">
                    <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{group.name}</div>
                      {group.articleCode && (
                        <div className="text-xs text-muted-foreground font-mono truncate">{group.articleCode}</div>
                      )}
                    </div>
                    <Badge variant="secondary">{group.count} scanned</Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="divide-y">
                {sessionScans.map((scan) => (
                  <div key={scan.id} className="px-4 py-3 flex items-center gap-3">
                    <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                    <div className="font-mono font-medium min-w-[150px]">{scan.referenceNumber}</div>
                    <div className="flex-1 min-w-0 text-sm truncate">
                      {scan.productName || tr("unnamedProduct")}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className="h-3.5 w-3.5 rounded-full border border-black/10"
                        style={{ backgroundColor: scan.color }}
                        aria-hidden="true"
                      />
                      <Badge variant="outline">
                        {tr("priorityNumber", { priority: scan.priority })} ·{" "}
                        {tr("loadingNumber", { orderId: scan.orderId })}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="px-4 py-3 border-t bg-muted/20 flex items-center justify-between text-sm">
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
