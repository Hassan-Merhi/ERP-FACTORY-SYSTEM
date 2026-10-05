import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, PackageCheck, ScanLine } from "lucide-react";

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
const SESSION_SCAN_STORAGE_PREFIX = "factory-priority-scan-session";

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
  orderId: number;
  priority: number;
  color: string;
}

interface StoredSessionScans {
  dateKey: string;
  scans: SessionScan[];
}

function getLocalCalendarDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getSessionScanStorageKey(companyId: number): string {
  return `${SESSION_SCAN_STORAGE_PREFIX}:${companyId}`;
}

function readStoredSessionScans(storageKey: string, dateKey: string): SessionScan[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];

    const stored = JSON.parse(raw) as Partial<StoredSessionScans>;
    if (stored.dateKey !== dateKey || !Array.isArray(stored.scans)) {
      window.localStorage.removeItem(storageKey);
      return [];
    }

    return stored.scans.slice(0, 30) as SessionScan[];
  } catch {
    window.localStorage.removeItem(storageKey);
    return [];
  }
}

function persistStoredSessionScans(storageKey: string, dateKey: string, scans: SessionScan[]) {
  try {
    const payload: StoredSessionScans = {
      dateKey,
      scans: scans.slice(0, 30),
    };
    window.localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch {
    // Scanning must continue even when browser storage is unavailable.
  }
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
  const [sessionDateKey, setSessionDateKey] = useState(() => getLocalCalendarDateKey());
  const [sessionScans, setSessionScans] = useState<SessionScan[]>([]);
  const selectedCompanyId = selectedCompany?.id ?? null;
  const sessionStorageKey = useMemo(
    () => (selectedCompanyId ? getSessionScanStorageKey(selectedCompanyId) : null),
    [selectedCompanyId]
  );

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

  const current = activeQueue[0];

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

  useEffect(() => {
    if (!sessionStorageKey) {
      setSessionScans([]);
      return;
    }
    setSessionScans(readStoredSessionScans(sessionStorageKey, sessionDateKey));
  }, [sessionDateKey, sessionStorageKey]);

  useEffect(() => {
    const refreshDate = () => {
      const nextDateKey = getLocalCalendarDateKey();
      setSessionDateKey((currentDateKey) => (currentDateKey === nextDateKey ? currentDateKey : nextDateKey));
    };

    refreshDate();
    const timer = window.setInterval(refreshDate, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const showFeedback = (next: ScanFeedback) => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setFeedback(next);
    feedbackTimerRef.current = setTimeout(() => setFeedback(null), 5000);
  };

  const focusScanner = () => {
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const resolvePriorityRoute = async (referenceNumber: string): Promise<PriorityRouteResolution> => {
    const response = await apiRequest(
      "GET",
      `/api/factory/customer-orders/loading-list/priority-scan-route?code=${encodeURIComponent(referenceNumber)}`
    );
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
      const scan: SessionScan = {
        id: routed.baleId,
        referenceNumber: routed.referenceNumber,
        productName: routed.productName,
        orderId: routed.target.orderId,
        priority: routed.target.priority,
        color: routed.target.color,
      };
      const scanDateKey = getLocalCalendarDateKey();
      if (scanDateKey !== sessionDateKey) setSessionDateKey(scanDateKey);
      setSessionScans((currentScans) => {
        const nextScans = [
          scan,
          ...(scanDateKey === sessionDateKey ? currentScans : []),
        ].slice(0, 30);
        if (sessionStorageKey) {
          persistStoredSessionScans(sessionStorageKey, scanDateKey, nextScans);
        }
        return nextScans;
      });

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
      showFeedback({
        type: "error",
        referenceNumber,
        message: error instanceof Error ? error.message : tr("couldNotRoute"),
      });
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

        <section className="rounded-xl border bg-card p-5">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {tr("currentPriority")}
          </div>
          {isLoading ? (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-7 w-32" />
              <Skeleton className="h-5 w-48" />
            </div>
          ) : current ? (
            <div className="mt-3">
              <div className="flex items-center gap-3">
                <span
                  className="h-8 w-8 rounded-full border border-black/10 shadow-sm"
                  style={{ backgroundColor: current.color }}
                  aria-hidden="true"
                />
                <div>
                  <div className="text-2xl font-bold">{tr("priorityNumber", { priority: current.priority })}</div>
                  <div className="text-sm text-muted-foreground">
                    {tr("loadingNumber", { orderId: current.orderId })}
                  </div>
                </div>
              </div>
              <div className="mt-4 text-sm">
                <div className="font-medium">
                  {current.load?.customerName || tr("customerLoading", { orderId: current.orderId })}
                </div>
                <div className="text-muted-foreground">
                  {current.load?.proformaName || tr("proformaNumber", { proformaId: current.proformaIdUsed ?? "—" })}
                </div>
                <div className="mt-2 flex items-center gap-2 text-muted-foreground">
                  <PackageCheck className="h-4 w-4" />
                  {tr("balesAlreadyScanned", { count: current.load?.totalQtyBales ?? 0 })}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-3 text-sm text-muted-foreground">{tr("noPriorityQueue")}</div>
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
        <div className="px-4 py-3 border-b bg-muted/20">
          <h3 className="font-semibold">{tr("thisSession")}</h3>
          <p className="text-xs text-muted-foreground">{tr("referenceProductOnly")}</p>
        </div>
        {sessionScans.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center text-muted-foreground">
            <ScanLine className="h-10 w-10 opacity-30" />
            <p className="mt-2 text-sm">{tr("scanToBegin")}</p>
          </div>
        ) : (
          <div className="divide-y">
            {sessionScans.map((scan) => (
              <div key={scan.id} className="px-4 py-3 flex items-center gap-3">
                <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                <div className="font-mono font-medium min-w-[150px]">{scan.referenceNumber}</div>
                <div className="flex-1 min-w-0 text-sm truncate">{scan.productName || tr("unnamedProduct")}</div>
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
      </section>
    </div>
  );
}
