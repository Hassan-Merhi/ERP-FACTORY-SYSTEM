/**
 * Plan batch 5 (decision 10): a laptop that reaches neither the cloud nor the
 * factory server becomes a read-only viewer of the data prepared at the
 * user's last online sign-in (for at most 24 hours after it). It never takes
 * a write: every write is refused by the request layer
 * (client/src/lib/queryClient.ts) while the banner below is shown.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApplicationLanguageProvider, useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { applicationEnglishTranslations } from "@/i18n/applicationTranslations";
import { coldStartReadOnlyActive } from "@/lib/offline/coldStartState";
import { OFFLINE_MODE_ENABLED } from "@/lib/featureFlags";

type TranslationKey = keyof typeof applicationEnglishTranslations;

function useT() {
  const language = useOptionalApplicationLanguage();
  return language?.t ?? ((key: TranslationKey) => applicationEnglishTranslations[key]);
}

/** Is there a usable cold-start ticket on this laptop? Checked only while `enabled`. */
export function useColdStartTicketAvailable(enabled: boolean): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!enabled || !OFFLINE_MODE_ENABLED) {
      setAvailable(false);
      return;
    }
    let active = true;
    void import("@/lib/offline/offlineReadCache")
      .then(({ findColdStartTicket }) => findColdStartTicket())
      .then((ticket) => {
        if (active) setAvailable(ticket !== null);
      })
      .catch(() => {
        if (active) setAvailable(false);
      });
    return () => {
      active = false;
    };
  }, [enabled]);
  return available;
}

export function ColdStartUnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const t = useT();
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const { unlockColdStartReadOnly } = await import("@/lib/offline/offlineReadCache");
      const unlocked = await unlockColdStartReadOnly(passphrase);
      setPassphrase("");
      if (unlocked) onUnlocked();
      else setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4" data-testid="cold-start-unlock">
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold">{t("offline.coldStart.unlockTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("offline.coldStart.unlockBody")}</p>
        <label className="block space-y-1 text-sm font-medium">
          <span>{t("offline.coldStart.passphrase")}</span>
          <Input
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            data-testid="input-cold-start-passphrase"
          />
        </label>
        {failed && (
          <p role="alert" className="text-sm text-destructive" data-testid="text-cold-start-failed">
            {t("offline.coldStart.unlockFailed")}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={!passphrase || busy} data-testid="button-cold-start-unlock">
          {t("offline.coldStart.unlock")}
        </Button>
      </form>
    </main>
  );
}

/** The passphrase screen as the authenticated route shows it, in the user's language. */
export function ColdStartUnlockRoute({ onUnlocked }: { onUnlocked: () => void }) {
  return (
    <ApplicationLanguageProvider>
      <ColdStartUnlockScreen onUnlocked={onUnlocked} />
    </ApplicationLanguageProvider>
  );
}

/** Shown on every page while the tab is a read-only cold-start viewer. */
export function ColdStartReadOnlyBanner() {
  const t = useT();
  const [readOnly, setReadOnly] = useState(() => coldStartReadOnlyActive());
  const [until, setUntil] = useState<number | null>(null);
  useEffect(() => {
    if (!OFFLINE_MODE_ENABLED) return;
    const refresh = () => {
      setReadOnly(coldStartReadOnlyActive());
      void import("@/lib/offline/offlineReadCache").then(({ coldStartReadOnlyUntil }) =>
        setUntil(coldStartReadOnlyUntil())
      );
    };
    refresh();
    window.addEventListener("erp:offline-cold-start-changed", refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      window.removeEventListener("erp:offline-cold-start-changed", refresh);
      window.clearInterval(timer);
    };
  }, []);
  if (!readOnly) return null;
  return (
    <div
      role="status"
      className="sticky top-0 z-50 w-full bg-amber-500 px-4 py-2 text-center text-sm font-medium text-black"
      data-testid="banner-cold-start-read-only"
    >
      {t("offline.coldStart.banner")}
      {until !== null && (
        <span className="ml-2 font-normal">
          ({t("offline.coldStart.until")} {new Date(until).toLocaleString()})
        </span>
      )}
    </div>
  );
}
