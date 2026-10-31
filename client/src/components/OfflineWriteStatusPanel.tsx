import { useEffect, useState } from "react";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { applicationEnglishTranslations } from "@/i18n/applicationTranslations";
import { getVerifiedOfflineReadScope } from "@/lib/offline/offlineReadCache";
import { listOfflineOperations } from "@/lib/offline/durableOutbox";
import { PHASE9_STATE_LABELS, visiblePhase9Status, type Phase9VisibleState } from "@/lib/offline/phase9Status";

interface StatusRow {
  id: string;
  clientDate: string;
  status: Phase9VisibleState;
}

/**
 * Reports only this verified user/company's durable voucher requests.
 * An unverified/missing LAN receipt stays "local only" even after a 2xx.
 * This component does not initiate replay, change server authority, or
 * treat the legacy queue as migrated.
 */
export function OfflineWriteStatusPanel() {
  const [rows, setRows] = useState<StatusRow[]>([]);
  const [available, setAvailable] = useState(false);
  const language = useOptionalApplicationLanguage();
  const t = language?.t ?? ((key: keyof typeof applicationEnglishTranslations) => applicationEnglishTranslations[key]);

  useEffect(() => {
    let active = true;
    let revision = 0;
    const load = async () => {
      const currentRevision = ++revision;
      const actor = getVerifiedOfflineReadScope();
      if (!actor) {
        if (active) {
          setRows([]);
          setAvailable(false);
        }
        return;
      }
      try {
        const operations = (await listOfflineOperations(actor)).slice(-10);
        const resolved = await Promise.all(
          operations.map(async (operation) => {
            let proof: unknown;
            if (operation.state === "acknowledged") {
              try {
                const response = await fetch("/api/edge/status?operationId=" + encodeURIComponent(operation.id), {
                  credentials: "include",
                  cache: "no-store",
                  redirect: "error",
                });
                if (response.ok && (response.headers.get("content-type") ?? "").includes("application/json")) {
                  proof = await response.json();
                }
              } catch {
                // No LAN/cloud evidence: never upgrade an acknowledgement.
              }
            }
            return {
              id: operation.id,
              clientDate: operation.clientDate,
              status: visiblePhase9Status(operation, proof),
            };
          })
        );
        if (active && revision === currentRevision) {
          setRows(resolved);
          setAvailable(true);
        }
      } catch {
        if (active && revision === currentRevision) {
          setRows([]);
          setAvailable(false);
        }
      }
    };
    void load();
    window.addEventListener("erp:sync", load);
    window.addEventListener("erp:offline-read-scope-verified", load);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      window.removeEventListener("erp:sync", load);
      window.removeEventListener("erp:offline-read-scope-verified", load);
      window.removeEventListener("focus", load);
    };
  }, []);

  if (!available) return null;
  return (
    <section aria-label={t("offlineDelivery.panelLabel")} className="rounded-md border p-3 space-y-2">
      <h4 className="text-sm font-semibold">{t("offlineDelivery.panelTitle")}</h4>
      <p className="text-xs text-muted-foreground">{t("offlineDelivery.panelDetail")}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("offlineDelivery.noRequests")}</p>
      ) : (
        <ul className="space-y-1 text-xs" data-testid="offline-write-delivery-status">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap justify-between gap-2">
              <span className="font-mono">
                {row.id.slice(0, 8)} · {row.clientDate}
              </span>
              <span aria-label={row.status}>{PHASE9_STATE_LABELS[row.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
