import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiRequestPrivileged } from "@/lib/queryClient";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { applicationEnglishTranslations } from "@/i18n/applicationTranslations";
import { FactoryEdgeOperatorConfirmDialog, operatorErrorCode } from "@/components/FactoryEdgeOperatorConfirmDialog";

interface HeldRecord {
  stream: string;
  sequence: string;
  kind: string;
  code: string;
  detectedAt: string;
  canApprove: boolean;
}

function parseHeld(value: unknown): HeldRecord[] | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as { conflicts?: unknown }).conflicts)) return null;
  const rows: HeldRecord[] = [];
  for (const row of (value as { conflicts: unknown[] }).conflicts) {
    if (!row || typeof row !== "object") return null;
    const r = row as Record<string, unknown>;
    if (
      typeof r.stream !== "string" ||
      typeof r.sequence !== "string" ||
      typeof r.kind !== "string" ||
      typeof r.code !== "string" ||
      typeof r.detectedAt !== "string" ||
      typeof r.canApprove !== "boolean"
    ) {
      return null;
    }
    rows.push({
      stream: r.stream,
      sequence: r.sequence,
      kind: r.kind,
      code: r.code,
      detectedAt: r.detectedAt,
      canApprove: r.canApprove,
    });
  }
  return rows;
}

type Pending = { record: HeldRecord; decision: "approve-override" | "reject-event" };

/**
 * Phase 10 cloud operator console: offline records held by the cloud apply,
 * with Approve (only where the rules allow it) and Reject. Renders nothing on
 * an ordinary cloud instance, on the factory server, or for users who are not
 * Admin/Developer of the approved company (the endpoint answers 404/403).
 */
export function FactoryEdgeConflictsPanel() {
  const [held, setHeld] = useState<HeldRecord[] | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const language = useOptionalApplicationLanguage();
  const t = language?.t ?? ((key: keyof typeof applicationEnglishTranslations) => applicationEnglishTranslations[key]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/edge/operator/conflicts", { credentials: "include", cache: "no-store" });
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) {
        setHeld(null);
        return;
      }
      setHeld(parseHeld(await res.json()));
    } catch {
      setHeld(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!held) return null;

  const decide = async ({ reason, password }: { reason: string; password: string }) => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequestPrivileged("POST", "/api/edge/operator/conflicts/decide", {
        stream: pending.record.stream,
        sequence: pending.record.sequence,
        decision: pending.decision,
        reason,
        password,
      });
      setPending(null);
      await load();
    } catch (failure) {
      setError(operatorErrorCode(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      data-testid="factory-edge-conflicts-panel"
      aria-labelledby="factory-edge-conflicts-title"
      className="rounded-md border p-3 space-y-2"
    >
      <h3 id="factory-edge-conflicts-title" className="text-sm font-semibold">
        {t("edge.conflicts.title")}
      </h3>
      {held.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="text-edge-conflicts-empty">
          {t("edge.conflicts.empty")}
        </p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="font-medium">{t("edge.conflicts.stream")}</th>
              <th className="font-medium">{t("edge.conflicts.sequence")}</th>
              <th className="font-medium">{t("edge.conflicts.code")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {held.map((record) => (
              <tr
                key={`${record.stream}-${record.sequence}`}
                data-testid={`row-edge-conflict-${record.stream}-${record.sequence}`}
              >
                <td className="font-mono">{record.stream}</td>
                <td className="font-mono">{record.sequence}</td>
                <td className="font-mono">{record.code}</td>
                <td className="space-x-1 text-right">
                  {record.canApprove && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPending({ record, decision: "approve-override" })}
                      data-testid={`button-edge-approve-${record.stream}-${record.sequence}`}
                    >
                      {t("edge.conflicts.approve")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPending({ record, decision: "reject-event" })}
                    data-testid={`button-edge-reject-${record.stream}-${record.sequence}`}
                  >
                    {t("edge.conflicts.reject")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <FactoryEdgeOperatorConfirmDialog
        open={pending !== null}
        title={pending?.decision === "approve-override" ? t("edge.conflicts.approve") : t("edge.conflicts.reject")}
        description={
          pending?.decision === "approve-override" ? t("edge.conflicts.approveHelp") : t("edge.conflicts.rejectHelp")
        }
        pending={busy}
        error={error}
        onCancel={() => {
          setPending(null);
          setError(null);
        }}
        onConfirm={(input) => void decide(input)}
      />
    </section>
  );
}
