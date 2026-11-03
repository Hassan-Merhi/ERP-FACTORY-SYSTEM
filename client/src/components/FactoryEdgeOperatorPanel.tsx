import { useEffect, useState } from "react";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { applicationEnglishTranslations } from "@/i18n/applicationTranslations";
import { parseEdgeOperatorStatus, type EdgeOperatorStatus } from "@/lib/offline/edgeOperatorStatus";

const REFRESH_MS = 15_000;

/**
 * Phase 10 read-only operator view on the factory LAN server: pending,
 * staged, applied and operator-rejected events per stream, relay pause state
 * and whether handover back to the cloud is safe. It renders nothing on the
 * cloud, for non-Admin/Owner users or when the report is unavailable. Pause,
 * resume and conflict decisions stay with the audited CLI/DBA tools.
 */
export function FactoryEdgeOperatorPanel() {
  const [status, setStatus] = useState<EdgeOperatorStatus | null>(null);
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
  }, []);

  if (!status) return null;

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
      <p className="text-xs text-muted-foreground" data-testid="factory-edge-relay-state">
        {status.relayPaused ? t("edge.operator.relayPaused") : t("edge.operator.relayRunning")}
        {status.relayPaused && status.pausedBy ? ` · ${status.pausedBy}` : ""}
        {status.relayPaused && status.pausedReason ? ` · ${status.pausedReason}` : ""}
      </p>
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
    </section>
  );
}
