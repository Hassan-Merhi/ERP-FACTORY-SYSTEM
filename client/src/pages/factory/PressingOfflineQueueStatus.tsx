import { CloudOff, Cloud, RefreshCw, CheckCircle2, AlertTriangle, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PressingQueueSnapshot } from "./pressing-scanner/usePressingOfflineSync";
import type { PressingQueuedScan } from "./pressing-scanner/pressingOfflineQueue";

function timeLabel(row: PressingQueuedScan): string {
  const recorded = row.receipt?.confirmedAt || row.payload.deviceCapturedAt;
  try {
    return new Date(recorded).toLocaleString(undefined, {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  } catch {
    return recorded;
  }
}
function stateLabel(row: PressingQueuedScan): string {
  switch (row.state) {
    case "confirmed": return "Server confirmed";
    case "rejected": return "Rejected";
    case "syncing": return "Sending";
    default: return "Saved locally — pending";
  }
}

export default function PressingOfflineQueueStatus({
  snapshot, retryNow,
}: {
  snapshot: PressingQueueSnapshot;
  retryNow: () => Promise<void>;
}) {
  const outstanding = snapshot.pending + snapshot.syncing;
  return (
    <Card data-testid="pressing-offline-queue" className="min-w-0">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {snapshot.online ? <Cloud className="h-5 w-5" /> : <CloudOff className="h-5 w-5" />}
            Pressing Scan Sync
          </CardTitle>
          <Badge variant={snapshot.online ? "secondary" : "outline"}>
            {snapshot.online ? "Internet detected" : "Offline"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Pressing scan sync totals">
          <div className="rounded-md border p-2 text-center">
            <p className="font-semibold text-amber-700 dark:text-amber-300">{snapshot.pending}</p>
            <p className="text-xs text-muted-foreground">Pending</p>
          </div>
          <div className="rounded-md border p-2 text-center">
            <p className="font-semibold">{snapshot.syncing}</p>
            <p className="text-xs text-muted-foreground">Sending</p>
          </div>
          <div className="rounded-md border p-2 text-center">
            <p className="font-semibold text-emerald-700 dark:text-emerald-300">{snapshot.confirmed}</p>
            <p className="text-xs text-muted-foreground">Receipts saved</p>
          </div>
          <div className="rounded-md border p-2 text-center">
            <p className="font-semibold text-red-700 dark:text-red-300">{snapshot.rejected}</p>
            <p className="text-xs text-muted-foreground">Rejected</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Pending scans are not counted. This device displays original server receipts; supervisors may subsequently void them. Current totals are in Permanent Pressing History.
          </p>
          <Button type="button" size="sm" variant="outline"
            disabled={!snapshot.online || outstanding === 0}
            onClick={() => void retryNow()}>
            <RefreshCw className="mr-2 h-4 w-4" />Retry pending
          </Button>
        </div>
        {snapshot.error && (
          <p role="alert" className="rounded-md border border-amber-400/60 bg-amber-500/10 p-2 text-sm">
            <AlertTriangle className="mr-1 inline h-4 w-4" />{snapshot.error}
          </p>
        )}
        {outstanding > 0 && (
          <p role="status" className="rounded-md bg-amber-500/10 p-2 text-sm">
            {outstanding} scan{outstanding === 1 ? "" : "s"} saved on this device and awaiting server verification.
            Keep this device's browser data until synchronization finishes.
          </p>
        )}
        {snapshot.items.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium">Recent scans on this device</p>
            <div className="max-h-64 space-y-2 overflow-y-auto" aria-label="Recent pressing scan statuses">
              {snapshot.items.slice(0, 12).map(row => (
                <div key={row.requestId} className="rounded-md border p-2 text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    <strong className="break-all">{row.barcode}</strong>
                    <span className={
                      row.state === "confirmed" ? "text-emerald-700 dark:text-emerald-300" :
                      row.state === "rejected" ? "text-red-700 dark:text-red-300" :
                      "text-amber-700 dark:text-amber-300"
                    }>
                      {row.state === "confirmed" ? <CheckCircle2 className="mr-1 inline h-4 w-4" /> :
                        row.state === "rejected" ? <AlertTriangle className="mr-1 inline h-4 w-4" /> :
                        <Clock className="mr-1 inline h-4 w-4" />}
                      {stateLabel(row)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {timeLabel(row)} · Machine #{row.payload.machineId}
                    {row.receipt ? " · " + row.receipt.weightKg + " KG" : ""}
                  </p>
                  {row.lastError && <p className="text-xs text-muted-foreground">{row.lastError}</p>}
                  {row.receipt && (
                    <p className="text-xs">Server record #{row.receipt.id} — counted once</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Scans are stored on this device until synchronized. Clearing browser storage or
          using private browsing can erase unsynced scans. Permanent server history and
          date filters are in Permanent Pressing History below.
        </p>
      </CardContent>
    </Card>
  );
}
