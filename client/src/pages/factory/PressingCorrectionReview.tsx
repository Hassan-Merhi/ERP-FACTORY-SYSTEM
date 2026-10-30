import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { History, RotateCcw, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { PRESSING_TIME_ZONE } from "@shared/pressingTimeZone";
import {
  fetchPressingReport, type PressingDetailRow, type PressingReportResponse,
} from "./pressing-scanner/pressingReportClient";

const ROOT = "/api/factory/pressing-machines";
type CorrectionEvent = {
  id: number;
  companyId: number;
  confirmationId: number;
  replacementConfirmationId: number | null;
  action: "VOID" | "RECONFIRM";
  reason: string;
  supervisorUserId: string;
  supervisorDisplayName?: string;
  createdAt: string;
};
function explanation(error: unknown): string {
  return error instanceof Error ? error.message : "Could not update pressing scan";
}
function dateTime(raw: string): string {
  return new Date(raw).toLocaleString("en-GB", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    timeZone: PRESSING_TIME_ZONE,
  });
}

/**
 * Supervisor-only interface. Server enforces company scope, role and
 * single active pressing confirmation per bale independently of this UI.
 */
export default function PressingCorrectionReview({
  companyId, userId, rows,
}: {
  companyId: number;
  userId: string;
  rows: PressingDetailRow[];
}) {
  const { toast } = useToast();
  const [filterRef, setFilterRef] = useState("");
  const [showAudit, setShowAudit] = useState(false);
  const [tab, setTab] = useState<"active" | "voided">("active");
  const correctionKey = [ROOT, "corrections", companyId, userId];
  // Voided bales remain directly returnable even when the main list is
  // filtered to active scans. Include them without requiring a status change.
  const active = useQuery<PressingReportResponse>({
    queryKey: [ROOT, "active", companyId, userId],
    queryFn: () => fetchPressingReport({
      mode: "detailed", status: "active", page: 1, limit: 100,
    }),
    staleTime: Infinity, refetchOnWindowFocus: false,
  });
  const voided = useQuery<PressingReportResponse>({
    queryKey: [ROOT, "voided", companyId, userId],
    queryFn: () => fetchPressingReport({
      mode: "detailed", status: "voided", page: 1, limit: 100,
    }),
    staleTime: Infinity, refetchOnWindowFocus: false,
  });
  const corrections = useQuery<CorrectionEvent[]>({
    queryKey: [...correctionKey, filterRef],
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
  const mutation = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: "void" | "restore" }) => {
      const response = await apiRequest("POST", ROOT + "/confirmations/" + id + "/" + action, {});
      if (!response.ok) throw new Error("Server did not accept pressing change");
      return { action, data: await response.json() as { confirmationId: number; referenceNumber: string } };
    },
    onSuccess: async ({ action }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [ROOT, "data", companyId, userId] }),
        queryClient.invalidateQueries({ queryKey: [ROOT, "voided", companyId, userId] }),
        queryClient.invalidateQueries({ queryKey: [ROOT, "active", companyId, userId] }),
        queryClient.invalidateQueries({ queryKey: [ROOT, "options", companyId, userId] }),
        queryClient.invalidateQueries({ queryKey: [ROOT, "analytics"] }),
        queryClient.invalidateQueries({ queryKey: correctionKey }),
      ]);
      toast({
        title: action === "void" ? "Scan deleted from totals" : "Bale returned",
        description: action === "void"
          ? "Removed from active bales and KG. Audit history is preserved."
          : "Original bale, KG, worker and scan time are back in active totals.",
      });
    },
    onError: error => {
      // A stale record may have been changed from another device.
      void queryClient.invalidateQueries({ queryKey: [ROOT, "data", companyId, userId] });
      void queryClient.invalidateQueries({ queryKey: [ROOT, "voided", companyId, userId] });
      void queryClient.invalidateQueries({ queryKey: [ROOT, "active", companyId, userId] });
      toast({ title: "Pressing change failed", description: explanation(error), variant: "destructive" });
    },
  });
  const archivedRows = (voided.data?.rows || []).filter(
    (row): row is PressingDetailRow => "id" in row,
  );
  const recentActiveRows = (active.data?.rows || []).filter(
    (row): row is PressingDetailRow => "id" in row,
  );
  const seen = new Set<number>();
  const currentRows = rows.filter(row => tab === "voided"
    ? !!row.voidedAt && row.canReturn !== false : !row.voidedAt);
  const recentRows = tab === "voided"
    ? archivedRows.filter(row => row.canReturn !== false) : recentActiveRows;
  const visibleRows = [...currentRows, ...recentRows].filter(row => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });

  return (
    <Card data-testid="pressing-correction-review" className="mt-4">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-5 w-5" />Manage Pressing Scans
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Click X to remove a scan, or open Voided and click Return to bring it back.
          No explanation or rescanning required. Original history stays in the audit.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2" aria-label="Pressing scan status">
          <Button type="button" size="sm" variant={tab === "active" ? "secondary" : "outline"}
            aria-pressed={tab === "active"} onClick={() => setTab("active")}>Active scans</Button>
          <Button type="button" size="sm" variant={tab === "voided" ? "secondary" : "outline"}
            aria-pressed={tab === "voided"} onClick={() => setTab("voided")}>Voided bales</Button>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[540px] text-sm">
            <thead className="bg-muted text-left"><tr>
              <th className="p-2">Reference</th><th className="p-2">Record</th>
              <th className="p-2">Machine</th><th className="p-2">Server time (Beirut)</th>
              <th className="p-2">Action</th>
            </tr></thead>
            <tbody>
              {visibleRows.map(r => (
                <tr key={r.id} className="border-t">
                  <td className="p-2">{r.referenceNumber}</td>
                  <td className="p-2">#{r.id}</td>
                  <td className="p-2">{r.machineName}</td>
                  <td className="p-2">{dateTime(r.confirmedAt)}</td>
                  <td className="p-2">
                    {r.voidedAt ? (
                      <Button size="sm" variant="outline" disabled={mutation.isPending}
                        aria-label={"Return voided bale " + r.referenceNumber}
                        onClick={() => mutation.mutate({ id: r.id, action: "restore" })}>
                        <RotateCcw className="mr-1 h-4 w-4" />Return
                      </Button>
                    ) : (
                      <Button type="button" size="icon" variant="ghost"
                        className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        disabled={mutation.isPending} title={"Delete scan " + r.referenceNumber}
                        aria-label={"Delete pressing scan " + r.referenceNumber}
                        onClick={() => mutation.mutate({ id: r.id, action: "void" })}>
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {visibleRows.length === 0 && <tr><td className="p-3 text-center text-muted-foreground" colSpan={5}>
                No pressing scans to manage.
              </td></tr>}
            </tbody>
          </table>
        </div>
        {(active.isLoading || voided.isLoading) && <p className="text-xs text-muted-foreground">Loading recent bales…</p>}
        {(active.isError || voided.isError) && <p role="alert" className="text-xs text-destructive">
          Some pressing scans could not load. Try Refresh or use the Detailed status filter.
        </p>}
        <p className="text-xs text-muted-foreground">
          Showing up to 100 recent scans for the selected status, plus matching detailed records.
          X removes a scan from pressing results only; it does not delete inventory or accounting records.
        </p>
        <div className="flex flex-wrap gap-2 items-center">
          <Button size="sm" variant="outline" onClick={() => setShowAudit(x => !x)}>
            <History className="mr-2 h-4 w-4" />{showAudit ? "Hide" : "Show"} audit
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
                <p><strong>{entry.action === "VOID" ? "Deleted from totals" : "Returned / re-scanned"}</strong>
                  {" · Original #" + entry.confirmationId}
                  {entry.replacementConfirmationId && " → Replacement #" + entry.replacementConfirmationId}</p>
                <p className="text-xs text-muted-foreground">{dateTime(entry.createdAt)}
                  {" · Supervisor " + (entry.supervisorDisplayName?.trim() || "Display name not set")}</p>
                <p className="text-sm">{entry.reason}</p>
              </div>
            ))}
            {corrections.data?.length === 0 &&
              <p className="text-sm text-muted-foreground">No correction records match this filter.</p>}
            <p className="text-xs text-muted-foreground">
              Latest 100 permanent audit events. Returned scans preserve their original worker and time.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
