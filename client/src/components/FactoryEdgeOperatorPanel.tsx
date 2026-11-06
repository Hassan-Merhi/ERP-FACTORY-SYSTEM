import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiRequestPrivileged } from "@/lib/queryClient";
import { FactoryEdgeOperatorConfirmDialog, operatorErrorCode } from "@/components/FactoryEdgeOperatorConfirmDialog";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { applicationEnglishTranslations } from "@/i18n/applicationTranslations";
import { parseEdgeOperatorStatus, type EdgeOperatorStatus } from "@/lib/offline/edgeOperatorStatus";

const REFRESH_MS = 15_000;

/**
 * Phase 10 read-only operator view on the factory LAN server: pending,
 * staged, applied and operator-rejected events per stream, relay pause state
 * and whether handover back to the cloud is safe. It renders nothing on the
 * cloud, for non-Admin/Owner users or when the report is unavailable. Pause
 * and resume need the user's password and a reason (plan batch 1); conflict
 * decisions are made on the cloud operator console (FactoryEdgeConflictsPanel).
 */
export function FactoryEdgeOperatorPanel() {
  const [status, setStatus] = useState<EdgeOperatorStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  const language = useOptionalApplicationLanguage();
  const t = language?.t ?? ((key: keyof typeof applicationEnglishTranslations) => applicationEnglishTranslations[key]);

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch("/api/edge/operator/status", {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) {
          if (active) setStatus(null);
          return;
        }
        const parsed = parseEdgeOperatorStatus(await res.json());
        if (active) setStatus(parsed);
      } catch {
        if (active && !controller?.signal.aborted) setStatus(null);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
      controller?.abort();
    };
  }, [reloadKey]);

  if (!status) return null;

  const action = status.relayPaused ? "resume" : "pause";
  const control = async ({ reason, password }: { reason: string; password: string }) => {
    setBusy(true);
    setError(null);
    try {
      await apiRequestPrivileged("POST", "/api/edge/operator/sync-control", { action, reason, password });
      setConfirming(false);
      reload();
    } catch (failure) {
      setError(operatorErrorCode(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      data-testid="factory-edge-operator-panel"
      aria-labelledby="factory-edge-operator-title"
      className="rounded-md border p-3 space-y-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="factory-edge-operator-title" className="text-sm font-semibold">
          {t("edge.operator.title")}
        </h3>
        <span
          role="status"
          data-testid="factory-edge-handover-state"
          className={
            status.handoverReady
              ? "rounded bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400"
              : "rounded bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
          }
        >
          {status.handoverReady ? t("edge.operator.handoverReady") : t("edge.operator.handoverBlocked")}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" data-testid="factory-edge-relay-state">
          {status.relayPaused ? t("edge.operator.relayPaused") : t("edge.operator.relayRunning")}
          {status.relayPaused && status.pausedBy ? ` · ${status.pausedBy}` : ""}
          {status.relayPaused && status.pausedReason ? ` · ${status.pausedReason}` : ""}
        </p>
        <Button size="sm" variant="outline" onClick={() => setConfirming(true)} data-testid="button-edge-relay-toggle">
          {status.relayPaused ? t("edge.operator.resume") : t("edge.operator.pause")}
        </Button>
      </div>
      <p className="text-xs">
        {t("edge.operator.pendingTotal")}:{" "}
        <strong data-testid="factory-edge-pending-total">{status.pendingTotal}</strong>
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="font-medium">{t("edge.operator.stream")}</th>
            <th className="font-medium">{t("edge.operator.pending")}</th>
            <th className="font-medium">{t("edge.operator.stagedNotApplied")}</th>
            <th className="font-medium">{t("edge.operator.applied")}</th>
            <th className="font-medium">{t("edge.operator.rejected")}</th>
          </tr>
        </thead>
        <tbody>
          {status.streams.map((stream) => (
            <tr key={stream.stream} data-testid={`factory-edge-stream-${stream.stream}`}>
              <td className="font-mono">{stream.stream}</td>
              {stream.installed ? (
                <>
                  <td>{stream.pending}</td>
                  <td>{stream.stagedNotApplied}</td>
                  <td>{stream.applied}</td>
                  <td>{stream.rejectedByOperator}</td>
                </>
              ) : (
                <td colSpan={4} className="text-muted-foreground">
                  {t("edge.operator.notInstalled")}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-muted-foreground">{t("edge.operator.changesViaTools")}</p>
      <FactoryEdgeOperatorConfirmDialog
        open={confirming}
        title={status.relayPaused ? t("edge.operator.resume") : t("edge.operator.pause")}
        description={t("edge.operator.changesViaTools")}
        pending={busy}
        error={error}
        onCancel={() => {
          setConfirming(false);
          setError(null);
        }}
        onConfirm={(input) => void control(input)}
      />
    </section>
  );
}
