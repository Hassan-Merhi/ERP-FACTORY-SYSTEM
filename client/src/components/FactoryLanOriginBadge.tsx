import { useEffect, useState } from "react";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { applicationEnglishTranslations } from "@/i18n/applicationTranslations";

interface EdgeStatus {
  mode: "lan" | "cloud";
  siteId: string | null;
  writeMode: "read-only" | "lan-primary" | "cloud";
  cloudReplication: string;
}

/**
 * Visible origin identity. Deliberately no cloud/LAN auto-switch:
 * switching an accounting write to a different database is never safe.
 */
export function FactoryLanOriginBadge() {
  const [status, setStatus] = useState<EdgeStatus | null>(null);
  const language = useOptionalApplicationLanguage();
  const t = language?.t ?? ((key: keyof typeof applicationEnglishTranslations) => applicationEnglishTranslations[key]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/edge/status", {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return;
        const body: unknown = await res.json();
        if (
          body && typeof body === "object" &&
          "mode" in body && body.mode === "lan" &&
          "siteId" in body && typeof body.siteId === "string" &&
          "writeMode" in body &&
          (body.writeMode === "read-only" || body.writeMode === "lan-primary")
        ) {
          setStatus(body as EdgeStatus);
        }
      })
      .catch(() => {
        // Before Phase 4, this badge is informational; never redirect to cloud.
      });
    return () => controller.abort();
  }, []);

  if (!status) return null;

  return (
    <div
      role="status"
      data-testid="factory-lan-origin-badge"
      className="pointer-events-none fixed bottom-3 right-3 z-50 max-w-[min(90vw,19rem)] rounded-md border border-amber-400/60 bg-background/95 px-3 py-2 text-xs text-foreground shadow-md"
    >
      <strong>{t("edge.lanServer")}</strong>
      <span className="ml-1">
        · {status.writeMode === "read-only" ? t("edge.readOnly") : t("edge.lanPrimary")}
      </span>
      <p className="text-muted-foreground">{t("edge.replicationNotConfigured")}</p>
      <p className="font-mono text-muted-foreground">{status.siteId.slice(0, 8)}</p>
    </div>
  );
}
