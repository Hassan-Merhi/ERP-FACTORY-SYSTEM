import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, PackageCheck, ScanLine } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { visibleTabInterval } from "@/lib/queryPolicies";
import { apiRequest, queryClient } from "@/lib/queryClient";

const PRIORITY_SCAN_CONFIGS_URL = "/api/factory/customer-orders/loading-list/priority-scan-configs";
const PENDING_LOADS_URL = "/api/factory/customer-orders?status=LOADING&profile=summary&pageSize=250";

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

interface ScanFeedback {
  type: "success" | "error" | "warn";
  referenceNumber: string;
  message: string;
}

export default function FactoryPriorityScan() {
  const inputRef = useRef<HTMLInputElement>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scanInput, setScanInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);
  const [sessionScans, setSessionScans] = useState<SessionScan[]>([]);

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

  const showFeedback = (next: ScanFeedback) => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setFeedback(next);
    feedbackTimerRef.current = setTimeout(() => setFeedback(null), 5000);
  };

  const focusScanner = () => {
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const resolvePriorityRoute = async (referenceNumber: string): Promise<PriorityRouteResolution> => {
    const response = await fetch(
      `/api/factory/customer-orders/loading-list/priority-scan-route?code=${encodeURIComponent(referenceNumber)}`,
      { credentials: "include" }
    );
    if (!response.ok) {
      let message = "Could not route this reference.";
      try {
        const payload = (await response.json()) as { message?: string };
        if (payload.message) message = payload.message;
      } catch {
        // Keep the stable fallback.
      }
      const error = new Error(message) as PriorityScanRequestError;
      error.status = response.status;
      throw error;
    }
    return response.json() as Promise<PriorityRouteResolution>;
  };

  const allocatePriorityScan = async (referenceNumber: string): Promise<PriorityScanAllocation> => {
    const maxAttempts = Math.max(1, activeQueue.length + 1);

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
          requestError.status === 400 && (requestError.overloaded === true || requestError.notInProforma === true);
        if (!routeMayHaveChanged || attempt === maxAttempts - 1) throw error;
      }
    }

    throw new Error("Could not find an available Priority Scan destination.");
  };

  const handleScan = async () => {
    const referenceNumber = scanInput.trim().toUpperCase();
    if (!referenceNumber || scanning) return;

    setScanInput("");

    if (activeQueue.length === 0) {
      showFeedback({
        type: "error",
        referenceNumber,
        message: "No active Priority Scan loading is configured.",
      });
      focusScanner();
      return;
    }

    if (sessionScans.some((scan) => scan.referenceNumber === referenceNumber)) {
      showFeedback({
        type: "warn",
        referenceNumber,
        message: "Already scanned in this Priority Scan session.",
      });
      focusScanner();
      return;
    }

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
      setSessionScans((currentScans) => [scan, ...currentScans].slice(0, 30));

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [PENDING_LOADS_URL] }),
        queryClient.invalidateQueries({ queryKey: [PRIORITY_SCAN_CONFIGS_URL] }),
      ]);

      const completedThisLoading = routed.advance?.completedOrderIds.includes(routed.target.orderId) === true;
      const message = completedThisLoading
        ? routed.advance?.activeOrderId
          ? `Loading #${routed.target.orderId} is satisfied. Advanced to Loading #${routed.advance.activeOrderId}.`
          : `Loading #${routed.target.orderId} is satisfied. Priority queue is complete.`
        : `Added to Priority #${routed.target.priority} — Loading #${routed.target.orderId}.`;

      showFeedback({
        type: "success",
        referenceNumber: routed.referenceNumber,
        message,
      });
    } catch (error) {
      showFeedback({
        type: "error",
        referenceNumber,
        message: error instanceof Error ? error.message : "Could not route this reference.",
      });
    } finally {
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
                <h2 className="text-lg font-semibold">Priority Scan</h2>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Scan a bale reference. This page keeps the queue visible while you work.
              </p>
            </div>
            <Badge variant="outline">{activeQueue.length} active priorit{activeQueue.length === 1 ? "y" : "ies"}</Badge>
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
              placeholder="Scan reference..."
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
              {scanning ? "Checking…" : "Scan"}
            </Button>
          </div>

          <p className="mt-2 text-xs text-muted-foreground">
            Each reference goes to the highest-priority loading that still needs it; satisfied loadings advance automatically.
          </p>

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
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Current priority</div>
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
                  <div className="text-2xl font-bold">Priority #{current.priority}</div>
                  <div className="text-sm text-muted-foreground">Loading #{current.orderId}</div>
                </div>
              </div>
              <div className="mt-4 text-sm">
                <div className="font-medium">
                  {current.load?.customerName || `Customer loading #${current.orderId}`}
                </div>
                <div className="text-muted-foreground">
                  {current.load?.proformaName || `Proforma #${current.proformaIdUsed ?? "—"}`}
                </div>
                <div className="mt-2 flex items-center gap-2 text-muted-foreground">
                  <PackageCheck className="h-4 w-4" />
                  {current.load?.totalQtyBales ?? 0} bales already scanned
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-3 text-sm text-muted-foreground">
              No Priority Scan queue yet. Set colors and priorities from Pending Loadings.
            </div>
          )}
        </section>
      </div>

      <section className="rounded-xl border overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/20 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">Priority queue</h3>
            <p className="text-xs text-muted-foreground">The first row is the active priority.</p>
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
          <div className="p-8 text-center text-sm text-muted-foreground">No loadings have Priority Scan enabled.</div>
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
                  aria-label={`Priority color ${item.color}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">
                    {item.load?.customerName || `Loading #${item.orderId}`}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    Loading #{item.orderId}
                    {item.load?.proformaName ? ` · ${item.load.proformaName}` : ""}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-medium">{item.load?.totalQtyBales ?? 0}</div>
                  <div className="text-xs text-muted-foreground">scanned</div>
                </div>
                {index === 0 && <Badge>Active</Badge>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border overflow-hidden flex-1 min-h-[220px]">
        <div className="px-4 py-3 border-b bg-muted/20">
          <h3 className="font-semibold">This scan session</h3>
          <p className="text-xs text-muted-foreground">Reference and product only.</p>
        </div>
        {sessionScans.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center text-muted-foreground">
            <ScanLine className="h-10 w-10 opacity-30" />
            <p className="mt-2 text-sm">Scan a reference to begin.</p>
          </div>
        ) : (
          <div className="divide-y">
            {sessionScans.map((scan) => (
              <div key={scan.id} className="px-4 py-3 flex items-center gap-3">
                <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                <div className="font-mono font-medium min-w-[150px]">{scan.referenceNumber}</div>
                <div className="flex-1 min-w-0 text-sm truncate">{scan.productName || "Unnamed product"}</div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className="h-3.5 w-3.5 rounded-full border border-black/10"
                    style={{ backgroundColor: scan.color }}
                    aria-hidden="true"
                  />
                  <Badge variant="outline">#{scan.priority} · Loading {scan.orderId}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
