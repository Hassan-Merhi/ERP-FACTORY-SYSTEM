import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, History, ShieldCheck, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { PressingDetailRow } from "./pressing-scanner/pressingReportClient";

const ROOT = "/api/factory/pressing-machines";
type CorrectionEvent = {
  id: number;
  companyId: number;
  confirmationId: number;
  replacementConfirmationId: number | null;
  action: "VOID" | "RECONFIRM";
  reason: string;
  supervisorUserId: string;
  createdAt: string;
};
function explanation(error: unknown): string {
  return error instanceof Error ? error.message : "Could not save correction";
}
function dateTime(raw: string): string {
  return new Date(raw).toLocaleString("en-GB", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

/**
 * Supervisor-only interface. API independently checks supervisor role and
 * current company, so removing the UI button is NOT the authorization rule.
 */
export default function PressingCorrectionReview({
  companyId, userId, rows,
}: {
  companyId: number;
  userId: string;
  rows: PressingDetailRow[];
}) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<PressingDetailRow | null>(null);
  const [reason, setReason] = useState("");
  const [confirmationText, setConfirmationText] = useState("");
  const [filterRef, setFilterRef] = useState("");
  const [showAudit, setShowAudit] = useState(false);
  const queryKey = [ROOT, "corrections", companyId, userId, filterRef];
  const corrections = useQuery<CorrectionEvent[]>({
    queryKey,
    enabled: showAudit,
    queryFn: async () => {
      const p = new URLSearchParams({ limit: "100" });
      if (filterRef.trim()) p.set("reference", filterRef.trim().toUpperCase());
      const response = await fetch(ROOT + "/corrections?" + p.toString(), {
        credentials: "include", cache: "no-store",
      });
      if (!response.ok) throw new Error("Unable to retrieve pressing correction audit history");
      return response.json();
    },
    staleTime: 0, refetchOnWindowFocus: false,
  });
  const voidMutation = useMutation({
    mutationFn: async ({ id, explanation }: { id: number; explanation: string }) => {
      const response = await apiRequest("POST", ROOT + "/confirmations/" + id + "/void", {
        reason: explanation,
      });
      if (!response.ok) throw new Error("Server did not accept correction");
      return response.json() as Promise<{ correctionId: number; confirmationId: number }>;
    },
    onSuccess: async result => {
      setSelected(null);
      setReason("");
      setConfirmationText("");
      // A void immediately removes its bale and KG from active totals.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [ROOT + "/report"] }),
        queryClient.invalidateQueries({ queryKey: [ROOT, "analytics"] }),
        queryClient.invalidateQueries({ queryKey: [ROOT, "corrections", companyId, userId] }),
      ]);
      toast({
        title: "Pressing correction recorded",
        description: "Record #" + result.confirmationId +
          " voided. Its original scan and reason remain in permanent audit history.",
      });
    },
    onError: error => toast({
      title: "Correction was not accepted", description: explanation(error), variant: "destructive",
    }),
  });
  const ready = selected &&
    reason.trim().length >= 10 &&
    reason.trim().length <= 1000 &&
    confirmationText.trim().toUpperCase() === selected.referenceNumber.toUpperCase();

  return (
    <Card data-testid="pressing-correction-review" className="mt-4">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-5 w-5" />Supervisor Corrections & Audit
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Void a mistaken physical pressing confirmation with a mandatory reason.
          Original machine, operator, time and KG remain in immutable history.
          Only a new valid scan can restore active pressing status.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[540px] text-sm">
            <thead className="bg-muted text-left"><tr>
              <th className="p-2">Reference</th><th className="p-2">Record</th>
              <th className="p-2">Machine</th><th className="p-2">Server time</th>
              <th className="p-2">Action</th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-t">
                  <td className="p-2">{r.referenceNumber}</td>
                  <td className="p-2">#{r.id}</td>
                  <td className="p-2">{r.machineName}</td>
                  <td className="p-2">{dateTime(r.confirmedAt)}</td>
                  <td className="p-2">
                    {r.voidedAt ?
                      <span className="text-muted-foreground">Voided — preserved</span> :
                      <Button size="sm" variant="outline" disabled={voidMutation.isPending}
                        onClick={() => {
                          setSelected(r); setReason(""); setConfirmationText("");
                        }}>
                        <Undo2 className="mr-1 h-4 w-4" />Review void
                      </Button>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td className="p-3 text-center text-muted-foreground" colSpan={5}>
                Select Detailed mode to review pressing confirmations on this page.
              </td></tr>}
            </tbody>
          </table>
        </div>
        {selected && (
          <div role="region" aria-label="Confirm pressing correction" className="rounded-lg border border-amber-400/70 p-3 space-y-3">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <AlertTriangle className="h-4 w-4 text-amber-600" />Correct confirmation #{selected.id}
            </p>
            <p className="text-sm">
              {selected.referenceNumber} · {selected.machineName} · {Number(selected.weightKg)} KG
              · {dateTime(selected.confirmedAt)}
            </p>
            <p className="text-xs text-muted-foreground">
              This subtracts this confirmation from active pressing analytics.
              It does NOT undo stock finalization, inventory movements or vouchers.
              An eligible bale may subsequently be scanned again.
            </p>
            <label className="block space-y-1 text-sm">
              <span>Mandatory explanation (at least 10 characters)</span>
              <textarea className="min-h-[90px] w-full rounded-md border bg-background p-2 text-sm"
                maxLength={1000} value={reason} onChange={event => setReason(event.target.value)}
                placeholder="Explain why this pressing confirmation is incorrect" />
            </label>
            <label className="block space-y-1 text-sm">
              <span>Type <strong>{selected.referenceNumber}</strong> to confirm</span>
              <Input value={confirmationText} autoComplete="off" maxLength={100}
                onChange={event => setConfirmationText(event.target.value)}
                placeholder="Re-enter bale reference" />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button variant="destructive" size="sm"
                disabled={!ready || voidMutation.isPending}
                onClick={() => voidMutation.mutate({ id: selected.id, explanation: reason.trim() })}>
                Void pressing confirmation
              </Button>
              <Button size="sm" variant="outline" disabled={voidMutation.isPending}
                onClick={() => { setSelected(null); setReason(""); setConfirmationText(""); }}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2 items-center">
          <Button size="sm" variant="outline" onClick={() => setShowAudit(x => !x)}>
            <History className="mr-2 h-4 w-4" />{showAudit ? "Hide" : "Show"} correction audit
          </Button>
          {showAudit && <Input className="max-w-[250px]" value={filterRef}
            placeholder="Filter by bale reference"
            onChange={e => setFilterRef(e.target.value)} />}
        </div>
        {showAudit && (
          <div className="space-y-2">
            {corrections.isLoading && <p className="text-sm">Loading audit events…</p>}
            {corrections.isError && <p role="alert" className="text-sm text-destructive">
              {explanation(corrections.error)}
            </p>}
            {corrections.data?.map(entry => (
              <div key={entry.id} className="rounded-md border p-2 text-sm">
                <p><strong>{entry.action}</strong> · Original #{entry.confirmationId}
                  {entry.replacementConfirmationId && " → Replacement #" + entry.replacementConfirmationId}</p>
                <p className="text-xs text-muted-foreground">{dateTime(entry.createdAt)}
                  {" · Supervisor " + entry.supervisorUserId}</p>
                <p className="text-sm">{entry.reason}</p>
              </div>
            ))}
            {corrections.data?.length === 0 &&
              <p className="text-sm text-muted-foreground">No correction records match this filter.</p>}
            <p className="text-xs text-muted-foreground">
              Showing the latest 100 immutable correction events.
              Original voids and later replacements are linked in the audit trail.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
