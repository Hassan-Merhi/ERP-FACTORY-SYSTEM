import { getErrorDetails } from "@shared/errorUtils";
import { useState, useEffect, useCallback } from "react";
import { OFFLINE_MODE_ENABLED } from "@/lib/featureFlags";
import {
  Download,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  WifiOff,
  RefreshCw,
  Shield,
  Package,
  ShoppingCart,
  Factory,
  Globe,
  ChevronDown,
  ChevronUp,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { useConnectivity } from "@/contexts/ConnectivityContext";
import { useCompany } from "@/contexts/CompanyContext";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { applicationEnglishTranslations } from "@/i18n/applicationTranslations";
import { buildPacks, type PrepProgress, type OfflineReadiness } from "@/lib/offlinePrep";
import {
  getOfflineReadGrant,
  getVerifiedOfflineReadScope,
  isVerifiedOfflineReadVaultUnlocked,
  lockVerifiedOfflineReadVault,
  unlockVerifiedOfflineReadVault,
} from "@/lib/offline/offlineReadCache";
import { getScopedOfflineReadiness, runScopedOfflinePrep } from "@/lib/offline/scopedOfflinePrep";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(ts: number | null): string {
  if (!ts) return "Never";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const PACK_ICONS: Record<string, React.ElementType> = {
  shared: Globe,
  erp: Shield,
  pos: ShoppingCart,
  factory: Factory,
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Feature-flag gate. Kept as its own component with no hooks of its own so the
 * early return is legal: the panel below must be able to call its hooks
 * unconditionally. Returning null from here rather than short-circuiting inside
 * the panel also preserves what the flag is for — with the panel unmounted,
 * none of its polling or IndexedDB access is set up at all.
 */
export function OfflinePrepPanel() {
  if (!OFFLINE_MODE_ENABLED) return null;
  return <OfflinePrepPanelContent />;
}

function OfflinePrepPanelContent() {
  const { isOnline } = useConnectivity();
  const language = useOptionalApplicationLanguage();
  const t = language?.t ?? ((key: keyof typeof applicationEnglishTranslations) => applicationEnglishTranslations[key]);
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const companyId: number = selectedCompany?.id ?? 0;
  const packs = buildPacks();

  const [readiness, setReadiness] = useState<OfflineReadiness | null>(null);
  const [progress, setProgress] = useState<PrepProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [vaultPassphrase, setVaultPassphrase] = useState("");
  const [protectedSnapshot, setProtectedSnapshot] = useState(false);
  const [vaultUnlocked, setVaultUnlocked] = useState(false);

  useEffect(() => {
    setVaultPassphrase("");
    setVaultUnlocked(false);
    setProtectedSnapshot(false);
  }, [companyId]);

  const loadReadiness = useCallback(async () => {
    const actor = getVerifiedOfflineReadScope();
    if (!actor || actor.companyId !== companyId) {
      setReadiness(null);
      setProtectedSnapshot(false);
      setVaultUnlocked(false);
      return;
    }
    const [r, grant] = await Promise.all([getScopedOfflineReadiness(actor), getOfflineReadGrant(actor)]);
    setReadiness(r);
    setProtectedSnapshot(grant?.protection === "erp-offline-aes-gcm-v1");
    setVaultUnlocked(isVerifiedOfflineReadVaultUnlocked(actor));
  }, [companyId]);

  useEffect(() => {
    void loadReadiness();
    window.addEventListener("erp:offline-read-scope-verified", loadReadiness);
    return () => window.removeEventListener("erp:offline-read-scope-verified", loadReadiness);
  }, [loadReadiness]);

  const handlePrepare = async () => {
    if (vaultPassphrase.length < 12) {
      toast({
        title: "Encryption passphrase required",
        description: "Use a unique passphrase of at least 12 characters before preparing this device.",
        variant: "destructive",
      });
      return;
    }
    if (!isOnline) {
      toast({
        title: "You're offline",
        description: "Connect to the internet first to prepare offline data.",
        variant: "destructive",
      });
      return;
    }
    setRunning(true);
    setDetailsOpen(true);
    setProgress({
      phase: "sw",
      currentLabel: "Initialising…",
      totalDatasets: 0,
      completedDatasets: 0,
      failedDatasets: 0,
      percent: 0,
      results: [],
      errors: [],
    });

    try {
      const outcome = await runScopedOfflinePrep(
        companyId,
        (p) => setProgress({ ...p }),
        selectedCompany?.companyType ?? "properties",
        vaultPassphrase
      );
      await loadReadiness();
      if (outcome.phase === "done") {
        toast({ title: t("offlineReads.preparedTitle"), description: t("offlineReads.preparedDetail") });
      } else {
        toast({
          title: t("offlineReads.incompleteTitle"),
          description: t("offlineReads.incompleteDetail"),
          variant: "destructive",
        });
      }
    } catch (e) {
      toast({
        title: "Preparation failed",
        description: getErrorDetails(e).optionalMessage || "Unknown error",
        variant: "destructive",
      });
    } finally {
      setVaultPassphrase("");
      setRunning(false);
    }
  };

  const handleUnlock = async () => {
    const unlocked = await unlockVerifiedOfflineReadVault(vaultPassphrase);
    setVaultPassphrase("");
    setVaultUnlocked(unlocked);
    toast({
      title: unlocked ? "Offline snapshots unlocked" : "Unlock failed",
      description: unlocked
        ? "Prepared data is available only while your verified session remains active."
        : "Check your passphrase and your verified session. No saved data was changed.",
      variant: unlocked ? "default" : "destructive",
    });
  };

  // Summarise readiness
  const statusBadge = () => {
    if (running)
      return (
        <Badge variant="outline" className="gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          Preparing…
        </Badge>
      );
    if (!readiness || readiness.preparedAt === null)
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <WifiOff className="h-3 w-3" />
          Not prepared
        </Badge>
      );
    if (readiness.ready && protectedSnapshot && !vaultUnlocked)
      return (
        <Badge variant="outline" className="gap-1">
          <Shield className="h-3 w-3" />
          Prepared · Locked
        </Badge>
      );
    if (readiness.ready)
      return (
        <Badge className="gap-1 bg-green-600 dark:bg-green-700 text-white">
          <CheckCircle2 className="h-3 w-3" />
          {t("offlineReads.readyLabel")}
        </Badge>
      );
    if (readiness.partial)
      return (
        <Badge className="gap-1 bg-amber-500 dark:bg-amber-600 text-white">
          <AlertCircle className="h-3 w-3" />
          Partially Ready
        </Badge>
      );
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3 w-3" />
        Not Ready
      </Badge>
    );
  };

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h3 className="font-semibold text-base">Offline Device Preparation</h3>
          <p className="text-sm text-muted-foreground mt-0.5">{t("offlineReads.intro")}</p>
        </div>
        {statusBadge()}
      </div>

      {/* Last prepared info */}
      {readiness && readiness.preparedAt && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          <span>
            Last prepared:{" "}
            <span className="text-foreground font-medium">{formatRelativeTime(readiness.preparedAt)}</span>
          </span>
          {readiness.completedDatasets > 0 && (
            <span className="text-muted-foreground">
              · {readiness.completedDatasets}/{readiness.totalDatasets} datasets
            </span>
          )}
        </div>
      )}

      {/* Pack status grid (show after first prep) */}
      {readiness && readiness.preparedAt && Object.keys(readiness.packSummary).length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {packs.map((pack) => {
            const summary = readiness.packSummary[pack.id];
            const Icon = PACK_ICONS[pack.id] ?? Package;
            const ok = !!summary && summary.count >= 0;
            return (
              <Card key={pack.id} className="bg-muted/30">
                <CardContent className="p-3 flex flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    <Icon
                      className={`h-3.5 w-3.5 ${ok ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}
                    />
                    <span className="text-xs font-medium">{pack.label.split(" (")[0]}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {ok ? (
                      <span className="text-green-700 dark:text-green-400 font-medium">
                        {summary.count.toLocaleString()} records
                      </span>
                    ) : (
                      <span className="text-destructive">No data</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Encrypted snapshot vault: never store the passphrase or bypass live auth. */}
      <div className="rounded-md border p-3 space-y-2">
        <label htmlFor="offline-vault-passphrase" className="text-sm font-medium">
          Device snapshot encryption passphrase
        </label>
        <Input
          id="offline-vault-passphrase"
          type="password"
          autoComplete="new-password"
          value={vaultPassphrase}
          onChange={(event) => setVaultPassphrase(event.target.value)}
          placeholder="At least 12 characters"
          disabled={running}
        />
        <p className="text-xs text-muted-foreground">
          Required to encrypt each new preparation and unlock saved data. The passphrase is never saved.
          Losing it requires preparing again online. This does not enable offline sign-in.
        </p>
        {readiness?.ready && protectedSnapshot && (
          <div className="flex flex-wrap items-center gap-2">
            {vaultUnlocked ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  lockVerifiedOfflineReadVault();
                  setVaultUnlocked(false);
                }}
              >
                Lock prepared data
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={vaultPassphrase.length < 12} onClick={handleUnlock}>
                Unlock prepared data
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Action button */}
      <Button
        onClick={handlePrepare}
        disabled={running || !isOnline}
        className="w-full sm:w-auto"
        data-testid="button-prepare-offline"
      >
        {running ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Preparing…
          </>
        ) : readiness?.ready ? (
          <>
            <RefreshCw className="h-4 w-4 mr-2" />
            Update offline data
          </>
        ) : (
          <>
            <Download className="h-4 w-4 mr-2" />
            Prepare this device for offline use
          </>
        )}
      </Button>

      {!isOnline && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <WifiOff className="h-3 w-3" />
          You must be online to download offline data.
        </p>
      )}

      {/* Progress section */}
      {progress && progress.phase !== "idle" && (
        <div className="space-y-3 rounded-md border p-4">
          {/* Progress bar */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span className="truncate max-w-[70%]">{progress.currentLabel}</span>
              <span>{progress.percent}%</span>
            </div>
            <Progress value={progress.percent} className="h-2" />
            <div className="flex gap-4 text-xs text-muted-foreground">
              <span>{progress.completedDatasets} completed</span>
              {progress.failedDatasets > 0 && (
                <span className="text-destructive">{progress.failedDatasets} failed</span>
              )}
              <span>of {progress.totalDatasets} datasets</span>
            </div>
          </div>

          {/* Final status banner */}
          {(progress.phase === "done" || progress.phase === "error") && (
            <div
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                progress.phase === "done" && progress.failedDatasets === 0
                  ? "bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 text-green-800 dark:text-green-300"
                  : "bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300"
              }`}
            >
              {progress.phase === "done" && progress.failedDatasets === 0 ? (
                <CheckCircle2 className="h-4 w-4 shrink-0" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0" />
              )}
              <span>
                {progress.phase === "done" && progress.failedDatasets === 0
                  ? t("offlineReads.preparedDetail")
                  : t("offlineReads.incompleteDetail")}
              </span>
            </div>
          )}

          {/* Dataset detail list */}
          {progress.results.length > 0 && (
            <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="text-xs gap-1 h-7 px-2">
                  {detailsOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  {detailsOpen ? "Hide" : "Show"} dataset details
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2 space-y-1 max-h-60 overflow-y-auto pr-1">
                  {packs.map((pack) => {
                    const packResults = progress.results.filter((r) => r.packId === pack.id);
                    if (packResults.length === 0) return null;
                    const Icon = PACK_ICONS[pack.id] ?? Package;
                    return (
                      <div key={pack.id}>
                        <div className="flex items-center gap-1 text-xs font-semibold text-muted-foreground mt-2 mb-1">
                          <Icon className="h-3 w-3" />
                          {pack.label}
                        </div>
                        {packResults.map((r) => (
                          <div key={r.datasetId} className="flex items-center justify-between text-xs py-0.5 pl-4">
                            <div className="flex items-center gap-1.5">
                              {r.success ? (
                                <CheckCircle2 className="h-3 w-3 text-green-600 dark:text-green-400 shrink-0" />
                              ) : (
                                <XCircle className="h-3 w-3 text-destructive shrink-0" />
                              )}
                              <span className={r.success ? "text-foreground" : "text-muted-foreground"}>{r.label}</span>
                            </div>
                            <span className="text-muted-foreground tabular-nums">
                              {r.success ? `${r.count.toLocaleString()} records` : (r.error ?? "failed")}
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Errors */}
          {progress.errors.length > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-1">
              <p className="text-xs font-semibold text-destructive">Errors ({progress.errors.length})</p>
              {progress.errors.map((e, i) => (
                <p key={i} className="text-xs text-muted-foreground">
                  {e}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Pages that still need server */}
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="text-xs gap-1 h-7 px-2 text-muted-foreground">
            <ChevronDown className="h-3 w-3" />
            Which pages still need internet?
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 rounded-md border bg-muted/30 p-3 space-y-3 text-xs text-muted-foreground">
            <div>
              <p className="font-medium text-foreground mb-1">{t("offlineReads.writeLimitTitle")}</p>
              <p>{t("offlineReads.writeLimitDetail")}</p>
            </div>
            <div>
              <p className="font-medium text-foreground mb-1">Features that truly require internet:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Excel / PDF exports — files are generated server-side</li>
                <li>Payroll processing — complex server-side calculations</li>
                <li>Chat &amp; notifications — real-time only</li>
                <li>First login — a valid session must already exist</li>
              </ul>
            </div>
            <p>{t("offlineReads.exactCoverageDetail")}</p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
