/**
 * Full offline mode (Phase B2): the negative-stock flags an Admin or Developer
 * reviews. When a PC's offline entry took stock below zero, the cloud applied
 * it anyway (owner decision) and recorded a flag; here they are listed and
 * closed with a note. Flags may stay open at month end.
 *
 * Shows nothing when PC sync is off on this server (404) or the signed-in
 * person is not an Admin or Developer of the active company (403).
 */
import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { applicationEnglishTranslations, type ApplicationTranslationKey } from "@/i18n/applicationTranslations";
import { apiRequest } from "@/lib/queryClient";

export interface NegativeStockFlag {
  id: number;
  kind: string;
  conflictCode: string;
  cloudRef: number | null;
  createdBy: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

const FLAGS_URL = "/api/offline/pc-sync/negative-stock-flags";

type FlagsResult = { state: "ready"; flags: NegativeStockFlag[] } | { state: "hidden" };

async function loadFlags(status: "open" | "all"): Promise<FlagsResult> {
  try {
    const res = await apiRequest("GET", `${FLAGS_URL}?status=${status}`);
    const body = (await res.json()) as { flags?: NegativeStockFlag[] };
    return { state: "ready", flags: Array.isArray(body.flags) ? body.flags : [] };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 403 || status === 404) return { state: "hidden" };
    throw error;
  }
}

function FlagRow({
  flag,
  t,
  onResolved,
}: {
  flag: NegativeStockFlag;
  t: (key: ApplicationTranslationKey) => string;
  onResolved: () => void;
}) {
  const [note, setNote] = useState("");
  const resolve = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `${FLAGS_URL}/${flag.id}/resolve`, { note: note.trim() });
    },
    onSuccess: onResolved,
  });
  const created = new Date(flag.createdAt).toLocaleString();
  return (
    <li className="rounded-md border p-3 space-y-2" data-testid={`negative-stock-flag-${flag.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={flag.resolvedAt ? "secondary" : "destructive"}>
          {flag.resolvedAt ? t("negativeStockFlags.closed") : t("negativeStockFlags.open")}
        </Badge>
        <span className="font-medium">{flag.kind}</span>
        <span className="text-muted-foreground">{created}</span>
        {flag.cloudRef != null && (
          <span className="text-muted-foreground">
            {t("negativeStockFlags.record")} #{flag.cloudRef}
          </span>
        )}
      </div>
      {flag.resolvedAt ? (
        <p className="text-sm text-muted-foreground">
          {t("negativeStockFlags.closedNote")} {flag.resolutionNote}
        </p>
      ) : (
        <div className="space-y-2">
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("negativeStockFlags.notePlaceholder")}
            aria-label={t("negativeStockFlags.notePlaceholder")}
            maxLength={1000}
            data-testid={`negative-stock-flag-note-${flag.id}`}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => resolve.mutate()}
              disabled={!note.trim() || resolve.isPending}
              data-testid={`negative-stock-flag-close-${flag.id}`}
            >
              <CheckCircle className="mr-1 h-4 w-4" />
              {t("negativeStockFlags.close")}
            </Button>
            {resolve.isError && (
              <span className="text-sm text-destructive" role="alert">
                {t("negativeStockFlags.closeFailed")}
              </span>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export function NegativeStockFlagsCard() {
  const language = useOptionalApplicationLanguage();
  const t = useCallback(
    (key: ApplicationTranslationKey) => (language?.t ? language.t(key) : applicationEnglishTranslations[key]),
    [language]
  );
  const [showAll, setShowAll] = useState(false);
  const queryClient = useQueryClient();
  const status = showAll ? "all" : "open";
  const flags = useQuery({ queryKey: [FLAGS_URL, status], queryFn: () => loadFlags(status) });

  if (flags.isLoading || (flags.data && flags.data.state === "hidden")) return null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: [FLAGS_URL] });
  const list = flags.data?.state === "ready" ? flags.data.flags : [];

  return (
    <Card data-testid="negative-stock-flags">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          {t("negativeStockFlags.title")}
        </CardTitle>
        <CardDescription>{t("negativeStockFlags.intro")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button variant="outline" size="sm" onClick={() => setShowAll((value) => !value)}>
          {showAll ? t("negativeStockFlags.showOpen") : t("negativeStockFlags.showAll")}
        </Button>
        {flags.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {t("negativeStockFlags.loadFailed")}
          </p>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("negativeStockFlags.none")}</p>
        ) : (
          <ul className="space-y-2">
            {list.map((flag) => (
              <FlagRow key={flag.id} flag={flag} t={t} onResolved={refresh} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
