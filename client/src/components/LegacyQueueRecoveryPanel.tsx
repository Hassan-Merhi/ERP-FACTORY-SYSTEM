/**
 * Plan batch 5 (owner-approved 2026-11-05): entries left in the old browser
 * queues, listed at sign-in for Admin / Owner / Developer users. Nothing is
 * ever sent automatically. Each entry is re-entered by the user through the
 * normal form (so it goes through the server's checks) or discarded. Each
 * choice is recorded in the server audit log with the user's name.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCompany } from "@/contexts/CompanyContext";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { applicationEnglishTranslations } from "@/i18n/applicationTranslations";
import { OFFLINE_MODE_ENABLED } from "@/lib/featureFlags";
import { apiRequest } from "@/lib/queryClient";
import type { LegacyRecoveryEntry } from "@/lib/db";

type TranslationKey = keyof typeof applicationEnglishTranslations;

export function LegacyQueueRecoveryPanel() {
  const language = useOptionalApplicationLanguage();
  const t = language?.t ?? ((key: TranslationKey) => applicationEnglishTranslations[key]);
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id ?? null;
  const allowed = OFFLINE_MODE_ENABLED && ["Admin", "Owner", "Developer"].includes(String(selectedCompany?.role ?? ""));
  const [entries, setEntries] = useState<LegacyRecoveryEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<{ id: string; text: string } | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    if (!allowed || companyId === null) return;
    const recovery = await import("@/lib/offline/legacyQueueRecovery");
    await recovery.migrateLegacyQueues();
    await recovery.purgeExpiredLegacyEntries();
    const listed = await recovery.listLegacyRecoveryEntries(companyId);
    setEntries(listed);
    if (listed.length) setOpen(true);
  }, [allowed, companyId]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  if (!allowed || entries.length === 0) return null;

  const decide = async (entry: LegacyRecoveryEntry, decision: "discarded" | "re-entered") => {
    setFailed(false);
    try {
      const recovery = await import("@/lib/offline/legacyQueueRecovery");
      await recovery.decideLegacyRecoveryEntry(entry, decision, (body) =>
        apiRequest("POST", "/api/offline/legacy-queue/decisions", body)
      );
      setDetails(null);
      await refresh();
    } catch {
      setFailed(true);
    }
  };

  const showDetails = async (entry: LegacyRecoveryEntry) => {
    const recovery = await import("@/lib/offline/legacyQueueRecovery");
    const opened = await recovery.openLegacyRecoveryEntry(entry);
    setDetails({ id: entry.id, text: JSON.stringify(opened.body, null, 2) });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl" data-testid="dialog-legacy-queue">
        <DialogHeader>
          <DialogTitle>{t("offline.legacy.title")}</DialogTitle>
          <DialogDescription>{t("offline.legacy.body")}</DialogDescription>
        </DialogHeader>
        {failed && (
          <p role="alert" className="text-sm text-destructive" data-testid="text-legacy-queue-failed">
            {t("offline.legacy.notRecorded")}
          </p>
        )}
        <ul className="max-h-[60vh] space-y-3 overflow-y-auto">
          {entries.map((entry) => (
            <li key={entry.id} className="rounded-md border p-3" data-testid={`row-legacy-entry-${entry.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>{new Date(entry.recordedAt).toLocaleString()}</span>
                <span className="font-medium">{entry.kind}</span>
                <span>{entry.amount ?? "—"}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => void showDetails(entry)}>
                  {t("offline.legacy.reenter")}
                </Button>
                <Button size="sm" variant="destructive" onClick={() => void decide(entry, "discarded")}>
                  {t("offline.legacy.discard")}
                </Button>
              </div>
              {details?.id === entry.id && (
                <div className="mt-2 space-y-2">
                  <p className="text-xs text-muted-foreground">{t("offline.legacy.reenterHelp")}</p>
                  <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs">{details.text}</pre>
                  <Button size="sm" onClick={() => void decide(entry, "re-entered")}>
                    {t("offline.legacy.markReentered")}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
