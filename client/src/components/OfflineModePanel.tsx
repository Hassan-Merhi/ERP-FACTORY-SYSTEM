/**
 * Standalone browser offline mode (Phase 16): the person's view of what this
 * laptop saved offline, and the controls for it.
 *
 * - connection state and counters (saved locally, waiting, synced, needing a
 *   decision);
 * - sync now, pause and resume delivery;
 * - each record with its status and, when the cloud disagreed, why: try again,
 *   apply anyway (Admin/Developer, overridable codes only; the cloud checks
 *   both again), or discard;
 * - storage used, removing synced records, a recovery copy of unsynced entries;
 * - what works offline and what needs a connection, with the reason.
 *
 * Nothing here can bypass the server: every action is re-checked by the cloud.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Pause, Play, RefreshCw, Trash2, WifiOff, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConnectivity } from "@/contexts/ConnectivityContext";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { applicationEnglishTranslations, type ApplicationTranslationKey } from "@/i18n/applicationTranslations";
import { queryClient } from "@/lib/queryClient";
import { runSync } from "@/lib/syncEngine";
import type { BrowserOperationRecord } from "@/lib/db";
import {
  browserOperationStatus,
  clearFinishedBrowserOperations,
  exportUnsyncedBrowserOperations,
  listBrowserOperations,
  type BrowserActor,
  type BrowserOperationStatus,
} from "@/lib/offline/browserOutbox";
import {
  approveBrowserOperation,
  discardBrowserOperation,
  isBrowserSyncPaused,
  retryBrowserOperation,
  setBrowserSyncPaused,
} from "@/lib/offline/browserSync";
import { OFFLINE_UNAVAILABLE_CATEGORIES, SUPPORTED_OFFLINE_WRITES } from "@/lib/offline/offlineCoverage";
import { getVerifiedOfflineReadScope } from "@/lib/offline/offlineReadCache";

const REVIEWER_ROLES = new Set(["Admin", "Developer"]);

/** The signed-in user and selected company this tab knows (the cloud re-checks before sending). */
function currentActor(): BrowserActor | null {
  const scope = getVerifiedOfflineReadScope();
  if (scope) return scope;
  const user = queryClient.getQueryData<{ id?: string | number }>(["/api/auth/me"]);
  let companyId: number;
  try {
    companyId = Number(localStorage.getItem("selectedCompanyId"));
  } catch {
    companyId = NaN;
  }
  return user?.id && Number.isSafeInteger(companyId) && companyId > 0 ? { companyId, userId: String(user.id) } : null;
}

function currentRole(): string {
  const me = queryClient.getQueryData<{ role?: string | null; currentRole?: string | null }>(["/api/auth/me"]);
  return String(me?.currentRole ?? me?.role ?? "");
}

const STATUS_KEY: Record<BrowserOperationStatus, ApplicationTranslationKey> = {
  "saved-locally": "offlineMode.savedLocally",
  "pending-sync": "offlineMode.pendingSync",
  synced: "offlineMode.synced",
  failed: "offlineMode.failed",
  discarded: "offlineMode.discarded",
};

const STATUS_STYLE: Record<BrowserOperationStatus, string> = {
  "saved-locally": "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  "pending-sync": "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  synced: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "bg-red-500/10 text-red-700 dark:text-red-300",
  discarded: "bg-muted text-muted-foreground",
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function OfflineModePanel() {
  const { isOnline, refreshCounts } = useConnectivity();
  const language = useOptionalApplicationLanguage();
  const t = useCallback(
    (key: ApplicationTranslationKey) => (language?.t ? language.t(key) : applicationEnglishTranslations[key]),
    [language]
  );
  const [actor, setActor] = useState<BrowserActor | null>(() => currentActor());
  const [records, setRecords] = useState<BrowserOperationRecord[]>([]);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const reviewer = REVIEWER_ROLES.has(currentRole());

  const refresh = useCallback(async () => {
    const scope = currentActor();
    setActor(scope);
    if (!scope) {
      setRecords([]);
      return;
    }
    setPaused(isBrowserSyncPaused(scope));
    setRecords(await listBrowserOperations(scope));
    try {
      const estimate = await navigator.storage?.estimate?.();
      if (estimate) setStorage({ usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 });
    } catch {
      setStorage(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener("erp:browser-sync-changed", onChange);
    window.addEventListener("erp:sync", onChange);
    return () => {
      window.removeEventListener("erp:browser-sync-changed", onChange);
      window.removeEventListener("erp:sync", onChange);
    };
  }, [refresh]);

  const counts = useMemo(() => {
    const result: Record<BrowserOperationStatus, number> = {
      "saved-locally": 0,
      "pending-sync": 0,
      synced: 0,
      failed: 0,
      discarded: 0,
    };
    for (const record of records) result[browserOperationStatus(record.state)] += 1;
    return result;
  }, [records]);

  const act = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await work();
    } finally {
      await refresh();
      await refreshCounts();
      setBusy(false);
    }
  };

  const kindTitle = (kind: string): string => {
    const key = `offlineMode.kind.${kind}` as ApplicationTranslationKey;
    return key in applicationEnglishTranslations ? t(key) : kind;
  };

  const explain = (record: BrowserOperationRecord): string | null => {
    const code = record.conflictCode ?? record.lastError;
    if (!code || record.state === "synced") return null;
    const key = `offlineMode.code.${code}` as ApplicationTranslationKey;
    return key in applicationEnglishTranslations
      ? t(key)
      : record.state === "conflict" || record.state === "rejected"
        ? t("offlineMode.code.unknown")
        : null;
  };

  const download = async () => {
    if (!actor) return;
    const rows = await exportUnsyncedBrowserOperations(actor);
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), entries: rows }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `offline-entries-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="space-y-4" data-testid="offline-mode-panel" aria-label={t("offlineMode.title")}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          {isOnline ? <Wifi className="h-4 w-4 text-emerald-600" /> : <WifiOff className="h-4 w-4 text-amber-600" />}
          {t("offlineMode.title")}
          <span className="text-xs font-normal text-muted-foreground" data-testid="offline-mode-connection">
            {isOnline ? t("offlineMode.online") : t("offlineMode.offline")}
            {paused ? ` · ${t("offlineMode.paused")}` : ""}
          </span>
        </h3>
        <p className="text-xs text-muted-foreground">{t("offlineMode.intro")}</p>
      </div>

      {!actor ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("offlineMode.notSignedIn")}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2 text-xs" data-testid="offline-mode-counts">
            {(["saved-locally", "pending-sync", "synced", "failed"] as BrowserOperationStatus[]).map((status) => (
              <div key={status} className={`rounded-md px-2 py-1.5 ${STATUS_STYLE[status]}`}>
                <dt>{t(STATUS_KEY[status])}</dt>
                <dd className="text-base font-semibold" data-testid={`offline-mode-count-${status}`}>
                  {counts[status]}
                </dd>
              </div>
            ))}
          </dl>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !isOnline || paused}
              onClick={() => void act(() => runSync())}
              data-testid="offline-mode-sync-now"
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              {t("offlineMode.syncNow")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void act(async () => setBrowserSyncPaused(actor, !paused))}
              data-testid="offline-mode-pause"
            >
              {paused ? <Play className="h-4 w-4 mr-1" /> : <Pause className="h-4 w-4 mr-1" />}
              {paused ? t("offlineMode.resume") : t("offlineMode.pause")}
            </Button>
          </div>

          {notice && (
            <p role="alert" className="text-xs text-red-700 dark:text-red-300">
              {notice}
            </p>
          )}

          <ul className="space-y-2" data-testid="offline-mode-records">
            {records.filter((record) => record.state !== "discarded").length === 0 && (
              <li className="text-sm text-muted-foreground">{t("offlineMode.empty")}</li>
            )}
            {records
              .filter((record) => record.state !== "discarded")
              .slice(-50)
              .reverse()
              .map((record) => {
                const status = browserOperationStatus(record.state);
                const reason = explain(record);
                return (
                  <li key={record.id} className="border rounded-md p-2 space-y-1" data-testid="offline-mode-record">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">
                        {kindTitle(record.kind)}
                        <span className="text-muted-foreground font-normal"> · {record.label}</span>
                      </span>
                      <span
                        className={`text-[11px] rounded px-1.5 py-0.5 whitespace-nowrap ${STATUS_STYLE[status]}`}
                        data-testid="offline-mode-record-status"
                      >
                        {t(STATUS_KEY[status])}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground font-mono">
                      {new Date(record.capturedAt).toLocaleString()} · {record.id.slice(0, 8)}
                      {record.cloudRef ? ` · ${t("offlineMode.cloudRef")} #${record.cloudRef}` : ""}
                    </p>
                    {reason && <p className="text-xs">{reason}</p>}
                    {(status === "failed" || record.state === "waiting" || record.state === "pending") && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void act(() => retryBrowserOperation(actor, record.id))}
                        >
                          {t("offlineMode.retry")}
                        </Button>
                        {record.state === "conflict" && record.conflictOverridable && reviewer && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void act(() => approveBrowserOperation(actor, record.id))}
                            data-testid="offline-mode-approve"
                          >
                            {t("offlineMode.approve")}
                          </Button>
                        )}
                        {status === "failed" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void act(async () => {
                                const result = await discardBrowserOperation(actor, record.id);
                                if (result === "needs-connection") setNotice(t("offlineMode.discardNeedsConnection"));
                              })
                            }
                            data-testid="offline-mode-discard"
                          >
                            {t("offlineMode.discard")}
                          </Button>
                        )}
                      </div>
                    )}
                    {record.state === "saved" && (
                      <div className="flex pt-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void act(() => discardBrowserOperation(actor, record.id))}
                        >
                          {t("offlineMode.discard")}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
          </ul>

          <div className="border-t pt-3 space-y-2">
            <h4 className="text-xs font-semibold">{t("offlineMode.storageTitle")}</h4>
            {storage && (
              <p className="text-xs text-muted-foreground" data-testid="offline-mode-storage">
                {t("offlineMode.storageUsed")}: {formatBytes(storage.usage)} / {formatBytes(storage.quota)}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || counts.synced === 0}
                onClick={() => void act(() => clearFinishedBrowserOperations(actor))}
                data-testid="offline-mode-clear-synced"
              >
                <Trash2 className="h-4 w-4 mr-1" />
                {t("offlineMode.clearSynced")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || counts["saved-locally"] + counts["pending-sync"] + counts.failed === 0}
                onClick={() => void download()}
                data-testid="offline-mode-recovery"
              >
                <Download className="h-4 w-4 mr-1" />
                {t("offlineMode.recovery")}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">{t("offlineMode.recoveryHelp")}</p>
          </div>
        </>
      )}

      <div className="border-t pt-3 space-y-1">
        <h4 className="text-xs font-semibold">{t("offlineMode.availableTitle")}</h4>
        <ul className="text-xs text-muted-foreground list-disc ms-4" data-testid="offline-mode-supported">
          {SUPPORTED_OFFLINE_WRITES.map((write) => (
            <li key={write.kind}>{kindTitle(write.kind)}</li>
          ))}
        </ul>
        <h4 className="text-xs font-semibold pt-2">{t("offlineMode.unavailableTitle")}</h4>
        <ul className="text-xs text-muted-foreground list-disc ms-4" data-testid="offline-mode-unavailable">
          {OFFLINE_UNAVAILABLE_CATEGORIES.map((category) => (
            <li key={category}>{t(`offlineMode.unavailable.${category}` as ApplicationTranslationKey)}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
