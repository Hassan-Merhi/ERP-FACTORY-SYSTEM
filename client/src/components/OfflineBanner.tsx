import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Clock, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
import { OFFLINE_MODE_ENABLED } from "@/lib/featureFlags";
import { useConnectivity } from "@/contexts/ConnectivityContext";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { db } from "@/lib/db";
import { getQueue } from "@/lib/offlineQueue";
import { getVerifiedOfflineReadScope } from "@/lib/offline/offlineReadCache";
import { listOfflineOperations } from "@/lib/offline/durableOutbox";
import { runSync } from "@/lib/syncEngine";
import type { OfflineOperation } from "@/lib/offline/operationContract";

interface VisibleQueue {
  operations: OfflineOperation[];
  legacyCount: number;
  scoped: boolean;
}

const EMPTY: VisibleQueue = { operations: [], legacyCount: 0, scoped: false };
const UNRESOLVED = new Set(["pending", "sending"]);
const REVIEW = new Set(["conflict", "rejected", "needs_review"]);

function operationSummary(state: OfflineOperation["state"]): string {
  switch (state) {
    case "pending":
      return "On this device · not yet accepted by LAN";
    case "sending":
      return "Delivery uncertain · original request retained";
    case "acknowledged":
      return "LAN acknowledged · cloud posting NOT verified";
    case "conflict":
      return "Conflict · operator review required";
    case "rejected":
      return "Blocked · server rejected the request";
    case "needs_review":
      return "Quarantined · never automatically retried";
  }
}

/**
 * The legacy localStorage and IndexedDB queues were not actor-scoped or
 * transactionally idempotent. Phase 9 MUST NEVER replay them from this panel.
 * The only delivery action uses the versioned, validated durable outbox.
 */
export function OfflineBanner() {
  if (!OFFLINE_MODE_ENABLED) return null;
  return <OfflineBannerInner />;
}

function OfflineBannerInner() {
  const { isOnline, isSyncing, refreshCounts } = useConnectivity();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<VisibleQueue>(EMPTY);
  const revision = useRef(0);
  const invalidatePendingReads = useCallback(() => {
    revision.current += 1;
  }, []);

  const refresh = useCallback(async () => {
    const current = ++revision.current;
    const actor = getVerifiedOfflineReadScope();
    try {
      const [legacyIdb, operations] = await Promise.all([
        db.syncQueue.count(),
        actor ? listOfflineOperations(actor) : Promise.resolve([] as OfflineOperation[]),
      ]);
      const latest = getVerifiedOfflineReadScope();
      if (current !== revision.current) return;
      // The verified user/company may have changed during an IndexedDB read.
      if (!actor || !latest || actor.companyId !== latest.companyId || actor.userId !== latest.userId) {
        setSnapshot({ operations: [], legacyCount: legacyIdb + getQueue().length, scoped: false });
        return;
      }
      setSnapshot({
        operations,
        legacyCount: legacyIdb + getQueue().length,
        scoped: true,
      });
    } catch {
      if (current === revision.current) setSnapshot(EMPTY);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onRefresh = () => {
      void refresh();
    };
    window.addEventListener("erp:sync", onRefresh);
    window.addEventListener("erp:offline-read-scope-verified", onRefresh);
    window.addEventListener("erp:offline-queue-changed", onRefresh);
    window.addEventListener("focus", onRefresh);
    window.addEventListener("storage", onRefresh);
    return () => {
      invalidatePendingReads();
      window.removeEventListener("erp:sync", onRefresh);
      window.removeEventListener("erp:offline-read-scope-verified", onRefresh);
      window.removeEventListener("erp:offline-queue-changed", onRefresh);
      window.removeEventListener("focus", onRefresh);
      window.removeEventListener("storage", onRefresh);
    };
  }, [refresh, invalidatePendingReads]);

  const pending = snapshot.operations.filter((item) => UNRESOLVED.has(item.state)).length;
  const review = snapshot.operations.filter((item) => REVIEW.has(item.state)).length;
  const acknowledged = snapshot.operations.filter((item) => item.state === "acknowledged").length;
  const legacy = snapshot.legacyCount;
  const visible = !isOnline || pending > 0 || review > 0 || legacy > 0 || (drawerOpen && acknowledged > 0);
  const retry = async () => {
    if (busy || isSyncing || !isOnline || !snapshot.scoped || pending === 0) return;
    setBusy(true);
    try {
      await runSync();
    } finally {
      await refresh();
      await refreshCounts();
      setBusy(false);
    }
  };

  if (!visible) return null;
  return (
    <>
      <button
        type="button"
        className="w-full px-3 py-2 flex items-center gap-2 text-sm border-b bg-amber-500/10 text-amber-800 dark:text-amber-300 text-left"
        onClick={() => setDrawerOpen(true)}
        data-testid="offline-banner"
      >
        {isOnline ? <ShieldAlert className="h-4 w-4 shrink-0" /> : <WifiOff className="h-4 w-4 shrink-0" />}
        <span className="flex-1">
          {!isOnline ? "Connection unavailable" : "Offline work requires review"}
          {pending > 0 ? ` · ${pending} device-pending` : ""}
          {review > 0 ? ` · ${review} needing review` : ""}
          {legacy > 0 ? ` · ${legacy} blocked legacy records` : ""}
        </span>
      </button>
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md flex flex-col">
          <SheetHeader>
            <SheetTitle>Offline delivery evidence</SheetTitle>
            <SheetDescription>
              A saved request is not server confirmation. A LAN acknowledgement is not proof of cloud posting.
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-3 overflow-y-auto flex-1 py-3">
            {legacy > 0 && (
              <div role="alert" className="border rounded-md p-3 space-y-1" data-testid="offline-legacy-blocked">
                <p className="font-medium text-sm flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  {legacy} legacy records blocked
                </p>
                <p className="text-xs text-muted-foreground">
                  Old browser queues lack verified user/company identity and atomic replay evidence. They are preserved
                  on this device for supervised recovery, NOT sent, retried, or deleted.
                </p>
              </div>
            )}
            {!snapshot.scoped && (
              <p role="status" className="text-sm text-muted-foreground">
                Verify your current account and company before viewing or delivering saved vouchers.
              </p>
            )}
            {snapshot.scoped && snapshot.operations.length === 0 && (
              <p className="text-sm text-muted-foreground">No durable voucher requests for this account.</p>
            )}
            {snapshot.scoped &&
              snapshot.operations
                .slice(-30)
                .reverse()
                .map((item) => (
                  <div key={item.id} className="border rounded-md p-3 space-y-1" data-testid="offline-durable-record">
                    <p className="font-mono text-xs flex items-center gap-2">
                      <Clock className="h-3 w-3" /> {item.id.slice(0, 8)} · {item.clientDate}
                    </p>
                    <p className="text-xs">{operationSummary(item.state)}</p>
                  </div>
                ))}
          </div>
          <div className="border-t pt-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              Only vetted durable Journal requests are eligible for retry. Inventory, POS, production, payments and
              attachments remain blocked pending reconciliation.
            </p>
            <Button
              variant="outline"
              onClick={() => void retry()}
              disabled={!isOnline || busy || isSyncing || !snapshot.scoped || pending === 0}
              data-testid="offline-safe-retry"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              {busy || isSyncing ? "Checking verified outbox…" : "Retry vetted saved vouchers"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
